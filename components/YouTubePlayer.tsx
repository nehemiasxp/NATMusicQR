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
}

type Props = {
  videoId: string
  title?: string
  onEnded: () => void
  onError?: (code: number) => void
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
}: Props) {
  const reactId = useId().replace(/:/g, '')
  const containerId = `yt-player-${reactId}`
  const playerRef = useRef<YTPlayer | null>(null)
  const onEndedRef = useRef(onEnded)
  const onErrorRef = useRef(onError)
  const [needsClick, setNeedsClick] = useState(false)

  onEndedRef.current = onEnded
  onErrorRef.current = onError

  useEffect(() => {
    let cancelled = false
    let kickTimer: number | undefined

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
          // Muted autoplay is allowed by browsers; we unmute as soon as it plays
          mute: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            try {
              event.target.mute()
              event.target.playVideo()
            } catch {
              setNeedsClick(true)
            }

            // Si en 2s no arrancó, pedir un click (política del navegador)
            kickTimer = window.setTimeout(() => {
              try {
                const state = event.target.getPlayerState()
                // -1 unstarted, 0 ended, 2 paused, 5 cued
                if (state === -1 || state === 2 || state === 5) {
                  setNeedsClick(true)
                }
              } catch {
                setNeedsClick(true)
              }
            }, 2000)
          },
          onStateChange: (event) => {
            // 1 = PLAYING
            if (event.data === 1) {
              setNeedsClick(false)
              try {
                event.target.unMute()
              } catch {
                /* ignore */
              }
            }
            // 0 = ENDED
            if (event.data === 0) {
              onEndedRef.current()
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

  function handleManualStart() {
    const player = playerRef.current
    if (!player) return
    try {
      player.unMute()
      player.playVideo()
      setNeedsClick(false)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="relative w-full h-full bg-black">
      <Script
        src="https://www.youtube.com/iframe_api"
        strategy="afterInteractive"
      />
      <div id={containerId} className="absolute inset-0 w-full h-full" />
      {title ? (
        <span className="sr-only">Reproduciendo: {title}</span>
      ) : null}

      {needsClick && (
        <button
          type="button"
          onClick={handleManualStart}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 text-white"
        >
          <span className="rounded-full bg-emerald-600 hover:bg-emerald-500 px-8 py-4 text-lg font-semibold shadow-lg">
            ▶ Iniciar reproducción
          </span>
        </button>
      )}
    </div>
  )
}
