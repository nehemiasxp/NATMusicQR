'use client'

/**
 * Player YouTube estilo playlist (Spotify-like):
 * - Un solo YT.Player / iframe durante toda la sesión de TV
 * - Cambio de canción con loadVideoById (NO destroy/remount)
 * - iOS/Safari: playsinline + mute inicial + onAutoplayBlocked
 * - Host DOM fuera del control de React (evita que el iframe se pise)
 *
 * Docs: https://developers.google.com/youtube/iframe_api_reference
 */

import { useEffect, useRef, useState } from 'react'
import Script from 'next/script'

declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string | HTMLElement,
        config: {
          width?: string | number
          height?: string | number
          videoId?: string
          host?: string
          playerVars?: Record<string, string | number>
          events?: {
            onReady?: (event: { target: YTPlayer }) => void
            onStateChange?: (event: { data: number; target: YTPlayer }) => void
            onError?: (event: { data: number }) => void
            onAutoplayBlocked?: (event: { target: YTPlayer }) => void
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
  loadVideoById: (
    videoIdOrOpts:
      | string
      | { videoId: string; startSeconds?: number; endSeconds?: number }
  ) => void
  cueVideoById: (
    videoIdOrOpts:
      | string
      | { videoId: string; startSeconds?: number; endSeconds?: number }
  ) => void
  playVideo: () => void
  pauseVideo: () => void
  mute: () => void
  unMute: () => void
  stopVideo: () => void
  getPlayerState: () => number
  setVolume: (volume: number) => void
  getVolume: () => number
  isMuted: () => boolean
  getVideoData?: () => { video_id?: string }
}

type Props = {
  /** YouTube video id actual. null/'' = idle (player sigue montado). */
  videoId: string | null | undefined
  title?: string
  onEnded: () => void
  onFadeComplete?: () => void
  onError?: (code: number) => void
  fadeOutKey?: string | number | null
  fadeOutMs?: number
  /** Siguiente id (referencia UI; el cambio real va por videoId) */
  nextVideoId?: string | null
}

const YT_ENDED = 0
const YT_PLAYING = 1
const YT_PAUSED = 2
const YT_CUED = 5

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
    }, 40)
  })
}

function readLoadedVideoId(player: YTPlayer): string | null {
  try {
    const data = player.getVideoData?.()
    if (data?.video_id) return data.video_id
  } catch {
    /* ignore */
  }
  return null
}

