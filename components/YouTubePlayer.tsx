'use client'

/**
 * YouTube IFrame API — un solo player (playlist style).
 * - No se destruye al cambiar de canción (loadVideoById)
 * - No se crea sin un videoId válido (evita errores de boot)
 * - iOS: playsinline + mute inicial + botón de gesto
 *
 * https://developers.google.com/youtube/iframe_api_reference
 */

import { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string | HTMLElement,
        config: Record<string, unknown>
      ) => YTPlayer
      PlayerState?: {
        ENDED: number
        PLAYING: number
        PAUSED: number
        CUED: number
      }
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

type YTPlayer = {
  destroy: () => void
  loadVideoById: (
    opts: string | { videoId: string; startSeconds?: number }
  ) => void
  playVideo: () => void
  pauseVideo: () => void
  mute: () => void
  unMute: () => void
  getPlayerState: () => number
  setVolume: (n: number) => void
  getVolume: () => number
  isMuted: () => boolean
  getVideoData?: () => { video_id?: string }
}

type Props = {
  videoId: string | null | undefined
  title?: string
  onEnded: () => void
  onFadeComplete?: () => void
  onError?: (code: number) => void
  fadeOutKey?: string | number | null
  fadeOutMs?: number
  nextVideoId?: string | null
}

const YT_ENDED = 0
const YT_PLAYING = 1
const YT_PAUSED = 2
const YT_CUED = 5

let apiPromise: Promise<void> | null = null

function ensureYouTubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.YT?.Player) return Promise.resolve()
  if (apiPromise) return apiPromise

  apiPromise = new Promise<void>((resolve) => {
    const done = () => {
      if (window.YT?.Player) resolve()
    }

    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      try {
        prev?.()
      } catch {
        /* ignore */
      }
      done()
    }

    // Script ya en la página
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      tag.async = true
      document.head.appendChild(tag)
    }

    const t = window.setInterval(() => {
      if (window.YT?.Player) {
        window.clearInterval(t)
        resolve()
      }
    }, 50)

    // Timeout duro: no colgar la UI
    window.setTimeout(() => {
      window.clearInterval(t)
      if (window.YT?.Player) resolve()
      else resolve() // el caller verá que no hay Player
    }, 15000)
  })

  return apiPromise
}

