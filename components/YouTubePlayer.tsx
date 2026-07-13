'use client'

/**
 * YouTube TV player v2.8 — AUTOPLAY primero.
 *
 * Estrategia (fiable en Chrome TV):
 * 1) Cada canción = iframe NUEVO con autoplay=1&mute=1 (Chrome siempre permite).
 * 2) Al entrar en PLAYING → unMute + setVolume(100) automático.
 * 3) Watchdog: si hay videoId y no está playing → playVideo() cada 1.2s.
 * 4) Voto negativo → fade volumen 100→0 + opacidad → avanza cola →
 *    siguiente canción autoplay (nuevo iframe).
 * 5) Botón ▶ solo si tras varios reintentos el browser bloquea del todo.
 */

import Script from 'next/script'
import { useEffect, useId, useRef, useState } from 'react'

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: string | HTMLElement,
        config?: Record<string, unknown>
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
const YT_BUFFERING = 3
const YT_CUED = 5

const DEFAULT_VOTE_FADE_MS = 4200

function buildEmbedSrc(videoId: string): string {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : ''
  const q = new URLSearchParams({
    enablejsapi: '1',
    autoplay: '1',
    mute: '1',
    playsinline: '1',
    controls: '0',
    disablekb: '1',
    rel: '0',
    modestbranding: '1',
    fs: '0',
    iv_load_policy: '3',
    cc_load_policy: '0',
  })
  if (origin) q.set('origin', origin)
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${q}`
}

function loadYouTubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.YT?.Player) return Promise.resolve()

  return new Promise((resolve) => {
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
    }, 20000)
  })
}

function easeInCubic(t: number) {
  return t * t * t
}

export default function YouTubePlayer({
  videoId,
  title,
  onEnded,
  onFadeComplete,
  onError,
  fadeOutKey = null,
  fadeOutMs = DEFAULT_VOTE_FADE_MS,
}: Props) {
  const reactId = useId().replace(/:/g, '')
  const mountRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const readyRef = useRef(false)
  const activeIdRef = useRef<string | null>(null)
  const desiredIdRef = useRef<string | null>(null)
  const genRef = useRef(0)
  const finishedRef = useRef(false)
  const fadingRef = useRef(false)
  const lastFadeKey = useRef<string | number | null>(null)
  const fadeRaf = useRef<number | null>(null)
  const ignoreEndedUntil = useRef(0)
  const failPlayCount = useRef(0)
  const mountedAt = useRef(0)

  const onEndedRef = useRef(onEnded)
  const onFadeCompleteRef = useRef(onFadeComplete)
  const onErrorRef = useRef(onError)
  onEndedRef.current = onEnded
  onFadeCompleteRef.current = onFadeComplete
  onErrorRef.current = onError

  const [needsPlay, setNeedsPlay] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [opacity, setOpacity] = useState(1)
  const [fading, setFading] = useState(false)
  const [fadeProgress, setFadeProgress] = useState(0)

  desiredIdRef.current = videoId?.trim() || null

  function cancelFade() {
    if (fadeRaf.current != null) {
      cancelAnimationFrame(fadeRaf.current)
      fadeRaf.current = null
    }
  }

  function destroyPlayer() {
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
    if (mountRef.current) {
      mountRef.current.innerHTML = ''
    }
  }

  /** unMute + vol 100 — se llama en PLAYING y en watchdog */
  function forceLoud(p: YTPlayer | null | undefined) {
    if (!p || fadingRef.current) return
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

  function safeSetVolume(p: YTPlayer, vol: number) {
    try {
      p.setVolume(Math.max(0, Math.min(100, Math.round(vol))))
    } catch {
      /* ignore */
    }
  }

  function tryPlay(p: YTPlayer | null | undefined) {
    if (!p || fadingRef.current) return
    try {
      p.playVideo()
      forceLoud(p)
    } catch {
      /* ignore */
    }
  }

  /**
   * Fade volumen real (voto negativo) → luego onFadeComplete.
   * No dejamos el player “muerto”: el siguiente mount es autoplay limpio.
   */
  function startVolumeFadeOut(durationMs: number) {
    const player = playerRef.current
    if (!player || fadingRef.current || finishedRef.current) return

    fadingRef.current = true
    setFading(true)
    setFadeProgress(0)
    setNeedsPlay(false)
    cancelFade()

    let startVol = 100
    try {
      player.unMute()
      player.playVideo()
      const g = player.getVolume()
      if (typeof g === 'number' && g > 0) startVol = g
      player.setVolume(startVol)
    } catch {
      startVol = 100
    }

    const ms = Math.max(1200, durationMs)
    const t0 = performance.now()

    const tick = (now: number) => {
      const raw = Math.min(1, (now - t0) / ms)
      const eased = easeInCubic(raw)
      safeSetVolume(player, startVol * (1 - eased))
      setOpacity(1 - eased * 0.92)
      setFadeProgress(Math.round(raw * 100))

      if (raw < 1) {
        fadeRaf.current = requestAnimationFrame(tick)
        return
      }

      safeSetVolume(player, 0)
      try {
        player.pauseVideo()
      } catch {
        /* ignore */
      }

      // fadingRef se mantiene true hasta que monte la siguiente canción
      setFadeProgress(100)
      finishedRef.current = true
      ;(onFadeCompleteRef.current ?? onEndedRef.current)()
    }

    fadeRaf.current = requestAnimationFrame(tick)
  }

  async function mountAutoplay(id: string) {
    const mount = mountRef.current
    if (!mount || !id) return

    const gen = ++genRef.current
    mountedAt.current = Date.now()
    failPlayCount.current = 0
    finishedRef.current = false
    fadingRef.current = false
    cancelFade()
    setFading(false)
    setFadeProgress(0)
    setOpacity(1)
    setStatus(null)
    setNeedsPlay(false)
    activeIdRef.current = id
    readyRef.current = false
    ignoreEndedUntil.current = Date.now() + 2800

    destroyPlayer()

    await loadYouTubeApi()
    if (gen !== genRef.current) return
    if (!window.YT?.Player) {
      setStatus('No se pudo cargar YouTube')
      setNeedsPlay(true)
      return
    }
    if (desiredIdRef.current !== id || gen !== genRef.current) return

    const iframe = document.createElement('iframe')
    iframe.id = `yt-${reactId}-${gen}`
    iframe.title = title || 'YouTube'
    iframe.allow =
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
    iframe.setAttribute('allowfullscreen', 'true')
    iframe.setAttribute('playsinline', 'true')
    iframe.referrerPolicy = 'strict-origin-when-cross-origin'
    iframe.style.cssText =
      'border:0;width:100%;height:100%;position:absolute;inset:0;pointer-events:none'
    // SIEMPRE autoplay muteado → arranca solo en Chrome
    iframe.src = buildEmbedSrc(id)
    mount.appendChild(iframe)

    try {
      const player = new window.YT.Player(iframe, {
        events: {
          onReady: (event: { target: YTPlayer }) => {
            if (gen !== genRef.current) return
            playerRef.current = event.target
            readyRef.current = true
            try {
              // Mute + play = autoplay garantizado
              event.target.mute()
              event.target.setVolume(100)
              event.target.playVideo()
            } catch {
              /* watchdog reintenta */
            }
            // Intentos extra de autoplay
            window.setTimeout(() => tryPlay(event.target), 200)
            window.setTimeout(() => {
              tryPlay(event.target)
              forceLoud(event.target)
            }, 600)
            window.setTimeout(() => forceLoud(event.target), 1400)
          },
          onStateChange: (event: { data: number; target: YTPlayer }) => {
            if (gen !== genRef.current) return

            if (
              event.data === YT_PLAYING ||
              event.data === YT_BUFFERING
            ) {
              if (fadingRef.current) return
              failPlayCount.current = 0
              setNeedsPlay(false)
              setStatus(null)
              setOpacity(1)
              // Autoplay con sonido en cuanto arranca
              forceLoud(event.target)
              window.setTimeout(() => {
                if (gen === genRef.current && !fadingRef.current) {
                  forceLoud(event.target)
                }
              }, 400)
              window.setTimeout(() => {
                if (gen === genRef.current && !fadingRef.current) {
                  forceLoud(event.target)
                }
              }, 1200)
            }

            // Si queda en pause/cued sin fade → re-play (autoplay agresivo)
            if (
              (event.data === YT_PAUSED || event.data === YT_CUED) &&
              !fadingRef.current &&
              desiredIdRef.current === id
            ) {
              if (Date.now() < ignoreEndedUntil.current) return
              window.setTimeout(() => {
                if (gen !== genRef.current || fadingRef.current) return
                tryPlay(playerRef.current)
              }, 250)
            }

            if (event.data === YT_ENDED && !fadingRef.current) {
              if (Date.now() < ignoreEndedUntil.current) return
              if (finishedRef.current) return
              finishedRef.current = true
              onEndedRef.current()
            }
          },
          onError: (event: { data: number }) => {
            if (gen !== genRef.current) return
            const code = event.data
            const hints: Record<number, string> = {
              2: 'ID inválido',
              5: 'Error HTML5',
              100: 'Video no encontrado',
              101: 'No permite embeber',
              150: 'No permite embeber',
              153: 'YouTube bloqueó embed',
            }
            setStatus(hints[code] || `Error YouTube (${code})`)
            onErrorRef.current?.(code)
          },
        },
      })
      if (gen === genRef.current) playerRef.current = player
    } catch (e) {
      if (gen === genRef.current) {
        setStatus(e instanceof Error ? e.message : 'Error del player')
        setNeedsPlay(true)
      }
    }
  }

  // Nueva canción → siempre autoplay (iframe fresco)
  useEffect(() => {
    const id = videoId?.trim() || null
    desiredIdRef.current = id

    if (!id) {
      // No destruir al instante (evita parpadeo entre advances)
      const t = window.setTimeout(() => {
        if (!desiredIdRef.current) {
          destroyPlayer()
          activeIdRef.current = null
          setNeedsPlay(false)
          setStatus(null)
          setOpacity(1)
          setFading(false)
          fadingRef.current = false
        }
      }, 400)
      return () => window.clearTimeout(t)
    }

    if (id === activeIdRef.current && playerRef.current && readyRef.current) {
      // Mismo tema: asegurar que siga en autoplay
      tryPlay(playerRef.current)
      return
    }

    void mountAutoplay(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  useEffect(() => {
    return () => destroyPlayer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Voto negativo → bajar volumen y terminar
  useEffect(() => {
    if (fadeOutKey == null || fadeOutKey === '') return
    if (lastFadeKey.current === fadeOutKey) return
    lastFadeKey.current = fadeOutKey
    const t = window.setTimeout(() => startVolumeFadeOut(fadeOutMs), 50)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeOutKey, fadeOutMs])

  /**
   * Watchdog AUTOPLAY (corazón del jukebox):
   * - Si hay canción deseada y no está playing → playVideo
   * - Si playing → forceLoud (vol 100)
   * - Solo muestra botón tras muchos fallos
   */
  useEffect(() => {
    const t = window.setInterval(() => {
      const want = desiredIdRef.current
      if (!want || fadingRef.current) return

      const p = playerRef.current
      if (!p || !readyRef.current) {
        // Player no listo: si pasó mucho, re-montar
        if (want && Date.now() - mountedAt.current > 6000 && !playerRef.current) {
          void mountAutoplay(want)
        }
        return
      }

      try {
        const st = p.getPlayerState()
        if (st === YT_PLAYING || st === YT_BUFFERING) {
          forceLoud(p)
          failPlayCount.current = 0
          if (needsPlay) setNeedsPlay(false)
          return
        }

        // ENDED lo maneja onStateChange; no re-play
        if (st === YT_ENDED) return

        // Auto-reintento de play
        p.playVideo()
        forceLoud(p)
        failPlayCount.current += 1

        // Tras ~8s de fallos, botón de emergencia
        if (failPlayCount.current >= 6) {
          setNeedsPlay(true)
        }
      } catch {
        failPlayCount.current += 1
        if (failPlayCount.current >= 6) setNeedsPlay(true)
      }
    }, 1200)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPlay])

  /** Fallback manual (gesto) — solo si el watchdog no pudo */
  function handlePlayClick() {
    const id = (videoId?.trim() || desiredIdRef.current || '').trim()
    if (!id) return

    setNeedsPlay(false)
    failPlayCount.current = 0
    finishedRef.current = false
    fadingRef.current = false

    const p = playerRef.current
    if (p && readyRef.current) {
      try {
        p.unMute()
        p.setVolume(100)
        p.playVideo()
        forceLoud(p)
        return
      } catch {
        /* remount */
      }
    }
    void mountAutoplay(id)
    // Tras mount, unMute en el gesto ya pasó; watchdog + PLAYING forceLoud
    window.setTimeout(() => forceLoud(playerRef.current), 500)
    window.setTimeout(() => forceLoud(playerRef.current), 1500)
  }

  const hasVideo = Boolean(videoId?.trim())

  return (
    <div className="relative h-full w-full overflow-hidden bg-black select-none">
      <Script
        src="https://www.youtube.com/iframe_api"
        strategy="afterInteractive"
      />

      <div
        ref={mountRef}
        className="absolute inset-0 h-full w-full"
        style={{
          opacity,
          transition: fading ? 'none' : 'opacity 0.2s ease-out',
        }}
      />

      {!needsPlay && (
        <div
          className="absolute inset-0 z-[8]"
          aria-hidden
          onContextMenu={(e) => e.preventDefault()}
        />
      )}

      {title ? (
        <span className="sr-only">Reproduciendo: {title}</span>
      ) : null}

      {status && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[30] bg-amber-950/95 px-4 py-2 text-center text-sm text-amber-100">
          {status}
        </div>
      )}

      {!hasVideo && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center bg-black/80 p-6 text-center">
          <p className="text-xl text-zinc-400">Esperando canciones…</p>
          <p className="mt-2 text-sm text-emerald-500/80">
            Autoplay activo · catálogo o pedidos
          </p>
        </div>
      )}

      {fading && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-end bg-gradient-to-t from-black via-black/50 to-transparent pb-10">
          <p className="text-sm font-medium text-zinc-100">
            La sala pidió cambio…
          </p>
          <p className="mt-1 text-xs text-zinc-400">Bajando volumen</p>
          <div className="mt-3 h-1 w-44 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${fadeProgress}%` }}
            />
          </div>
        </div>
      )}

      {hasVideo && needsPlay && !fading && (
        <button
          type="button"
          onClick={handlePlayClick}
          className="absolute inset-0 z-[40] flex items-center justify-center bg-black/70 text-white"
        >
          <span className="rounded-full bg-emerald-600 px-10 py-5 text-xl font-bold shadow-xl hover:bg-emerald-500">
            ▶ Continuar autoplay
          </span>
        </button>
      )}
    </div>
  )
}
