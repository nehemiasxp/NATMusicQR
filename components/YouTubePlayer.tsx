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
  pauseVideo: () => void
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
  /** Fin natural del video o error */
  onEnded: () => void
  /** Fin tras fade por votos (salto suave) */
  onFadeComplete?: () => void
  onError?: (code: number) => void
  /**
   * Cuando se asigna un id (ej. queue item), inicia fade de volumen
   * y al terminar llama onFadeComplete (o onEnded si no hay).
   */
  fadeOutKey?: string | number | null
  /** Duración del fade en ms */
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
  onFadeComplete,
  onError,
  fadeOutKey = null,
  fadeOutMs = 4500,
}: Props) {
  const reactId = useId().replace(/:/g, '')
  const containerId = `yt-player-${reactId}`
  const playerRef = useRef<YTPlayer | null>(null)
  const onEndedRef = useRef(onEnded)
  const onFadeCompleteRef = useRef(onFadeComplete)
  const onErrorRef = useRef(onError)
  const [needsClick, setNeedsClick] = useState(false)
  const [fading, setFading] = useState(false)
  const [fadeProgress, setFadeProgress] = useState(0)
  const fadingRef = useRef(false)
  const fadeRafRef = useRef<number | null>(null)
  const lastFadeKeyRef = useRef<string | number | null>(null)
  const finishedRef = useRef(false)

  onEndedRef.current = onEnded
  onFadeCompleteRef.current = onFadeComplete
  onErrorRef.current = onError

  function cancelFadeLoop() {
    if (fadeRafRef.current != null) {
      cancelAnimationFrame(fadeRafRef.current)
      fadeRafRef.current = null
    }
  }

  function safeSetVolume(player: YTPlayer, vol: number) {
    const v = Math.max(0, Math.min(100, Math.round(vol)))
    try {
      if (player.isMuted()) player.unMute()
    } catch {
      /* ignore */
    }
    try {
      player.setVolume(v)
    } catch {
      /* ignore */
    }
  }

  /**
   * Fade suave con requestAnimationFrame (curva ease-in: más natural al final).
   */
  function startFadeOut(durationMs: number) {
    const player = playerRef.current
    if (!player || fadingRef.current || finishedRef.current) return

    fadingRef.current = true
    setFading(true)
    setFadeProgress(0)
    cancelFadeLoop()

    // Asegurar audio activo antes de bajar
    try {
      player.unMute()
      player.playVideo()
    } catch {
      /* ignore */
    }

    let startVol = 100
    try {
      const g = player.getVolume()
      if (typeof g === 'number' && !Number.isNaN(g) && g > 0) startVol = g
      else startVol = 100
      player.setVolume(startVol)
    } catch {
      startVol = 100
    }

    const t0 = performance.now()

    const tick = (now: number) => {
      if (finishedRef.current) return
      const elapsed = now - t0
      const t = Math.min(1, elapsed / durationMs)
      // ease-in cúbico: se oye más “como se acaba”
      const eased = t * t * t
      const vol = startVol * (1 - eased)
      safeSetVolume(player, vol)
      setFadeProgress(Math.round(t * 100))

      if (t < 1) {
        fadeRafRef.current = requestAnimationFrame(tick)
        return
      }

      // Silencio total y pausa (no stop brusco a mitad de frase de audio)
      safeSetVolume(player, 0)
      try {
        player.mute()
        player.pauseVideo()
      } catch {
        try {
          player.stopVideo()
        } catch {
          /* ignore */
        }
      }

      finishedRef.current = true
      const done = onFadeCompleteRef.current ?? onEndedRef.current
      done()
    }

    fadeRafRef.current = requestAnimationFrame(tick)
  }

  function fireNaturalEnded() {
    if (finishedRef.current || fadingRef.current) return
    finishedRef.current = true
    onEndedRef.current()
  }

  useEffect(() => {
    let cancelled = false
    let kickTimer: number | undefined
    finishedRef.current = false
    fadingRef.current = false
    setFading(false)
    setFadeProgress(0)
    lastFadeKeyRef.current = null
    cancelFadeLoop()

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
            // ENDED natural (no durante fade)
            if (event.data === 0 && !fadingRef.current) {
              fireNaturalEnded()
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
      cancelFadeLoop()
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

  // Iniciar fade cuando llega la señal de “salto por votos”
  useEffect(() => {
    if (fadeOutKey == null || fadeOutKey === '') return
    if (lastFadeKeyRef.current === fadeOutKey) return
    lastFadeKeyRef.current = fadeOutKey

    // Pequeño delay para que el player esté listo
    const t = window.setTimeout(() => {
      startFadeOut(fadeOutMs)
    }, 80)

    return () => window.clearTimeout(t)
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
    <div className="relative h-full w-full overflow-hidden bg-black">
      <Script
        src="https://www.youtube.com/iframe_api"
        strategy="afterInteractive"
      />
      <div
        id={containerId}
        className="absolute inset-0 h-full w-full transition-opacity duration-500"
        style={{ opacity: fading ? 1 - fadeProgress / 130 : 1 }}
      />
      {title ? (
        <span className="sr-only">Reproduciendo: {title}</span>
      ) : null}

      {fading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-end bg-gradient-to-t from-black via-black/40 to-transparent pb-10">
          <p className="text-sm font-medium tracking-wide text-zinc-100">
            Bajando el volumen…
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            La sala pidió cambio · pasando a la siguiente
          </p>
          <div className="mt-3 h-1 w-40 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-75"
              style={{ width: `${fadeProgress}%` }}
            />
          </div>
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
