'use client'

/**
 * YouTube IFrame API — playlist + fade DJ, compatible iOS Safari 2025–2026.
 *
 * iOS limita setVolume() en embeds (a menudo no hace nada). Estrategia:
 * - Siempre: fade VISUAL (opacidad CSS) — funciona en todos los navegadores
 * - Desktop: además fade de volumen vía setVolume
 * - iOS: no confiar en setVolume; transición en negro + loadVideoById
 * - Nunca destroy/remount al cambiar tema (rompe el gesto iOS)
 * - playsinline + mute inicial + un solo unlock por gesto
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

/** Desktop: volumen + visual */
const DESKTOP_FADE_OUT_MS = 1600
const DESKTOP_FADE_IN_MS = 1400
/** iOS: solo visual (más largo = más “DJ”) */
const IOS_FADE_OUT_MS = 1800
const IOS_FADE_IN_MS = 1600
const IOS_BLACK_HOLD_MS = 220
const DEFAULT_VOTE_FADE_MS = 4200

let apiPromise: Promise<void> | null = null

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  // iPhone / iPod / iPad clásico
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS “desktop” UA (Mac + touch)
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
  const volumeWorksRef = useRef(false)
  const volumeProbedRef = useRef(false)

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
  const [iosMode, setIosMode] = useState(false)

  desiredRef.current = videoId?.trim() || null

  useEffect(() => {
    ios.current = isIOSDevice()
    setIosMode(ios.current)
  }, [])

  function fadeOutMs() {
    if (crossfadeMs != null) return crossfadeMs
    return ios.current ? IOS_FADE_OUT_MS : DESKTOP_FADE_OUT_MS
  }

  function fadeInMs() {
    return ios.current ? IOS_FADE_IN_MS : DESKTOP_FADE_IN_MS
  }

  function cancelFade() {
    if (fadeRaf.current != null) {
      cancelAnimationFrame(fadeRaf.current)
      fadeRaf.current = null
    }
  }

  /** Prueba si setVolume realmente mueve el volumen (en iOS suele fallar) */
  function probeVolume(p: YTPlayer) {
    if (volumeProbedRef.current) return
    volumeProbedRef.current = true
    if (ios.current) {
      // En iOS casi nunca controla el hardware; no confiar
      volumeWorksRef.current = false
      return
    }
    try {
      const before = p.getVolume()
      p.setVolume(before > 50 ? 30 : 70)
      const after = p.getVolume()
      p.setVolume(typeof before === 'number' ? before : 100)
      volumeWorksRef.current = Math.abs(after - (before > 50 ? 30 : 70)) < 15
    } catch {
      volumeWorksRef.current = false
    }
  }

  function setVolSafe(p: YTPlayer, v: number) {
    if (!volumeWorksRef.current && ios.current) return
    try {
      p.setVolume(Math.max(0, Math.min(100, Math.round(v))))
    } catch {
      /* ignore */
    }
  }

  function restoreAudio(p: YTPlayer) {
    try {
      if (unlockedRef.current) {
        p.unMute()
        if (volumeWorksRef.current) p.setVolume(100)
      }
      setNeedsGesture(false)
    } catch {
      /* iOS */
    }
  }

  /**
   * Animación principal: siempre visual.
   * Volumen solo si el API responde (desktop).
   */
  function runDjFade(opts: {
    fromVol: number
    toVol: number
    fromOp: number
    toOp: number
    ms: number
    ease: (t: number) => number
    label: string
    onDone: () => void
  }) {
    const p = playerRef.current
    cancelFade()
    fadingRef.current = true
    setFading(true)
    setFadeLabel(opts.label)
    setFadeProgress(0)

    const useVol = Boolean(p && volumeWorksRef.current && unlockedRef.current)
    const t0 = performance.now()

    const tick = (now: number) => {
      const raw = Math.min(1, (now - t0) / opts.ms)
      const e = opts.ease(raw)
      const op = opts.fromOp + (opts.toOp - opts.fromOp) * e
      setVisualOpacity(op)
      if (useVol && p) {
        const vol = opts.fromVol + (opts.toVol - opts.fromVol) * e
        setVolSafe(p, vol)
      }
      setFadeProgress(Math.round(raw * 100))
      if (raw < 1) {
        fadeRaf.current = requestAnimationFrame(tick)
        return
      }
      setVisualOpacity(opts.toOp)
      if (useVol && p) setVolSafe(p, opts.toVol)
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

    const ms = fadeInMs()

    try {
      // iOS: mantener estado de unlock; no re-mute si ya desbloqueó
      if (unlockedRef.current) {
        p.unMute()
        if (volumeWorksRef.current) p.setVolume(0)
      } else {
        p.mute()
      }
      p.playVideo()
    } catch {
      setNeedsGesture(true)
      setVisualOpacity(1)
      return
    }

    // Fade-in visual siempre; volumen solo si funciona
    runDjFade({
      fromVol: 0,
      toVol: 100,
      fromOp: Math.min(visualOpacity, 0.2),
      toOp: 1,
      ms,
      ease: easeOutCubic,
      label: ios.current ? 'Entrando…' : 'Subiendo…',
      onDone: () => {
        setVisualOpacity(1)
        if (unlockedRef.current) restoreAudio(p)
      },
    })
  }

  function doLoadVideo(id: string) {
    const p = playerRef.current
    if (!p) return
    ignoreEndedUntil.current = Date.now() + 2000
    finishedRef.current = false
    awaitFadeInRef.current = true
    try {
      // iOS: no stopVideo; loadVideoById mantiene el iframe/sesión
      if (!unlockedRef.current) {
        p.mute()
      } else if (volumeWorksRef.current) {
        p.setVolume(0)
      }
      // En iOS sin volume API: el negro visual ya cubre el corte de audio
      p.loadVideoById({ videoId: id, startSeconds: 0 })
      loadedRef.current = id
      window.setTimeout(() => {
        try {
          p.playVideo()
        } catch {
          setNeedsGesture(true)
          awaitFadeInRef.current = false
        }
      }, ios.current ? 120 : 60)
    } catch (e) {
      awaitFadeInRef.current = false
      setStatus(e instanceof Error ? e.message : 'Error al cargar video')
      setNeedsGesture(true)
      setVisualOpacity(1)
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
        runDjFade({
          fromVol: 100,
          toVol: 0,
          fromOp: 1,
          toOp: 0.08,
          ms: fadeOutMs(),
          ease: easeInCubic,
          label: 'Bajando…',
          onDone: () => {
            try {
              p.pauseVideo()
              if (!ios.current) p.mute()
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
      if (unlockedRef.current) restoreAudio(p)
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
      // Transición DJ: fade out visual (+ vol si se puede) → negro → load → fade in
      pendingIdRef.current = id
      let startVol = 100
      try {
        if (volumeWorksRef.current) {
          const g = p.getVolume()
          if (typeof g === 'number' && g > 0) startVol = g
        }
      } catch {
        startVol = 100
      }

      runDjFade({
        fromVol: startVol,
        toVol: 0,
        fromOp: 1,
        toOp: 0.05,
        ms: fadeOutMs(),
        ease: easeInCubic,
        label: ios.current ? 'Mezclando (iOS)…' : 'Mezclando…',
        onDone: () => {
          const target = pendingIdRef.current || id
          pendingIdRef.current = null
          // Hold en negro (iOS: da tiempo a cargar el siguiente sin flash)
          window.setTimeout(
            () => {
              doLoadVideo(target)
            },
            ios.current ? IOS_BLACK_HOLD_MS : 80
          )
        },
      })
      return
    }

    // Primer tema / ya en silencio / ended
    pendingIdRef.current = null
    setVisualOpacity(0.15)
    doLoadVideo(id)
  }

  function startExternalFadeOut(ms: number) {
    const p = playerRef.current
    if (!p || fadingRef.current) return

    let startVol = 100
    try {
      if (volumeWorksRef.current) {
        const g = p.getVolume()
        if (typeof g === 'number' && g > 0) startVol = g
      }
      if (unlockedRef.current) p.unMute()
      p.playVideo()
    } catch {
      startVol = 100
    }

    runDjFade({
      fromVol: startVol,
      toVol: 0,
      fromOp: 1,
      toOp: 0.05,
      ms: ios.current ? Math.max(ms, IOS_FADE_OUT_MS) : ms,
      ease: easeInCubic,
      label: 'La sala pidió cambio…',
      onDone: () => {
        try {
          // iOS: pause es más seguro que stopVideo
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
      // Ayuda a Safari a no forzar fullscreen nativo del video
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
          controls: 1,
          rel: 0,
          modestbranding: 1,
          // Crítico iOS / iPadOS
          playsinline: 1,
          // Autoplay inicial solo con mute (política Safari)
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
            probeVolume(event.target)
            try {
              event.target.mute()
              if (volumeWorksRef.current) event.target.setVolume(0)
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
              // iOS a menudo necesita el gesto aunque autoplay mute
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
              if (!volumeProbedRef.current) probeVolume(event.target)

              if (awaitFadeInRef.current) {
                awaitFadeInRef.current = false
                startFadeIn()
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
      // Gesto de usuario: desbloquea audio en iOS (obligatorio Safari)
      unlockedRef.current = true
      p.unMute()
      if (volumeWorksRef.current) p.setVolume(100)
      const want = desiredRef.current
      if (want) {
        if (loadedRef.current !== want) {
          setVisualOpacity(0.1)
          doLoadVideo(want)
        } else {
          p.playVideo()
          setVisualOpacity(1)
        }
      } else {
        p.playVideo()
      }
      setNeedsGesture(false)
      setStatus(null)
    } catch {
      setStatus('No se pudo iniciar. Vuelve a tocar la pantalla.')
    }
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {/*
        El iframe de YT vive aquí. La opacidad la controlamos nosotros
        (fade visual = lo único 100% fiable en iOS).
      */}
      <div
        ref={wrapRef}
        className="absolute inset-0 h-full w-full will-change-[opacity]"
        style={{
          opacity: visualOpacity,
          // En iOS preferimos RAF; sin transition CSS que pelee con RAF
          transition: fading ? 'none' : 'opacity 0.25s ease-out',
          // iOS: evita capas raras del compositor
          WebkitTransform: 'translateZ(0)',
          transform: 'translateZ(0)',
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
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-end bg-gradient-to-t from-black via-black/55 to-transparent pb-10">
          <p className="text-sm font-medium tracking-wide text-zinc-100">
            {fadeLabel}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {iosMode
              ? 'Transición iOS · fade visual'
              : 'Transición suave · DJ mode'}
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
            ▶ Toca para iniciar
            {iosMode ? ' (iPhone / iPad)' : ''}
          </span>
        </button>
      )}
    </div>
  )
}