export default function YouTubePlayer({
  videoId,
  title,
  onEnded,
  onFadeComplete,
  onError,
  fadeOutKey = null,
  fadeOutMs = 4500,
  nextVideoId = null,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const readyRef = useRef(false)
  /** Tras PLAYING + unMute (gesto/sesión desbloqueada en iOS) */
  const sessionUnlockedRef = useRef(false)
  const desiredIdRef = useRef<string | null>(null)
  const loadedIdRef = useRef<string | null>(null)
  const ignoreEndedUntilRef = useRef(0)
  const finishedRef = useRef(false)
  const fadingRef = useRef(false)
  const fadeRafRef = useRef<number | null>(null)
  const lastFadeKeyRef = useRef<string | number | null>(null)

  const onEndedRef = useRef(onEnded)
  const onFadeCompleteRef = useRef(onFadeComplete)
  const onErrorRef = useRef(onError)
  onEndedRef.current = onEnded
  onFadeCompleteRef.current = onFadeComplete
  onErrorRef.current = onError

  const [needsGesture, setNeedsGesture] = useState(false)
  const [fading, setFading] = useState(false)
  const [fadeProgress, setFadeProgress] = useState(0)
  const [idle, setIdle] = useState(!videoId)

  desiredIdRef.current = videoId?.trim() || null

  function cancelFadeLoop() {
    if (fadeRafRef.current != null) {
      cancelAnimationFrame(fadeRafRef.current)
      fadeRafRef.current = null
    }
  }

  function safeSetVolume(player: YTPlayer, vol: number) {
    try {
      player.setVolume(Math.max(0, Math.min(100, Math.round(vol))))
    } catch {
      /* ignore */
    }
  }

  function restoreFullVolume(player: YTPlayer) {
    try {
      player.unMute()
      player.setVolume(100)
      sessionUnlockedRef.current = true
      setNeedsGesture(false)
    } catch {
      /* iOS puede bloquear unMute hasta gesto */
    }
  }

  function playOrLoad(id: string | null) {
    const player = playerRef.current
    if (!player || !readyRef.current) return

    cancelFadeLoop()
    fadingRef.current = false
    finishedRef.current = false
    setFading(false)
    setFadeProgress(0)
    lastFadeKeyRef.current = null

    if (!id) {
      setIdle(true)
      try {
        player.pauseVideo()
        player.mute()
      } catch {
        /* ignore */
      }
      loadedIdRef.current = null
      return
    }

    setIdle(false)
    const already =
      loadedIdRef.current === id || readLoadedVideoId(player) === id
    ignoreEndedUntilRef.current = Date.now() + 1200

    try {
      if (already) {
        if (sessionUnlockedRef.current) restoreFullVolume(player)
        else player.mute()
        player.playVideo()
        return
      }

      // Misma sesión de media: loadVideoById (NO destroy, NO stopVideo)
      if (sessionUnlockedRef.current) {
        player.loadVideoById({ videoId: id, startSeconds: 0 })
        window.setTimeout(() => {
          if (desiredIdRef.current === id && playerRef.current) {
            restoreFullVolume(playerRef.current)
            try {
              playerRef.current.playVideo()
            } catch {
              /* ignore */
            }
          }
        }, 250)
      } else {
        player.mute()
        player.loadVideoById({ videoId: id, startSeconds: 0 })
        window.setTimeout(() => {
          try {
            player.playVideo()
          } catch {
            setNeedsGesture(true)
          }
        }, 80)
      }
      loadedIdRef.current = id
    } catch {
      setNeedsGesture(true)
    }
  }

  function startFadeOut(durationMs: number) {
    const player = playerRef.current
    if (!player || fadingRef.current || finishedRef.current) return

    fadingRef.current = true
    setFading(true)
    setFadeProgress(0)
    cancelFadeLoop()

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
      player.setVolume(startVol)
    } catch {
      startVol = 100
    }

    const t0 = performance.now()

    const tick = (now: number) => {
      if (finishedRef.current) return
      const elapsed = now - t0
      const t = Math.min(1, elapsed / durationMs)
      const eased = t * t * t
      safeSetVolume(player, startVol * (1 - eased))
      setFadeProgress(Math.round(t * 100))

      if (t < 1) {
        fadeRafRef.current = requestAnimationFrame(tick)
        return
      }

      safeSetVolume(player, 0)
      try {
        player.mute()
        player.pauseVideo()
      } catch {
        /* ignore */
      }

      finishedRef.current = true
      fadingRef.current = false
      const done = onFadeCompleteRef.current ?? onEndedRef.current
      done()
    }

    fadeRafRef.current = requestAnimationFrame(tick)
  }

  // ——— Montar player UNA sola vez; host fuera del reconciler de React ———
  useEffect(() => {
    let cancelled = false
    let kickTimer: number | undefined
    const wrap = wrapRef.current
    if (!wrap) return

    // Nodo hijo gestionado solo por nosotros / YT (React no lo toca)
    const host = document.createElement('div')
    host.style.width = '100%'
    host.style.height = '100%'
    wrap.appendChild(host)

    async function mountOnce() {
      await loadYouTubeApi()
      if (cancelled || !window.YT?.Player) return
      if (playerRef.current) return

      const initialId = desiredIdRef.current || undefined

      playerRef.current = new window.YT.Player(host, {
        width: '100%',
        height: '100%',
        ...(initialId ? { videoId: initialId } : {}),
        playerVars: {
          autoplay: initialId ? 1 : 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          // Crítico iOS: inline, no fullscreen forzado
          playsinline: 1,
          // Primer autoplay con mute (política Safari/iOS)
          mute: 1,
          fs: 1,
          origin:
            typeof window !== 'undefined' ? window.location.origin : '',
        },
        events: {
          onReady: (event) => {
            if (cancelled) return
            readyRef.current = true
            playerRef.current = event.target

            try {
              event.target.mute()
              event.target.setVolume(100)
            } catch {
              /* ignore */
            }

            const want = desiredIdRef.current
            if (want) {
              loadedIdRef.current = want
              // Si el constructor ya cargó otro id, forzar el deseado
              const current = readLoadedVideoId(event.target)
              if (current !== want) {
                try {
                  event.target.mute()
                  event.target.loadVideoById({
                    videoId: want,
                    startSeconds: 0,
                  })
                } catch {
                  setNeedsGesture(true)
                }
              } else {
                try {
                  event.target.playVideo()
                } catch {
                  setNeedsGesture(true)
                }
              }

              kickTimer = window.setTimeout(() => {
                try {
                  const st = event.target.getPlayerState()
                  if (st === -1 || st === YT_PAUSED || st === YT_CUED) {
                    setNeedsGesture(true)
                  }
                } catch {
                  setNeedsGesture(true)
                }
              }, 2500)
            } else {
              setIdle(true)
            }
          },
          onStateChange: (event) => {
            const state = event.data

            if (state === YT_PLAYING) {
              setNeedsGesture(false)
              setIdle(false)
              if (!fadingRef.current) {
                restoreFullVolume(event.target)
              }
              const vid = readLoadedVideoId(event.target)
              if (vid) loadedIdRef.current = vid
            }

            if (state === YT_ENDED && !fadingRef.current) {
              if (Date.now() < ignoreEndedUntilRef.current) return
              if (finishedRef.current) return
              finishedRef.current = true
              onEndedRef.current()
            }
          },
          onError: (event) => {
            onErrorRef.current?.(event.data)
          },
          onAutoplayBlocked: () => {
            setNeedsGesture(true)
          },
        },
      })
    }

    void mountOnce()

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
      readyRef.current = false
      loadedIdRef.current = null
      try {
        wrap.innerHTML = ''
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- montaje único de página
  }, [])

  // ——— Cambio de canción: loadVideoById, sin remount ———
  useEffect(() => {
    const id = videoId?.trim() || null
    if (!readyRef.current || !playerRef.current) return
    playOrLoad(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  useEffect(() => {
    void nextVideoId
  }, [nextVideoId])

  useEffect(() => {
    if (fadeOutKey == null || fadeOutKey === '') return
    if (lastFadeKeyRef.current === fadeOutKey) return
    lastFadeKeyRef.current = fadeOutKey
    const t = window.setTimeout(() => startFadeOut(fadeOutMs), 60)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeOutKey, fadeOutMs])

  function handleUnlock() {
    const player = playerRef.current
    if (!player) return
    try {
      sessionUnlockedRef.current = true
      player.unMute()
      player.setVolume(100)
      const want = desiredIdRef.current
      if (want) {
        if (loadedIdRef.current !== want) {
          player.loadVideoById({ videoId: want, startSeconds: 0 })
          loadedIdRef.current = want
        } else {
          player.playVideo()
        }
      } else {
        player.playVideo()
      }
      setNeedsGesture(false)
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

      {/* Solo este wrapper es de React; el iframe lo crea YT dentro */}
      <div
        ref={wrapRef}
        className="absolute inset-0 h-full w-full transition-opacity duration-500"
        style={{
          opacity: fading ? Math.max(0.15, 1 - fadeProgress / 130) : 1,
        }}
      />

      {title ? (
        <span className="sr-only">Reproduciendo: {title}</span>
      ) : null}

      {idle && !needsGesture && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center bg-black/80 p-6 text-center">
          <p className="text-xl text-zinc-400">Esperando canciones…</p>
          <p className="mt-2 text-sm text-zinc-600">
            Player listo · sin recargar iframe
          </p>
        </div>
      )}

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

      {needsGesture && !fading && (
        <button
          type="button"
          onClick={handleUnlock}
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 text-white"
        >
          <span className="rounded-full bg-emerald-600 px-8 py-4 text-lg font-semibold shadow-lg hover:bg-emerald-500">
            ▶ Toca para iniciar (iOS / TV)
          </span>
        </button>
      )}
    </div>
  )
}
