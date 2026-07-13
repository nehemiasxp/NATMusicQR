'use client'

/**
 * YouTube TV player — playlist + fade VISUAL (DJ).
 *
 * Audio (iOS + desktop):
 * - Nunca dejamos volumen en 0 con setVolume (causa “sin audio”).
 * - loadVideoById a menudo re-mutea: en cada PLAYING forzamos unMute + vol 100
 *   si ya hubo gesto de usuario.
 * - Fade solo visual (opacidad). En iOS setVolume no es fiable.
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
  getCurrentTime: () => number
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
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
  crossfadeMs?: number
  nextVideoId?: string | null
}

const YT_ENDED = 0
const YT_PLAYING = 1
const YT_PAUSED = 2
const YT_CUED = 5

const DESKTOP_FADE_OUT_MS = 1400
const DESKTOP_FADE_IN_MS = 1200
const IOS_FADE_OUT_MS = 1600
const IOS_FADE_IN_MS = 1400
const BLACK_HOLD_MS = 180
const DEFAULT_VOTE_FADE_MS = 4000

let apiPromise: Promise<void> | null = null

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    return true
  }
  return false
}

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
  crossfadeMs,
}: Props) {
  const ios = useRef(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const readyRef = useRef(false)
  /** true tras gesto de usuario (toque) — permite audio con sonido */
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
  const lastLegalTimeRef = useRef(0)
  const seekGuardTimer = useRef<number | null>(null)
  const audioWatchdog = useRef<number | null>(null)

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
  const [iosMode, setIosMode] = useState(false)

  desiredRef.current = videoId?.trim() || null

  useEffect(() => {
    ios.current = isIOSDevice()
    setIosMode(ios.current)
  }, [])

  function getFadeOutDuration() {
    if (crossfadeMs != null) return crossfadeMs
    return ios.current ? IOS_FADE_OUT_MS : DESKTOP_FADE_OUT_MS
  }

  function getFadeInDuration() {
    return ios.current ? IOS_FADE_IN_MS : DESKTOP_FADE_IN_MS
  }

  function cancelFade() {
    if (fadeRaf.current != null) {
      cancelAnimationFrame(fadeRaf.current)
      fadeRaf.current = null
    }
  }

  /**
   * Audio a tope. Crítico: loadVideoById re-mutea a menudo.
   * NO usamos setVolume(0) en ninguna transición.
   */
  function ensureLoud(p: YTPlayer | null | undefined) {
    if (!p) return
    if (!unlockedRef.current) return
    try {
      p.unMute()
      p.setVolume(100)
    } catch {
      try {
        p.unMute()
      } catch {
        /* ignore */
      }
    }
  }

  /** Solo fade de opacidad (nunca toca volumen a 0) */
  function runVisualFade(opts: {
    fromOp: number
    toOp: number
    ms: number
    ease: (t: number) => number
    label: string
    onDone: () => void
  }) {
    cancelFade()
    fadingRef.current = true
    setFading(true)
    setFadeLabel(opts.label)
    setFadeProgress(0)

    const t0 = performance.now()
    const tick = (now: number) => {
      const raw = Math.min(1, (now - t0) / opts.ms)
      const e = opts.ease(raw)
      const op = opts.fromOp + (opts.toOp - opts.fromOp) * e
      setVisualOpacity(op)
      setFadeProgress(Math.round(raw * 100))
      if (raw < 1) {
        fadeRaf.current = requestAnimationFrame(tick)
        return
      }
      setVisualOpacity(opts.toOp)
      fadingRef.current = false
      setFading(false)
      setFadeProgress(0)
      opts.onDone()
    }
    fadeRaf.current = requestAnimationFrame(tick)
  }

  function startFadeIn() {
    const p = playerRef.current
    if (!p) return

    try {
      p.playVideo()
      ensureLoud(p)
    } catch {
      setNeedsGesture(true)
      setVisualOpacity(1)
      ensureLoud(p)
      return
    }

    runVisualFade({
      fromOp: 0.08,
      toOp: 1,
      ms: getFadeInDuration(),
      ease: easeOutCubic,
      label: 'Entrando…',
      onDone: () => {
        setVisualOpacity(1)
        ensureLoud(p)
      },
    })

    // Seguridad audio
    window.setTimeout(() => ensureLoud(playerRef.current), 400)
    window.setTimeout(() => ensureLoud(playerRef.current), 1200)
    window.setTimeout(() => {
      ensureLoud(playerRef.current)
      setVisualOpacity(1)
    }, 2500)
  }

  function doLoadVideo(id: string) {
    const p = playerRef.current
    if (!p) return
    ignoreEndedUntil.current = Date.now() + 2000
    finishedRef.current = false
    awaitFadeInRef.current = true
    lastLegalTimeRef.current = 0
    try {
      // Solo mute si AÚN no hubo gesto (autoplay policy)
      if (!unlockedRef.current) {
        p.mute()
      } else {
        // Ya desbloqueado: audio listo ANTES y DESPUÉS del load
        ensureLoud(p)
      }

      p.loadVideoById({ videoId: id, startSeconds: 0 })
      loadedRef.current = id

      window.setTimeout(() => {
        try {
          p.playVideo()
          ensureLoud(p)
        } catch {
          setNeedsGesture(true)
          awaitFadeInRef.current = false
        }
      }, ios.current ? 150 : 80)

      // loadVideoById re-mutea a veces con delay
      window.setTimeout(() => ensureLoud(playerRef.current), 300)
      window.setTimeout(() => ensureLoud(playerRef.current), 800)
      window.setTimeout(() => {
        if (!playerRef.current) return
        if (awaitFadeInRef.current) {
          awaitFadeInRef.current = false
          startFadeIn()
        } else {
          ensureLoud(playerRef.current)
        }
      }, 2800)
    } catch (e) {
      awaitFadeInRef.current = false
      setStatus(e instanceof Error ? e.message : 'Error al cargar video')
      setNeedsGesture(true)
      setVisualOpacity(1)
      ensureLoud(p)
    }
  }

  function playOrLoad(id: string | null) {
    const p = playerRef.current
    if (!p || !readyRef.current) return

    if (!id) {
      pendingIdRef.current = null
      setIdle(true)
      let state = -1
      try {
        state = p.getPlayerState()
      } catch {
        /* ignore */
      }
      if (state === YT_PLAYING || state === 3) {
        runVisualFade({
          fromOp: 1,
          toOp: 0.06,
          ms: getFadeOutDuration(),
          ease: easeInCubic,
          label: 'Bajando…',
          onDone: () => {
            try {
              p.pauseVideo()
            } catch {
              /* ignore */
            }
          },
        })
      } else {
        try {
          p.pauseVideo()
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
      ensureLoud(p)
      try {
        p.playVideo()
      } catch {
        setNeedsGesture(true)
      }
      setVisualOpacity(1)
      return
    }

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

    const isPlayingNow = state === YT_PLAYING || state === 3

    if (isPlayingNow && loadedRef.current) {
      pendingIdRef.current = id
      // Solo fade VISUAL — el audio sigue hasta el load (corte breve bajo negro)
      runVisualFade({
        fromOp: 1,
        toOp: 0.04,
        ms: getFadeOutDuration(),
        ease: easeInCubic,
        label: ios.current ? 'Mezclando…' : 'Mezclando…',
        onDone: () => {
          const target = pendingIdRef.current || id
          pendingIdRef.current = null
          window.setTimeout(() => {
            doLoadVideo(target)
          }, BLACK_HOLD_MS)
        },
      })
      return
    }

    pendingIdRef.current = null
    setVisualOpacity(0.12)
    doLoadVideo(id)
  }

  function startExternalFadeOut(ms: number) {
    const p = playerRef.current
    if (!p || fadingRef.current) return

    try {
      ensureLoud(p)
      p.playVideo()
    } catch {
      /* ignore */
    }

    runVisualFade({
      fromOp: 1,
      toOp: 0.04,
      ms: ios.current ? Math.max(ms, IOS_FADE_OUT_MS) : ms,
      ease: easeInCubic,
      label: 'La sala pidió cambio…',
      onDone: () => {
        try {
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
      host.setAttribute('playsinline', 'true')
      host.setAttribute('webkit-playsinline', 'true')
      wrap.appendChild(host)
      hostRef.current = host

      playerRef.current = new window.YT.Player(host, {
        width: '100%',
        height: '100%',
        videoId: firstId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          // mute inicial SOLO para pasar autoplay; tras gesto → unMute siempre
          mute: 1,
          fs: 0,
          iv_load_policy: 3,
          cc_load_policy: 0,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: { target: YTPlayer }) => {
            readyRef.current = true
            playerRef.current = event.target
            creatingRef.current = false
            loadedRef.current = firstId
            lastLegalTimeRef.current = 0
            try {
              // Primer arranque: mute por política; volumen API a 100 por si desmutea
              event.target.mute()
              event.target.setVolume(100)
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
              }, ios.current ? 2800 : 2200)
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

              // SIEMPRE re-aplicar audio si ya hubo gesto (loadVideoById re-mutea)
              ensureLoud(event.target)

              if (awaitFadeInRef.current) {
                awaitFadeInRef.current = false
                startFadeIn()
              } else if (!fadingRef.current) {
                setVisualOpacity(1)
                ensureLoud(event.target)
              }
            }
            if (event.data === YT_PAUSED && !fadingRef.current) {
              if (Date.now() < ignoreEndedUntil.current) return
              if (desiredRef.current && unlockedRef.current) {
                window.setTimeout(() => {
                  try {
                    if (
                      playerRef.current?.getPlayerState() === YT_PAUSED &&
                      !fadingRef.current
                    ) {
                      playerRef.current.playVideo()
                      ensureLoud(playerRef.current)
                    }
                  } catch {
                    /* ignore */
                  }
                }, 200)
              }
            }
            if (event.data === YT_ENDED && !fadingRef.current) {
              if (Date.now() < ignoreEndedUntil.current) return
              if (finishedRef.current) return
              finishedRef.current = true
              ensureLoud(event.target)
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
            setVisualOpacity(1)
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
      if (seekGuardTimer.current != null) {
        window.clearInterval(seekGuardTimer.current)
        seekGuardTimer.current = null
      }
      if (audioWatchdog.current != null) {
        window.clearInterval(audioWatchdog.current)
        audioWatchdog.current = null
      }
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

  // Watchdog: cada 2s, si estamos unlocked y playing → unMute + vol 100
  useEffect(() => {
    if (audioWatchdog.current != null) {
      window.clearInterval(audioWatchdog.current)
    }
    audioWatchdog.current = window.setInterval(() => {
      const p = playerRef.current
      if (!p || !readyRef.current || !unlockedRef.current) return
      if (fadingRef.current) return
      try {
        const st = p.getPlayerState()
        if (st === YT_PLAYING || st === 3) {
          if (p.isMuted()) p.unMute()
          try {
            if (p.getVolume() < 80) p.setVolume(100)
          } catch {
            p.setVolume(100)
          }
        }
      } catch {
        /* ignore */
      }
    }, 2000)
    return () => {
      if (audioWatchdog.current != null) {
        window.clearInterval(audioWatchdog.current)
        audioWatchdog.current = null
      }
    }
  }, [])

  // Anti-seek
  useEffect(() => {
    if (seekGuardTimer.current != null) {
      window.clearInterval(seekGuardTimer.current)
    }
    seekGuardTimer.current = window.setInterval(() => {
      const p = playerRef.current
      if (!p || !readyRef.current || fadingRef.current) return
      if (Date.now() < ignoreEndedUntil.current) return
      try {
        const st = p.getPlayerState()
        if (st !== YT_PLAYING && st !== 3) return
        const t = p.getCurrentTime()
        if (typeof t !== 'number' || Number.isNaN(t)) return
        const last = lastLegalTimeRef.current
        if (last > 0.5 && Math.abs(t - last) > 1.8) {
          p.seekTo(last, true)
          return
        }
        if (t >= last - 0.25) lastLegalTimeRef.current = t
      } catch {
        /* ignore */
      }
    }, 400)
    return () => {
      if (seekGuardTimer.current != null) {
        window.clearInterval(seekGuardTimer.current)
        seekGuardTimer.current = null
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
      ensureLoud(p)
      const want = desiredRef.current
      if (want) {
        if (loadedRef.current !== want) {
          setVisualOpacity(0.1)
          doLoadVideo(want)
        } else {
          p.playVideo()
          ensureLoud(p)
          setVisualOpacity(1)
        }
      } else {
        p.playVideo()
        ensureLoud(p)
      }
      // Refuerzo tras el gesto (iOS a veces tarda un frame)
      window.setTimeout(() => ensureLoud(playerRef.current), 100)
      window.setTimeout(() => ensureLoud(playerRef.current), 500)
      window.setTimeout(() => ensureLoud(playerRef.current), 1500)
      setNeedsGesture(false)
      setStatus(null)
    } catch {
      setStatus('No se pudo iniciar. Vuelve a tocar la pantalla.')
    }
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black select-none">
      <div
        ref={wrapRef}
        className="absolute inset-0 h-full w-full will-change-[opacity] pointer-events-none"
        style={{
          opacity: visualOpacity,
          transition: fading ? 'none' : 'opacity 0.25s ease-out',
          WebkitTransform: 'translateZ(0)',
          transform: 'translateZ(0)',
        }}
      />

      {!needsGesture && (
        <div
          className="absolute inset-0 z-[8] cursor-default"
          aria-hidden
          onContextMenu={(e) => e.preventDefault()}
        />
      )}

      {title ? (
        <span className="sr-only">Reproduciendo: {title}</span>
      ) : null}

      {status && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[25] bg-emerald-950/90 px-4 py-2 text-center text-sm text-emerald-100">
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
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-end bg-gradient-to-t from-black via-black/55 to-transparent pb-10">
          <p className="text-sm font-medium tracking-wide text-zinc-100">
            {fadeLabel}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Transición visual · audio al máximo
          </p>
          <div className="mt-3 h-1 w-44 overflow-hidden rounded-full bg-zinc-800">
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
          <span className="rounded-full bg-emerald-600 px-8 py-4 text-lg font-semibold shadow-lg hover:bg-emerald-500 active:scale-[0.98]">
            ▶ Toca para activar sonido
            {iosMode ? ' (iPhone / iPad)' : ''}
          </span>
        </button>
      )}
    </div>
  )
}
