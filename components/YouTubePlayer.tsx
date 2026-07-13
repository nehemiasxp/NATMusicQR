'use client'

/**
 * YouTube TV player v2.7.1
 *
 * - Autoplay: primera canción mute→play→unMute; siguientes con loadVideoById
 *   (sin botón, sin recrear iframe).
 * - Voto negativo: fade de VOLUMEN real 100→0 + opacidad, luego avanza cola.
 * - Siguiente canción autoplay a volumen 100 otra vez.
 * - Botón ▶ solo si el navegador bloquea el arranque (fallback).
 *
 * https://developers.google.com/youtube/iframe_api_reference
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
const YT_BUFFERING = 3

const DEFAULT_VOTE_FADE_MS = 4200
const SESSION_KEY = 'natmusicqr-yt-audio-ok'

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

function sessionAudioOk(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1'
  } catch {
    return false
  }
}

function markSessionAudioOk() {
  try {
    sessionStorage.setItem(SESSION_KEY, '1')
  } catch {
    /* ignore */
  }
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
  const genRef = useRef(0)
  const finishedRef = useRef(false)
  const fadingRef = useRef(false)
  const lastFadeKey = useRef<string | number | null>(null)
  const kickTimer = useRef<number | null>(null)
  const fadeRaf = useRef<number | null>(null)
  const ignoreEndedUntil = useRef(0)
  /** Tras primer play con audio, las siguientes van en autoplay sin botón */
  const audioUnlockedRef = useRef(false)

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
  const [apiReady, setApiReady] = useState(false)

  useEffect(() => {
    if (sessionAudioOk()) audioUnlockedRef.current = true
  }, [])

  function clearKick() {
    if (kickTimer.current != null) {
      window.clearTimeout(kickTimer.current)
      kickTimer.current = null
    }
  }

  function cancelFade() {
    if (fadeRaf.current != null) {
      cancelAnimationFrame(fadeRaf.current)
      fadeRaf.current = null
    }
  }

  function destroyPlayer() {
    clearKick()
    cancelFade()
    fadingRef.current = false
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

  function scheduleKick(target: YTPlayer) {
    clearKick()
    // Si ya hubo audio en la sesión, no molestar con botón salvo fallo real
    const delay = audioUnlockedRef.current ? 4000 : 2500
    kickTimer.current = window.setTimeout(() => {
      if (fadingRef.current) return
      try {
        const st = target.getPlayerState()
        if (st !== YT_PLAYING && st !== YT_BUFFERING) {
          setNeedsPlay(true)
        }
      } catch {
        if (!audioUnlockedRef.current) setNeedsPlay(true)
      }
    }, delay)
  }

  /** Volumen al 100% + unMute (autoplay con sonido cuando Chrome lo permite) */
  function forceLoud(p: YTPlayer | null | undefined) {
    if (!p || fadingRef.current) return
    try {
      p.unMute()
      p.setVolume(100)
      audioUnlockedRef.current = true
      markSessionAudioOk()
    } catch {
      try {
        p.unMute()
      } catch {
        /* ignore */
      }
    }
  }

  function safeSetVolume(p: YTPlayer, vol: number) {
    const v = Math.max(0, Math.min(100, Math.round(vol)))
    try {
      p.setVolume(v)
    } catch {
      /* ignore */
    }
  }

  /**
   * Fade de volumen real al votar negativo (como v2.1.4).
   * Baja 100→0 con ease-in, oscurece imagen, pausa y avanza cola.
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
      if (typeof g === 'number' && !Number.isNaN(g) && g > 0) startVol = g
      player.setVolume(startVol)
    } catch {
      startVol = 100
    }

    const ms = Math.max(1200, durationMs)
    const t0 = performance.now()

    const tick = (now: number) => {
      const raw = Math.min(1, (now - t0) / ms)
      const eased = easeInCubic(raw)
      const vol = startVol * (1 - eased)
      safeSetVolume(player, vol)
      setOpacity(1 - eased * 0.92)
      setFadeProgress(Math.round(raw * 100))

      if (raw < 1) {
        fadeRaf.current = requestAnimationFrame(tick)
        return
      }

      // Silencio y corte limpio
      safeSetVolume(player, 0)
      try {
        player.mute()
        player.pauseVideo()
      } catch {
        /* ignore */
      }

      fadingRef.current = false
      setFading(false)
      setFadeProgress(100)
      finishedRef.current = true
      ;(onFadeCompleteRef.current ?? onEndedRef.current)()
    }

    fadeRaf.current = requestAnimationFrame(tick)
  }

  /** Carga siguiente tema en el MISMO iframe (autoplay continuo) */
  function loadNextTrack(id: string) {
    const p = playerRef.current
    if (!p || !readyRef.current) return false

    finishedRef.current = false
    fadingRef.current = false
    cancelFade()
    setFading(false)
    setFadeProgress(0)
    setOpacity(1)
    setStatus(null)
    setNeedsPlay(false)
    activeIdRef.current = id
    ignoreEndedUntil.current = Date.now() + 2500

    try {
      // Subir volumen ANTES del load (por si el fade lo dejó en 0)
      p.unMute()
      p.setVolume(100)
      p.loadVideoById({ videoId: id, startSeconds: 0 })
      window.setTimeout(() => {
        try {
          p.playVideo()
          forceLoud(p)
        } catch {
          setNeedsPlay(true)
        }
      }, 100)
      window.setTimeout(() => forceLoud(playerRef.current), 400)
      window.setTimeout(() => forceLoud(playerRef.current), 1200)
      scheduleKick(p)
      return true
    } catch {
      return false
    }
  }

  async function mountEmbed(
    id: string,
    opts: { muteStart: boolean; fromUserGesture: boolean }
  ) {
    const mount = mountRef.current
    if (!mount || !id) return

    const gen = ++genRef.current
    setStatus(null)
    finishedRef.current = false
    fadingRef.current = false
    cancelFade()
    setFading(false)
    setOpacity(1)
    activeIdRef.current = id
    readyRef.current = false

    destroyPlayer()

    await loadYouTubeApi()
    if (gen !== genRef.current) return
    if (!window.YT?.Player) {
      setStatus('No se pudo cargar YouTube. Revisa la red o bloqueadores.')
      setNeedsPlay(true)
      return
    }
    if (activeIdRef.current !== id || gen !== genRef.current) return

    // Si ya hubo audio en la sesión, intentar autoplay con sonido
    const startMuted =
      opts.fromUserGesture ? false : opts.muteStart && !audioUnlockedRef.current

    const iframe = document.createElement('iframe')
    iframe.id = `yt-iframe-${reactId}-${gen}`
    iframe.width = '100%'
    iframe.height = '100%'
    iframe.title = title || 'YouTube'
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
    iframe.style.pointerEvents = 'none'
    iframe.src = buildEmbedSrc(id, {
      autoplay: true,
      mute: startMuted,
    })

    mount.appendChild(iframe)

    try {
      const player = new window.YT.Player(iframe, {
        events: {
          onReady: (event: { target: YTPlayer }) => {
            if (gen !== genRef.current) return
            playerRef.current = event.target
            readyRef.current = true
            try {
              event.target.setVolume(100)
              if (startMuted) {
                event.target.mute()
              } else {
                event.target.unMute()
                event.target.setVolume(100)
              }
              event.target.playVideo()
              if (!startMuted) forceLoud(event.target)
            } catch {
              setNeedsPlay(true)
            }
            scheduleKick(event.target)
          },
          onStateChange: (event: { data: number; target: YTPlayer }) => {
            if (gen !== genRef.current) return

            if (event.data === YT_PLAYING) {
              if (fadingRef.current) return
              setNeedsPlay(false)
              setStatus(null)
              clearKick()
              setOpacity(1)
              // Autoplay con sonido: unMute al reproducir
              forceLoud(event.target)
              window.setTimeout(() => {
                if (gen === genRef.current && !fadingRef.current) {
                  forceLoud(event.target)
                }
              }, 350)
              window.setTimeout(() => {
                if (gen === genRef.current && !fadingRef.current) {
                  forceLoud(event.target)
                }
              }, 1100)
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

  // Cambio de canción: reutilizar player (autoplay) o montar uno nuevo
  useEffect(() => {
    const id = videoId?.trim() || null
    if (!id) {
      destroyPlayer()
      activeIdRef.current = null
      setNeedsPlay(false)
      setStatus(null)
      return
    }

    // Mismo id → no tocar
    if (id === activeIdRef.current && playerRef.current && readyRef.current) {
      return
    }

    // Player listo → loadVideoById (autoplay de la siguiente, sin botón)
    if (playerRef.current && readyRef.current && !fadingRef.current) {
      const ok = loadNextTrack(id)
      if (ok) return
    }

    // Primer boot o falló load → montar iframe
    const muteStart = !audioUnlockedRef.current
    void mountEmbed(id, { muteStart, fromUserGesture: false })

    return () => {
      clearKick()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  useEffect(() => {
    return () => {
      destroyPlayer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Voto negativo / skip de sala → bajar volumen y terminar
  useEffect(() => {
    if (fadeOutKey == null || fadeOutKey === '') return
    if (lastFadeKey.current === fadeOutKey) return
    lastFadeKey.current = fadeOutKey

    const t = window.setTimeout(() => {
      startVolumeFadeOut(fadeOutMs)
    }, 60)

    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeOutKey, fadeOutMs])

  // Watchdog autoplay: si está playing y no en fade → volumen 100
  useEffect(() => {
    const t = window.setInterval(() => {
      const p = playerRef.current
      if (!p || !readyRef.current || fadingRef.current) return
      try {
        const st = p.getPlayerState()
        if (st === YT_PLAYING || st === YT_BUFFERING) {
          forceLoud(p)
        }
      } catch {
        /* ignore */
      }
    }, 2500)
    return () => window.clearInterval(t)
  }, [])

  /** Fallback si el autoplay del browser falla */
  function handlePlayClick() {
    const id = (videoId?.trim() || activeIdRef.current || '').trim()
    if (!id) {
      setStatus('No hay canción en cola')
      return
    }

    setNeedsPlay(false)
    setStatus(null)
    setOpacity(1)
    finishedRef.current = false
    fadingRef.current = false
    audioUnlockedRef.current = true
    markSessionAudioOk()

    const p = playerRef.current
    if (p && readyRef.current) {
      try {
        p.unMute()
        p.setVolume(100)
        p.playVideo()
        forceLoud(p)
        // Si en 1.5s no suena/play, recrear con mute=0
        window.setTimeout(() => {
          try {
            const st = playerRef.current?.getPlayerState()
            if (st !== YT_PLAYING && st !== YT_BUFFERING) {
              void mountEmbed(id, { muteStart: false, fromUserGesture: true })
            }
          } catch {
            void mountEmbed(id, { muteStart: false, fromUserGesture: true })
          }
        }, 1500)
        return
      } catch {
        /* fall through */
      }
    }

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

      <div
        ref={mountRef}
        className="absolute inset-0 h-full w-full"
        style={{
          opacity,
          transition: fading ? 'none' : 'opacity 0.25s ease-out',
        }}
      />

      {/* Capa para no interactuar con el iframe TV (salvo botón play) */}
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
          <p className="mt-2 text-sm text-zinc-600">Autoplay al llegar el pedido</p>
        </div>
      )}

      {fading && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-end bg-gradient-to-t from-black via-black/50 to-transparent pb-10">
          <p className="text-sm font-medium tracking-wide text-zinc-100">
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
          <span className="flex flex-col items-center gap-3 px-6 text-center">
            <span className="rounded-full bg-emerald-600 px-10 py-5 text-xl font-bold shadow-xl hover:bg-emerald-500 active:scale-[0.98]">
              ▶ Iniciar autoplay
            </span>
            <span className="max-w-sm text-sm text-zinc-300">
              Solo la primera vez en esta pestaña
              {apiReady ? '' : ' · cargando YouTube…'}
            </span>
          </span>
        </button>
      )}
    </div>
  )
}
