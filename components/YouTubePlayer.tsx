'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Script from 'next/script'

declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string,
        config: {
          width?: string | number
          height?: string | number
          videoId: string
          playerVars?: Record<string, string | number>
          events?: {
            onReady?: (event: { target: YTPlayer }) => void
            onStateChange?: (event: { data: number; target: YTPlayer }) => void
            onError?: (event: { data: number }) => void
          }
        }
      ) => YTPlayer
      PlayerState: {
        UNSTARTED: number
        ENDED: number
        PLAYING: number
        PAUSED: number
        BUFFERING: number
        CUED: number
      }
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

type YTPlayer = {
  destroy: () => void
  loadVideoById: (videoId: string) => void
  playVideo: () => void
  mute: () => void
  unMute: () => void
  stopVideo: () => void
  getPlayerState: () => number
  setVolume: (volume: number) => void
  getVolume: () => number
  isMuted: () => boolean
}

type Props = {
  videoId: string
  title?: string
  onEnded: () => void
  onError?: (code: number) => void
  /**
   * Cuando cambia a un valor truthy (ej. id de cola), baja el volumen
   * gradualmente y luego dispara onEnded (salto suave por votos).
   */
  fadeOutKey?: string | number | null
  /** Duración del fade en ms (default ~3.2s) */
  fadeOutMs?: number
}

function loadYouTubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.YT?.Player) return Promise.resolve()

  return new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve()
    }

    const timer = window.setInterval(() => {
      if (window.YT?.Player) {
        window.clearInterval(timer)
        resolve()
      }
    }, 50)
  })
}

export default function YouTubePlayer({
  videoId,
  title,
  onEnded,
  onError,
  fadeOutKey = null,
  fadeOutMs = 3200,
}: Props) {
  const reactId = useId().replace(/:/g, '')
  const containerId = `yt-player-${reactId}`
  const playerRef = useRef<YTPlayer | null>(null)
  const onEndedRef = useRef(onEnded)
  const onErrorRef = useRef(onError)
  const [needsClick, setNeedsClick] = useState(false)
  const [fading, setFading] = useState(false)
  const fadingRef = useRef(false)
  const fadeTimerRef = useRef<number | null>(null)
  const lastFadeKeyRef = useRef<string | number | null>(null)
  const endedOnceRef = useRef(false)

  onEndedRef.current = onEnded
  onErrorRef.current = onError

  function clearFadeTimer() {
    if (fadeTimerRef.current != null) {
      window.clearInterval(fadeTimerRef.current)
      fadeTimerRef.current = null
    }
  }

  function fireEnded() {
    if (endedOnceRef.current) return
    endedOnceRef.current = true
    onEndedRef.current()
  }

  /** Baja volumen en pasos y al final llama onEnded */
  function startFadeOut(ms: number) {
    const player = playerRef.current
    if (!player || fadingRef.current) return
    fadingRef.current = true
    setFading(true)
    clearFadeTimer()

    try {
      if (player.isMuted()) {
        player.unMute()
      }
    } catch {
      /* ignore */
    }

    let startVol = 100
    try {
      startVol = player.getVolume()
      if (typeof startVol !== 'number' || Number.isNaN(startVol)) startVol = 100
    } catch {
      startVol = 100
    }

    const steps = 24
    const stepMs = Math.max(40, Math.floor(ms / steps))
    let step = 0

    fadeTimerRef.current = window.setInterval(() => {
      step++
      const next = Math.max(0, Math.round(startVol * (1 - step / steps)))
      try {
        player.setVolume(next)
      } catch {
        /* ignore */
      }
      if (step >= steps) {
        clearFadeTimer()
        try {
          player.setVolume(0)
          player.stopVideo()
        } catch {
          /* ignore */
        }
        fireEnded()
      }
    }, stepMs)
  }

  useEffect(() => {
    let cancelled = false
    let kickTimer: number | undefined
    endedOnceRef.current = false
    fadingRef.current = false
    setFading(false)
    lastFadeKeyRef.current = null
    clearFadeTimer()

    async function mountPlayer() {
      await loadYouTubeApi()
      if (cancelled || !window.YT?.Player) return

      if (playerRef.current) {
        try {
          playerRef.current.destroy()
        } catch {
          /* ignore */
        }
        playerRef.current = null
      }

      setNeedsClick(false)

      playerRef.current = new window.YT.Player(containerId, {
        width: '100%',
        height: '100%',
        videoId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          mute: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            try {
              event.target.mute()
              event.target.setVolume(100)
              event.target.playVideo()
            } catch {
              setNeedsClick(true)
            }

            kickTimer = window.setTimeout(() => {
              try {
                const state = event.target.getPlayerState()
                if (state === -1 || state === 2 || state === 5) {
                  setNeedsClick(true)
                }
              } catch {
                setNeedsClick(true)
              }
            }, 2000)
          },
          onStateChange: (event) => {
            if (event.data === 1) {
              setNeedsClick(false)
              if (!fadingRef.current) {
                try {
                  event.target.unMute()
                  event.target.setVolume(100)
                } catch {
                  /* ignore */
                }
              }
            }
            // ENDED natural
            if (event.data === 0 && !fadingRef.current) {
              fireEnded()
            }
          },
          onError: (event) => {
            onErrorRef.current?.(event.data)
          },
        },
      })
    }

    void mountPlayer()

    return () => {
      cancelled = true
      if (kickTimer) window.clearTimeout(kickTimer)
      clearFadeTimer()
      if (playerRef.current) {
        try {
          playerRef.current.destroy()
        } catch {
          /* ignore */
        }
        playerRef.current = null
      }
    }
  }, [containerId, videoId])

  // Fade out por votos (salto suave)
  useEffect(() => {
    if (fadeOutKey == null || fadeOutKey === '') return
    if (lastFadeKeyRef.current === fadeOutKey) return
    lastFadeKeyRef.current = fadeOutKey
    startFadeOut(fadeOutMs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeOutKey, fadeOutMs])

  function handleManualStart() {
    const player = playerRef.current
    if (!player) return
    try {
      player.unMute()
      player.setVolume(100)
      player.playVideo()
      setNeedsClick(false)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="relative h-full w-full bg-black">
      <Script
        src="https://www.youtube.com/iframe_api"
        strategy="afterInteractive"
      />
      <div id={containerId} className="absolute inset-0 h-full w-full" />
      {title ? (
        <span className="sr-only">Reproduciendo: {title}</span>
      ) : null}

      {fading && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent px-4 py-6 text-center">
          <p className="text-sm font-medium text-zinc-200">
            Bajando volumen… pasando a la siguiente
          </p>
        </div>
      )}

      {needsClick && !fading && (
        <button
          type="button"
          onClick={handleManualStart}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 text-white"
        >
          <span className="rounded-full bg-emerald-600 px-8 py-4 text-lg font-semibold shadow-lg hover:bg-emerald-500">
            ▶ Iniciar reproducción
          </span>
        </button>
      )}
    </div>
  )
}
