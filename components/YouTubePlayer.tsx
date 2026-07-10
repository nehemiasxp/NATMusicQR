'use client'

/**
 * YouTube IFrame API — un solo player estilo playlist + fade DJ.
 * - Un iframe persistente (loadVideoById)
 * - Cualquier cambio de tema: fade-out → carga → fade-in
 * - iOS: playsinline + mute inicial + gesto
 */

import { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string | HTMLElement,
        config: Record<string, unknown>
      ) => YTPlayer
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
  /** Señal externa (votos): fade y luego onFadeComplete */
  fadeOutKey?: string | number | null
  fadeOutMs?: number
  /** Duración del fade al cambiar de tema (DJ) */
  crossfadeMs?: number
  nextVideoId?: string | null
}

const YT_ENDED = 0
const YT_PLAYING = 1
const YT_PAUSED = 2
const YT_CUED = 5

/** Fade por defecto tipo DJ (ms) */
const DEFAULT_FADE_OUT_MS = 1600
const DEFAULT_FADE_IN_MS = 1400
const DEFAULT_VOTE_FADE_MS = 4200

let apiPromise: Promise<void> | null = null

function ensureYouTubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.YT?.Player) return Promise.resolve()
  if (apiPromise) return apiPromise

  apiPromise = new Promise<void>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      try {
        prev?.()
      } catch {
        /* ignore */
      }
      resolve()
    }

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

    window.setTimeout(() => {
      window.clearInterval(t)
      resolve()
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

function easeInCubic(t: number) {
  return t * t * t
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3)
}

export default function YouTubePlayer({
  videoId,
  title,
  onEnded,
  onFadeComplete,
  onError,
  fadeOutKey = null,
  fadeOutMs = DEFAULT_VOTE_FADE_MS,
  crossfadeMs = DEFAULT_FADE_OUT_MS,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const readyRef = useRef(false)
  const unlockedRef = useRef(false)
  const desiredRef = useRef<string | null>(null)
  const loadedRef = useRef<string | null>(null)
  const pendingIdRef = useRef<string | null>(null)
  const ignoreEndedUntil = useRef(0)
  const finishedRef = useRef(false)
  const fadingRef = useRef(false)
  const fadeRaf = useRef<number | null>(null)
  const lastFadeKey = useRef<string | number | null>(null)
  const creatingRef = useRef(false)
  const awaitFadeInRef = useRef(false)

  const onEndedRef = useRef(onEnded)
  const onFadeCompleteRef = useRef(onFadeComplete)
  const onErrorRef = useRef(onError)
  onEndedRef.current = onEnded
  onFadeCompleteRef.current = onFadeComplete
  onErrorRef.current = onError

  const [needsGesture, setNeedsGesture] = useState(false)
  const [fading, setFading] = useState(false)
  const [fadeLabel, setFadeLabel] = useState('Mezclando…')
  const [fadeProgress, setFadeProgress] = useState(0)
  const [idle, setIdle] = useState(!videoId)
  const [status, setStatus] = useState<string | null>(null)
  const [visualOpacity, setVisualOpacity] = useState(1)

  desiredRef.current = videoId?.trim() || null

  function cancelFade() {
    if (fadeRaf.current != null) {
      cancelAnimationFrame(fadeRaf.current)
      fadeRaf.current = null
    }
  }

  function setVol(p: YTPlayer, v: number) {
    try {
      p.setVolume(Math.max(0, Math.min(100, Math.round(v))))
    } catch {
      /* ignore */
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

  /** Fade de volumen + opacidad visual */
  function runVolumeFade(opts: {
    from: number
    to: number
    ms: number
    ease: (t: number) => number
    label: string
    onDone: () => void
  }) {
    const p = playerRef.current
    if (!p) {
      opts.onDone()
      return
    }

    cancelFade()
    fadingRef.current = true
    setFading(true)
    setFadeLabel(opts.label)
    setFadeProgress(0)

    const t0 = performance.now()
    const tick = (now: number) => {
      const raw = Math.min(1, (now - t0) / opts.ms)
      const e = opts.ease(raw)
      const vol = opts.from + (opts.to - opts.from) * e
      setVol(p, vol)
      // opacidad visual sigue el volumen (0.2 mínimo para no “pantalla negra total”)
      const op = 0.2 + 0.8 * (vol / 100)
      setVisualOpacity(op)
      setFadeProgress(Math.round(raw * 100))
      if (raw < 1) {
        fadeRaf.current = requestAnimationFrame(tick)
        return
      }
      setVol(p, opts.to)
      setVisualOpacity(opts.to <= 0 ? 0.15 : 1)
      fadingRef.current = false
      setFading(false)
      setFadeProgress(0)
      opts.onDone()
    }
    fadeRaf.current = requestAnimationFrame(tick)
  }

  function startFadeIn(ms = DEFAULT_FADE_IN_MS) {
    const p = playerRef.current
    if (!p) return
    try {
      if (unlockedRef.current) {
        p.unMute()
      } else {
        p.mute()
      }
      p.setVolume(0)
      p.playVideo()
    } catch {
      setNeedsGesture(true)
      return
    }

    if (!unlockedRef.current) {
      // iOS aún muteado: no hay fade de audio útil
      setVisualOpacity(1)
      return
    }

    runVolumeFade({
      from: 0,
      to: 100,
      ms,
      ease: easeOutCubic,
      label: 'Subiendo…',
      onDone: () => {
        setVisualOpacity(1)
        restoreAudio(p)
      },
    })
  }

  function doLoadVideo(id: string) {
    const p = playerRef.current
    if (!p) return
    ignoreEndedUntil.current = Date.now() + 1800
    finishedRef.current = false
    awaitFadeInRef.current = true
    try {
      p.mute()
      p.setVolume(0)
      p.loadVideoById({ videoId: id, startSeconds: 0 })
      loadedRef.current = id
      window.setTimeout(() => {
        try {
          p.playVideo()
        } catch {
          setNeedsGesture(true)
        }
      }, 80)
    } catch (e) {
      awaitFadeInRef.current = false
      setStatus(e instanceof Error ? e.message : 'Error al cargar video')
      setNeedsGesture(true)
    }
  }

  /**
   * Cambia de tema con fade DJ si hay algo sonando.
   * Si ya está en silencio / terminó → carga + fade-in.
   */
  function playOrLoad(id: string | null) {
    const p = playerRef.current
    if (!p || !readyRef.current) return

    if (!id) {
      pendingIdRef.current = null
      setIdle(true)
      // fade out y pausa
      let state = -1
      try {
        state = p.getPlayerState()
      } catch {
        /* ignore */
      }
      if (state === YT_PLAYING && unlockedRef.current) {
        runVolumeFade({
          from: (() => {
            try {
              return p.getVolume() || 100
            } catch {
              return 100
            }
          })(),
          to: 0,
          ms: crossfadeMs,
          ease: easeInCubic,
          label: 'Bajando…',
          onDone: () => {
            try {
              p.pauseVideo()
              p.mute()
            } catch {
              /* ignore */
            }
          },
        })
      } else {
        try {
          p.pauseVideo()
          p.mute()
        } catch {
          /* ignore */
        }
      }
      loadedRef.current = null
      return
    }

    setIdle(false)
    setStatus(null)
    finishedRef.current = false

    const same = loadedRef.current === id || readId(p) === id
    if (same) {
      pendingIdRef.current = null
      if (unlockedRef.current) restoreAudio(p)
      else p.mute()
      try {
        p.playVideo()
      } catch {
        setNeedsGesture(true)
      }
      setVisualOpacity(1)
      return
    }

    // Si ya hay una transición en curso hacia otro id, solo actualiza destino
    if (fadingRef.current) {
      pendingIdRef.current = id
      return
    }

    let state = -1
    try {
      state = p.getPlayerState()
    } catch {
      state = -1
    }

    // PLAYING=1, BUFFERING=3
    const isPlayingNow = state === YT_PLAYING || state === 3

    if (isPlayingNow && loadedRef.current && unlockedRef.current) {
      // DJ: bajar → cargar → subir
      pendingIdRef.current = id
      let startVol = 100
      try {
        const g = p.getVolume()
        if (typeof g === 'number' && g > 0) startVol = g
      } catch {
        startVol = 100
      }

      runVolumeFade({
        from: startVol,
        to: 0,
        ms: crossfadeMs,
        ease: easeInCubic,
        label: 'Mezclando…',
        onDone: () => {
          const target = pendingIdRef.current || id
          pendingIdRef.current = null
          try {
            p.pauseVideo()
          } catch {
            /* ignore */
          }
          doLoadVideo(target)
          // fade-in se dispara en onStateChange PLAYING (awaitFadeInRef)
        },
      })
      return
    }

    // Sin audio activo (fin natural, primer tema, etc.): carga + fade-in
    pendingIdRef.current = null
    doLoadVideo(id)
  }

  /** Fade externo (votos): solo baja y avisa al padre */
  function startExternalFadeOut(ms: number) {
    const p = playerRef.current
    if (!p || fadingRef.current) return

    let startVol = 100
    try {
      const g = p.getVolume()
      if (typeof g === 'number' && g > 0) startVol = g
      p.unMute()
      p.playVideo()
    } catch {
      startVol = 100
    }

    runVolumeFade({
      from: startVol,
      to: 0,
      ms,
      ease: easeInCubic,
      label: 'La sala pidió cambio…',
      onDone: () => {
        try {
          p.mute()
          p.pauseVideo()
        } catch {
          /* ignore */
        }
        finishedRef.current = true
        fadingRef.current = false
        ;(onFadeCompleteRef.current ?? onEndedRef.current)()
      },
    })
  }

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
              event.target.setVolume(0)
            } catch {
              /* ignore */
            }

            const want = desiredRef.current
            if (want && want !== firstId) {
              playOrLoad(want)
            } else if (want) {
              awaitFadeInRef.current = true
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
              const vid = readId(event.target)
              if (vid) loadedRef.current = vid

              if (awaitFadeInRef.current) {
                awaitFadeInRef.current = false
                startFadeIn(DEFAULT_FADE_IN_MS)
              } else if (!fadingRef.current && unlockedRef.current) {
                restoreAudio(event.target)
                setVisualOpacity(1)
              }
            }
            if (event.data === YT_ENDED && !fadingRef.current) {
              if (Date.now() < ignoreEndedUntil.current) return
              if (finishedRef.current) return
              finishedRef.current = true
              onEndedRef.current()
            }
          },
          onError: (event: { data: number }) => {
            awaitFadeInRef.current = false
            const code = event.data
            const hints: Record<number, string> = {
              2: 'ID de video inválido',
              5: 'Error HTML5 del player',
              100: 'Video no encontrado o privado',
              101: 'El dueño no permite embeber este video',
              150: 'El dueño no permite embeber este video',
              153: 'YouTube bloqueó el embed (Referer).',
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

  useEffect(() => {
    const id = videoId?.trim() || null
    desiredRef.current = id

    if (!id) {
      setIdle(true)
      if (playerRef.current && readyRef.current) playOrLoad(null)
      return
    }

    if (!playerRef.current) {
      void ensurePlayer(id)
      return
    }

    if (readyRef.current) playOrLoad(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  useEffect(() => {
    if (fadeOutKey == null || fadeOutKey === '') return
    if (lastFadeKey.current === fadeOutKey) return
    lastFadeKey.current = fadeOutKey
    const t = window.setTimeout(
      () => startExternalFadeOut(fadeOutMs),
      50
    )
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
          doLoadVideo(want)
        } else {
          p.playVideo()
          setVisualOpacity(1)
        }
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
        className="absolute inset-0 h-full w-full"
        style={{
          opacity: visualOpacity,
          transition: fading ? 'none' : 'opacity 0.35s ease-out',
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
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-end bg-gradient-to-t from-black via-black/50 to-transparent pb-10">
          <p className="text-sm font-medium tracking-wide text-zinc-100">
            {fadeLabel}
          </p>
          <p className="mt-1 text-xs text-zinc-400">Transición suave · DJ mode</p>
          <div className="mt-3 h-1 w-44 overflow-hidden rounded-full bg-zinc-800">
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
            ▶ Toca para iniciar
          </span>
        </button>
      )}
    </div>
  )
}
