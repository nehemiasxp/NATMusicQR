'use client'

/**
 * YouTube TV player — enfoque SIMPLE y fiable (v2.7).
 *
 * Problema: el player “inteligente” (DOM host, overlays, anti-seek, unlock
 * gates) dejó de reproducir y el botón no arrancaba.
 *
 * Solución distinta:
 * 1) iframe manual con allow="autoplay; encrypted-media; …" (Chrome lo exige)
 * 2) YT.Player enganchado a ese iframe
 * 3) Por canción: se recrea el iframe (como el deploy original que sí andaba)
 * 4) Botón play: en el gesto del usuario recarga el embed con mute=0
 *    (Chrome permite sonido si play nace del click)
 * 5) Controles nativos de YouTube visibles como red de seguridad
 *
 * https://developers.google.com/youtube/iframe_api_reference
 * https://developer.chrome.com/blog/autoplay
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
      PlayerState?: Record<string, number>
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
  getIframe?: () => HTMLIFrameElement
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

const DEFAULT_VOTE_FADE_MS = 4000

function buildEmbedSrc(
  videoId: string,
  opts: { autoplay: boolean; mute: boolean }
): string {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : ''
  const q = new URLSearchParams({
    enablejsapi: '1',
    autoplay: opts.autoplay ? '1' : '0',
    mute: opts.mute ? '1' : '0',
    playsinline: '1',
    // Controles ON: si la API falla, el usuario aún puede pulsar ▶ de YouTube
    controls: '1',
    rel: '0',
    modestbranding: '1',
    fs: '1',
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
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const activeIdRef = useRef<string | null>(null)
  /** Generación: evita que un mount async viejo pise al nuevo */
  const genRef = useRef(0)
  const finishedRef = useRef(false)
  const lastFadeKey = useRef<string | number | null>(null)
  const kickTimer = useRef<number | null>(null)
  const fadeTimer = useRef<number | null>(null)

  const onEndedRef = useRef(onEnded)
  const onFadeCompleteRef = useRef(onFadeComplete)
  const onErrorRef = useRef(onError)
  onEndedRef.current = onEnded
  onFadeCompleteRef.current = onFadeComplete
  onErrorRef.current = onError

  const [needsPlay, setNeedsPlay] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [opacity, setOpacity] = useState(1)
  const [apiReady, setApiReady] = useState(false)

  function clearKick() {
    if (kickTimer.current != null) {
      window.clearTimeout(kickTimer.current)
      kickTimer.current = null
    }
  }

  function destroyPlayer() {
    clearKick()
    if (playerRef.current) {
      try {
        playerRef.current.destroy()
      } catch {
        /* ignore */
      }
      playerRef.current = null
    }
    iframeRef.current = null
    if (mountRef.current) {
      mountRef.current.innerHTML = ''
    }
  }

  function scheduleKick(target: YTPlayer) {
    clearKick()
    kickTimer.current = window.setTimeout(() => {
      try {
        const st = target.getPlayerState()
        // No está reproduciendo → mostrar botón grande
        if (st !== YT_PLAYING && st !== 3) {
          setNeedsPlay(true)
        }
      } catch {
        setNeedsPlay(true)
      }
    }, 2200)
  }

  function forceLoud(p: YTPlayer | null | undefined) {
    if (!p) return
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

  /**
   * Monta un iframe NUEVO + YT.Player.
   * muteStart=true → autoplay seguro; muteStart=false → con sonido (gesto usuario).
   */
  async function mountEmbed(
    id: string,
    opts: { muteStart: boolean; fromUserGesture: boolean }
  ) {
    const mount = mountRef.current
    if (!mount || !id) return

    const gen = ++genRef.current
    setStatus(null)
    finishedRef.current = false
    activeIdRef.current = id

    destroyPlayer()

    await loadYouTubeApi()
    if (gen !== genRef.current) return // obsoleto
    if (!window.YT?.Player) {
      setStatus('No se pudo cargar la API de YouTube. Revisa red / bloqueadores.')
      setNeedsPlay(true)
      return
    }
    if (activeIdRef.current !== id || gen !== genRef.current) return

    const iframe = document.createElement('iframe')
    iframe.id = `yt-iframe-${reactId}-${gen}`
    iframe.width = '100%'
    iframe.height = '100%'
    iframe.title = title || 'YouTube'
    // Chrome: sin allow=autoplay el playVideo() del API falla
    iframe.allow =
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
    iframe.setAttribute('allowfullscreen', 'true')
    iframe.setAttribute('playsinline', 'true')
    iframe.referrerPolicy = 'strict-origin-when-cross-origin'
    iframe.style.border = '0'
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.position = 'absolute'
    iframe.style.inset = '0'
    iframe.style.pointerEvents = 'auto'
    iframe.src = buildEmbedSrc(id, {
      autoplay: true,
      mute: opts.muteStart,
    })

    mount.appendChild(iframe)
    iframeRef.current = iframe

    try {
      const player = new window.YT.Player(iframe, {
        events: {
          onReady: (event: { target: YTPlayer }) => {
            if (gen !== genRef.current) return
            playerRef.current = event.target
            try {
              event.target.setVolume(100)
              if (opts.muteStart && !opts.fromUserGesture) {
                event.target.mute()
              } else {
                event.target.unMute()
                event.target.setVolume(100)
              }
              event.target.playVideo()
              if (!opts.muteStart || opts.fromUserGesture) {
                forceLoud(event.target)
              }
            } catch {
              setNeedsPlay(true)
            }
            scheduleKick(event.target)
          },
          onStateChange: (event: { data: number; target: YTPlayer }) => {
            if (gen !== genRef.current) return
            if (event.data === YT_PLAYING) {
              setNeedsPlay(false)
              setStatus(null)
              clearKick()
              forceLoud(event.target)
              window.setTimeout(() => {
                if (gen === genRef.current) forceLoud(event.target)
              }, 300)
              window.setTimeout(() => {
                if (gen === genRef.current) forceLoud(event.target)
              }, 1000)
            }
            if (event.data === YT_ENDED) {
              if (finishedRef.current) return
              finishedRef.current = true
              onEndedRef.current()
            }
          },
          onError: (event: { data: number }) => {
            if (gen !== genRef.current) return
            const code = event.data
            const hints: Record<number, string> = {
              2: 'ID de video inválido',
              5: 'Error HTML5 del player',
              100: 'Video no encontrado o privado',
              101: 'Este video no permite embeber',
              150: 'Este video no permite embeber',
              153: 'YouTube bloqueó el embed (Referer)',
            }
            setStatus(hints[code] || `Error YouTube (${code})`)
            setNeedsPlay(true)
            onErrorRef.current?.(code)
          },
        },
      })
      if (gen === genRef.current) {
        playerRef.current = player
        setApiReady(true)
      }
    } catch (e) {
      if (gen === genRef.current) {
        setStatus(e instanceof Error ? e.message : 'Error creando el player')
        setNeedsPlay(true)
      }
    }
  }

  // Montar / cambiar de canción
  useEffect(() => {
    const id = videoId?.trim() || null
    if (!id) {
      destroyPlayer()
      activeIdRef.current = null
      setNeedsPlay(false)
      setStatus(null)
      return
    }

    // Nueva canción → iframe fresco (fiable)
    setOpacity(1)
    void mountEmbed(id, { muteStart: true, fromUserGesture: false })

    return () => {
      // Solo destruir al desmontar o al cambiar id (cleanup del effect)
      clearKick()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  // Cleanup total al unmount
  useEffect(() => {
    return () => {
      if (fadeTimer.current != null) window.clearTimeout(fadeTimer.current)
      destroyPlayer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fade visual por votos (sin tocar volumen a 0)
  useEffect(() => {
    if (fadeOutKey == null || fadeOutKey === '') return
    if (lastFadeKey.current === fadeOutKey) return
    lastFadeKey.current = fadeOutKey

    setOpacity(1)
    const ms = Math.max(800, fadeOutMs)
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const raw = Math.min(1, (now - t0) / ms)
      setOpacity(1 - raw * 0.95)
      if (raw < 1) {
        raf = requestAnimationFrame(tick)
        return
      }
      try {
        playerRef.current?.pauseVideo()
      } catch {
        /* ignore */
      }
      finishedRef.current = true
      ;(onFadeCompleteRef.current ?? onEndedRef.current)()
    }
    raf = requestAnimationFrame(tick)
    fadeTimer.current = window.setTimeout(() => {
      cancelAnimationFrame(raf)
    }, ms + 500) as unknown as number

    return () => {
      cancelAnimationFrame(raf)
      if (fadeTimer.current != null) {
        window.clearTimeout(fadeTimer.current)
        fadeTimer.current = null
      }
    }
  }, [fadeOutKey, fadeOutMs])

  /**
   * Botón grande — corre DENTRO del gesto del usuario.
   * Estrategia nuclear que sí funciona en Chrome:
   * recrear el embed con mute=0 + autoplay=1 en el mismo click.
   */
  function handlePlayClick() {
    const id = (videoId?.trim() || activeIdRef.current || '').trim()
    if (!id) {
      setStatus('No hay canción en cola para reproducir')
      return
    }

    setNeedsPlay(false)
    setStatus(null)
    setOpacity(1)

    // 1) Intento rápido con player existente
    const p = playerRef.current
    if (p) {
      try {
        p.unMute()
        p.setVolume(100)
        p.playVideo()
      } catch {
        /* recrearemos abajo */
      }
    }

    // 2) Nuclear: nuevo iframe con sonido (permiso del click actual)
    void mountEmbed(id, { muteStart: false, fromUserGesture: true })
  }

  const hasVideo = Boolean(videoId?.trim())

  return (
    <div className="relative h-full w-full overflow-hidden bg-black select-none">
      <Script
        src="https://www.youtube.com/iframe_api"
        strategy="afterInteractive"
        onLoad={() => {
          if (window.YT?.Player) setApiReady(true)
        }}
      />

      {/* Contenedor del iframe — pointer-events ON */}
      <div
        ref={mountRef}
        className="absolute inset-0 h-full w-full"
        style={{
          opacity,
          transition: 'opacity 0.2s ease-out',
        }}
      />

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
        </div>
      )}

      {hasVideo && needsPlay && (
        <button
          type="button"
          onClick={handlePlayClick}
          className="absolute inset-0 z-[40] flex items-center justify-center bg-black/70 text-white"
        >
          <span className="flex flex-col items-center gap-3 px-6 text-center">
            <span className="rounded-full bg-emerald-600 px-10 py-5 text-xl font-bold shadow-xl hover:bg-emerald-500 active:scale-[0.98]">
              ▶ Reproducir
            </span>
            <span className="max-w-sm text-sm text-zinc-300">
              Pulsa para iniciar el video con sonido
              {apiReady ? '' : ' · cargando YouTube…'}
            </span>
          </span>
        </button>
      )}
    </div>
  )
}