function readId(player: YTPlayer): string | null {
  try {
    return player.getVideoData?.()?.video_id ?? null
  } catch {
    return null
  }
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
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const readyRef = useRef(false)
  const unlockedRef = useRef(false)
  const desiredRef = useRef<string | null>(null)
  const loadedRef = useRef<string | null>(null)
  const ignoreEndedUntil = useRef(0)
  const finishedRef = useRef(false)
  const fadingRef = useRef(false)
  const fadeRaf = useRef<number | null>(null)
  const lastFadeKey = useRef<string | number | null>(null)
  const creatingRef = useRef(false)

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
  const [status, setStatus] = useState<string | null>(null)

  desiredRef.current = videoId?.trim() || null

  function cancelFade() {
    if (fadeRaf.current != null) {
      cancelAnimationFrame(fadeRaf.current)
      fadeRaf.current = null
    }
  }

  function restoreAudio(p: YTPlayer) {
    try {
      p.unMute()
      p.setVolume(100)
      unlockedRef.current = true
      setNeedsGesture(false)
    } catch {
      /* iOS */
    }
  }

  function playOrLoad(id: string | null) {
    const p = playerRef.current
    if (!p || !readyRef.current) return

    cancelFade()
    fadingRef.current = false
    finishedRef.current = false
    setFading(false)
    setFadeProgress(0)
    lastFadeKey.current = null

    if (!id) {
      setIdle(true)
      try {
        p.pauseVideo()
        p.mute()
      } catch {
        /* ignore */
      }
      return
    }

    setIdle(false)
    setStatus(null)
    ignoreEndedUntil.current = Date.now() + 1500

    const same = loadedRef.current === id || readId(p) === id
    try {
      if (same) {
        if (unlockedRef.current) restoreAudio(p)
        else p.mute()
        p.playVideo()
        return
      }

      if (unlockedRef.current) {
        p.loadVideoById({ videoId: id, startSeconds: 0 })
        window.setTimeout(() => {
          if (desiredRef.current === id && playerRef.current) {
            restoreAudio(playerRef.current)
            try {
              playerRef.current.playVideo()
            } catch {
              /* ignore */
            }
          }
        }, 200)
      } else {
        p.mute()
        p.loadVideoById({ videoId: id, startSeconds: 0 })
        window.setTimeout(() => {
          try {
            p.playVideo()
          } catch {
            setNeedsGesture(true)
          }
        }, 100)
      }
      loadedRef.current = id
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Error al cargar video')
      setNeedsGesture(true)
    }
  }

  function startFadeOut(ms: number) {
    const p = playerRef.current
    if (!p || fadingRef.current || finishedRef.current) return
    fadingRef.current = true
    setFading(true)
    setFadeProgress(0)
    cancelFade()

    try {
      p.unMute()
      p.playVideo()
    } catch {
      /* ignore */
    }

    let startVol = 100
    try {
      const g = p.getVolume()
      if (typeof g === 'number' && g > 0) startVol = g
    } catch {
      startVol = 100
    }

    const t0 = performance.now()
    const tick = (now: number) => {
      if (finishedRef.current) return
      const t = Math.min(1, (now - t0) / ms)
      const eased = t * t * t
      try {
        p.setVolume(Math.round(startVol * (1 - eased)))
      } catch {
        /* ignore */
      }
      setFadeProgress(Math.round(t * 100))
      if (t < 1) {
        fadeRaf.current = requestAnimationFrame(tick)
        return
      }
      try {
        p.setVolume(0)
        p.mute()
        p.pauseVideo()
      } catch {
        /* ignore */
      }
      finishedRef.current = true
      fadingRef.current = false
      ;(onFadeCompleteRef.current ?? onEndedRef.current)()
    }
    fadeRaf.current = requestAnimationFrame(tick)
  }

  /** Crea el YT.Player solo cuando hay un videoId válido */
  async function ensurePlayer(firstId: string) {
    if (playerRef.current || creatingRef.current) return
    const wrap = wrapRef.current
    if (!wrap) return

    creatingRef.current = true
    setStatus(null)

    try {
      await ensureYouTubeApi()
      if (!window.YT?.Player) {
        setStatus('No se pudo cargar YouTube. Revisa la red o bloqueadores.')
        creatingRef.current = false
        return
      }
      if (playerRef.current) {
        creatingRef.current = false
        return
      }

      // Host limpio (YT reemplaza este nodo por iframe)
      wrap.innerHTML = ''
      const host = document.createElement('div')
      host.style.width = '100%'
      host.style.height = '100%'
      wrap.appendChild(host)
      hostRef.current = host

      playerRef.current = new window.YT.Player(host, {
        width: '100%',
        height: '100%',
        videoId: firstId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          mute: 1,
          fs: 0,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: { target: YTPlayer }) => {
            readyRef.current = true
            playerRef.current = event.target
            creatingRef.current = false
            loadedRef.current = firstId
            try {
              event.target.mute()
              event.target.setVolume(100)
            } catch {
              /* ignore */
            }

            const want = desiredRef.current
            if (want && want !== firstId) {
              playOrLoad(want)
            } else if (want) {
              try {
                event.target.playVideo()
              } catch {
                setNeedsGesture(true)
              }
              window.setTimeout(() => {
                try {
                  const st = event.target.getPlayerState()
                  if (st === -1 || st === YT_PAUSED || st === YT_CUED) {
                    setNeedsGesture(true)
                  }
                } catch {
                  setNeedsGesture(true)
                }
              }, 2200)
            } else {
              setIdle(true)
              try {
                event.target.pauseVideo()
              } catch {
                /* ignore */
              }
            }
          },
          onStateChange: (event: { data: number; target: YTPlayer }) => {
            if (event.data === YT_PLAYING) {
              setNeedsGesture(false)
              setIdle(false)
              setStatus(null)
              if (!fadingRef.current) restoreAudio(event.target)
              const vid = readId(event.target)
              if (vid) loadedRef.current = vid
            }
            if (event.data === YT_ENDED && !fadingRef.current) {
              if (Date.now() < ignoreEndedUntil.current) return
              if (finishedRef.current) return
              finishedRef.current = true
              onEndedRef.current()
            }
          },
          onError: (event: { data: number }) => {
            const code = event.data
            const hints: Record<number, string> = {
              2: 'ID de video inválido',
              5: 'Error HTML5 del player',
              100: 'Video no encontrado o privado',
              101: 'El dueño no permite embeber este video',
              150: 'El dueño no permite embeber este video',
              153: 'YouTube bloqueó el embed (Referer). Revisa dominio en Vercel.',
            }
            setStatus(hints[code] || `Error YouTube (${code})`)
            onErrorRef.current?.(code)
          },
          onAutoplayBlocked: () => {
            setNeedsGesture(true)
          },
        },
      })
    } catch (e) {
      creatingRef.current = false
      setStatus(e instanceof Error ? e.message : 'Error creando el player')
    }
  }

  // Cleanup al salir de la página TV
  useEffect(() => {
    return () => {
      cancelFade()
      readyRef.current = false
      if (playerRef.current) {
        try {
          playerRef.current.destroy()
        } catch {
          /* ignore */
        }
        playerRef.current = null
      }
      if (wrapRef.current) {
        try {
          wrapRef.current.innerHTML = ''
        } catch {
          /* ignore */
        }
      }
    }
  }, [])

  // videoId cambia → crear o loadVideoById
  useEffect(() => {
    const id = videoId?.trim() || null
    desiredRef.current = id

    if (!id) {
      setIdle(true)
      if (playerRef.current && readyRef.current) {
        playOrLoad(null)
      }
      return
    }

    if (!playerRef.current) {
      void ensurePlayer(id)
      return
    }

    if (readyRef.current) {
      playOrLoad(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  // Fade por votos
  useEffect(() => {
    if (fadeOutKey == null || fadeOutKey === '') return
    if (lastFadeKey.current === fadeOutKey) return
    lastFadeKey.current = fadeOutKey
    const t = window.setTimeout(() => startFadeOut(fadeOutMs), 50)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeOutKey, fadeOutMs])

  function handleUnlock() {
    const p = playerRef.current
    if (!p) return
    try {
      unlockedRef.current = true
      p.unMute()
      p.setVolume(100)
      const want = desiredRef.current
      if (want) {
        if (loadedRef.current !== want) {
          p.loadVideoById({ videoId: want, startSeconds: 0 })
          loadedRef.current = want
        }
        p.playVideo()
      }
      setNeedsGesture(false)
      setStatus(null)
    } catch {
      setStatus('No se pudo iniciar. Vuelve a tocar.')
    }
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
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

      {status && (
        <div className="absolute inset-x-0 top-0 z-[25] bg-red-950/90 px-4 py-2 text-center text-sm text-red-100">
          {status}
        </div>
      )}

      {idle && !needsGesture && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center bg-black/80 p-6 text-center">
          <p className="text-xl text-zinc-400">Esperando canciones…</p>
          <p className="mt-2 text-sm text-zinc-600">
            El video arranca al llegar el primer pedido
          </p>
        </div>
      )}

      {fading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-end bg-gradient-to-t from-black via-black/40 to-transparent pb-10">
          <p className="text-sm font-medium text-zinc-100">
            Bajando el volumen…
          </p>
          <div className="mt-3 h-1 w-40 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500"
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
            ▶ Toca para iniciar
          </span>
        </button>
      )}
    </div>
  )
}
