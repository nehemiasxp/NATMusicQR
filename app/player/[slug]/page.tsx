'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import YouTubePlayer from '@/components/YouTubePlayer'
import LiveFeedOverlay from '@/components/LiveFeedOverlay'
import { supabase } from '@/lib/supabase'
import { advanceQueue, ensurePlayingItem, fetchActiveQueue } from '@/lib/queue'
import type { QueueItem, Venue } from '@/lib/types'

const POLL_MS = 1500
/** Versión player — fix hooks + fullscreen stage */
export const PLAYER_UI_VERSION = '2.4.2'

/** Fullscreen API con prefijos webkit (Safari) sin romper tipos */
function getFullscreenElement(): Element | null {
  const doc = document as Document & {
    webkitFullscreenElement?: Element | null
  }
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

async function requestElFullscreen(el: HTMLElement) {
  const node = el as HTMLElement & {
    webkitRequestFullscreen?: () => void
  }
  if (el.requestFullscreen) {
    await el.requestFullscreen()
    return
  }
  if (node.webkitRequestFullscreen) {
    node.webkitRequestFullscreen()
  }
}

async function exitDocFullscreen() {
  const doc = document as Document & {
    webkitExitFullscreen?: () => void
  }
  if (document.exitFullscreen && document.fullscreenElement) {
    await document.exitFullscreen()
    return
  }
  if (doc.webkitExitFullscreen) {
    doc.webkitExitFullscreen()
  }
}

type RuntimeFlags = {
  autoplayEnabled: boolean
  votingEnabled: boolean
  skipThresholdPercent: number
  minVotesToSkip: number
}

export default function PlayerPage() {
  const params = useParams<{ slug: string }>()
  const slug = params?.slug

  const [venue, setVenue] = useState<Venue | null>(null)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [playingItem, setPlayingItem] = useState<QueueItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [liveNote, setLiveNote] = useState<string | null>(null)
  const [playerNote, setPlayerNote] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [voteStats, setVoteStats] = useState<{
    up: number
    down: number
    downPercent: number
  } | null>(null)
  const [autoplayOn, setAutoplayOn] = useState(false)
  /** Dispara fade-out suave en YouTubePlayer antes de saltar por votos */
  const [fadeOutKey, setFadeOutKey] = useState<string | null>(null)
  const [stageFullscreen, setStageFullscreen] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)

  const advancingRef = useRef(false)
  const venueIdRef = useRef<string | null>(null)
  const excludeIdsRef = useRef<Set<string>>(new Set())
  const playingItemRef = useRef<QueueItem | null>(null)
  const rlsLocalRef = useRef(false)
  /** Tras cancel remoto: no rellenar con autoplay hasta que haya un pedido real */
  const suppressAutoplayRef = useRef(false)
  const flagsRef = useRef<RuntimeFlags>({
    autoplayEnabled: false,
    votingEnabled: true,
    skipThresholdPercent: 80,
    minVotesToSkip: 2,
  })

  useEffect(() => {
    playingItemRef.current = playingItem
  }, [playingItem])

  const applyQueueState = useCallback(
    (items: QueueItem[], playing: QueueItem | null) => {
      setQueue(items)
      setPlayingItem(playing)
      setLastSync(new Date().toLocaleTimeString())
    },
    []
  )

  const loadFlags = useCallback(async () => {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' })
      const data = await res.json()
      const on = Boolean(data.autoplayMusic?.enabled)
      flagsRef.current = {
        autoplayEnabled: on,
        votingEnabled: Boolean(data.voting?.enabled),
        skipThresholdPercent: Number(data.voting?.skipThresholdPercent ?? 80),
        minVotesToSkip: Number(data.voting?.minVotesToSkip ?? 2),
      }
      setAutoplayOn(on)
      return on
    } catch {
      return flagsRef.current.autoplayEnabled
    }
  }, [])

  const refreshQueue = useCallback(
    async (venueId: string, opts?: { promote?: boolean }) => {
      if (advancingRef.current) return

      const promote = opts?.promote !== false
      const autoplayEnabled =
        flagsRef.current.autoplayEnabled && !suppressAutoplayRef.current
      const localCurrent = playingItemRef.current

      if (promote) {
        const { items, playing, error: syncError, rlsBlocked } =
          await ensurePlayingItem(venueId, {
            excludeIds: rlsLocalRef.current
              ? excludeIdsRef.current
              : new Set(),
            autoplayEnabled,
          })

        if (rlsBlocked) rlsLocalRef.current = true

        if (syncError && !playing && items.length === 0) {
          console.error('Error sincronizando cola:', syncError)
          setError(syncError.message || 'No se pudo cargar la cola')
          return
        }

        // Si cambió la canción por control remoto, limpiar fade/votos
        if (localCurrent && playing?.id !== localCurrent.id) {
          setFadeOutKey(null)
          setVoteStats(null)
          if (playing) setPlayerNote(null)
        }

        // Pedido real o autoplay OK → permitir autoplay otra vez
        if (playing) suppressAutoplayRef.current = false

        applyQueueState(items, playing)
        if (syncError && !playing) setError(syncError.message)
        else setError(null)
        return
      }

      const { items, error: fetchError } = await fetchActiveQueue(venueId)
      if (fetchError) {
        console.error('Error leyendo cola:', fetchError)
        return
      }

      let list = items
      if (rlsLocalRef.current && excludeIdsRef.current.size > 0) {
        list = items.filter((i) => !excludeIdsRef.current.has(i.id))
      }

      const hasQueued = list.some((i) => i.status === 'queued')
      // Si hay pedidos de mesa, reactivar autoplay para el futuro
      if (hasQueued) suppressAutoplayRef.current = false

      const dbPlaying =
        list.find((i) => i.status === 'playing' && i.videos?.youtube_id) ??
        null

      // Control remoto (mesa i9): la canción local ya no está en playing
      if (localCurrent) {
        const stillMine =
          dbPlaying?.id === localCurrent.id ||
          list.some(
            (i) => i.id === localCurrent.id && i.status === 'playing'
          )

        if (!stillMine) {
          if (rlsLocalRef.current) {
            excludeIdsRef.current.add(localCurrent.id)
          }
          setFadeOutKey(null)
          setVoteStats(null)

          if (dbPlaying) {
            // API ya puso otra en playing (siguiente / autoplay del control)
            suppressAutoplayRef.current = false
            applyQueueState(list, dbPlaying)
            setPlayerNote(null)
            setError(null)
            return
          }

          // Solo promover si hay pedidos en cola (no autoplay tras cancel)
          if (hasQueued) {
            setPlayerNote('Control remoto · pasando a la siguiente…')
            await refreshQueue(venueId, { promote: true })
            return
          }

          // Cola vacía tras cancel: silencio (no rellenar autoplay)
          suppressAutoplayRef.current = true
          applyQueueState(list, null)
          setPlayerNote('Canción cancelada · esperando pedidos')
          setError(null)
          return
        }
      }

      if (dbPlaying) {
        suppressAutoplayRef.current = false
        applyQueueState(list, dbPlaying)
        setError(null)
        return
      }

      if (hasQueued || autoplayEnabled) {
        await refreshQueue(venueId, { promote: true })
        return
      }

      applyQueueState(list, null)
      setError(null)
    },
    [applyQueueState]
  )

  const finishAdvance = useCallback(
    async (asSkip: boolean) => {
      const venueId = venueIdRef.current
      const current = playingItemRef.current
      if (!venueId || !current || advancingRef.current) return

      advancingRef.current = true
      setPlayerNote(
        asSkip
          ? 'Cerrando tema por votos… siguiente'
          : 'Pasando a la siguiente canción…'
      )
      setVoteStats(null)
      setFadeOutKey(null)

      try {
        if (rlsLocalRef.current) {
          excludeIdsRef.current.add(current.id)
        }

        // Fin natural / votos: sí puede usar autoplay
        suppressAutoplayRef.current = false
        const result = await advanceQueue(venueId, current.id, {
          excludeIds: rlsLocalRef.current
            ? excludeIdsRef.current
            : new Set(),
          status: asSkip ? 'skipped' : 'played',
          autoplayEnabled: flagsRef.current.autoplayEnabled,
        })

        if (result.excludeIds && rlsLocalRef.current) {
          excludeIdsRef.current = result.excludeIds
        }
        if (result.rlsBlocked) rlsLocalRef.current = true

        if (result.error && !result.playing && result.items.length === 0) {
          console.error('Error avanzando cola:', result.error)
          setError(result.error.message || 'No se pudo avanzar la cola')
          return
        }

        applyQueueState(result.items, result.playing)
        setPlayerNote(
          result.playing
            ? null
            : flagsRef.current.autoplayEnabled
              ? 'Cola vacía — buscando en catálogo…'
              : 'Cola vacía — esperando pedidos'
        )
      } finally {
        advancingRef.current = false
      }
    },
    [applyQueueState]
  )

  /** Fin natural o error: sin fade (o fade ya terminó). */
  const handleEnded = useCallback(() => {
    void finishAdvance(false)
  }, [finishAdvance])

  /** Tras fade-out por votos */
  const handleFadeOutComplete = useCallback(() => {
    void finishAdvance(true)
  }, [finishAdvance])

  const handlePlayerError = useCallback(
    (code: number) => {
      console.error('Error del reproductor YouTube:', code)
      setPlayerNote(
        `YouTube no pudo reproducir este video (código ${code}). Saltando…`
      )
      window.setTimeout(() => {
        void finishAdvance(false)
      }, 1500)
    },
    [finishAdvance]
  )

  // Poll votos (pedidos + autoplay) → fade suave y salto
  useEffect(() => {
    if (!playingItem?.id) {
      setVoteStats(null)
      return
    }

    let cancelled = false
    const itemId = playingItem.id
    const isAuto =
      playingItem.added_by_table?.includes('Autoplay') ?? false

    async function checkVotes() {
      // Releer flag por si se activó en admin a mitad de tema
      if (!flagsRef.current.votingEnabled) {
        setVoteStats(null)
        return
      }
      try {
        const res = await fetch(
          `/api/votes?queueItemId=${encodeURIComponent(itemId)}`,
          { cache: 'no-store' }
        )
        const data = await res.json()
        if (cancelled || !res.ok) return
        if (data.enabled === false) {
          setVoteStats(null)
          return
        }
        setVoteStats({
          up: data.up ?? 0,
          down: data.down ?? 0,
          downPercent: data.downPercent ?? 0,
        })
        if (
          data.shouldSkip &&
          !advancingRef.current &&
          fadeOutKey !== itemId
        ) {
          setPlayerNote(
            isAuto
              ? 'Autoplay rechazado por la sala… bajando volumen'
              : 'La sala pidió cambio… bajando volumen'
          )
          setFadeOutKey(itemId)
        }
      } catch {
        /* ignore */
      }
    }

    void checkVotes()
    const t = setInterval(checkVotes, 2000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [playingItem?.id, playingItem?.added_by_table, fadeOutKey])

  useEffect(() => {
    if (!slug) return

    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null
    let pollTimer: ReturnType<typeof setInterval> | undefined

    async function init() {
      setLoading(true)
      setError(null)
      await loadFlags()

      const { data: venueData, error: venueError } = await supabase
        .from('venues')
        .select('id, name, slug, description')
        .eq('slug', slug)
        .maybeSingle()

      if (cancelled) return

      if (venueError) {
        setError(venueError.message || 'No se pudo cargar el local')
        setLoading(false)
        return
      }

      if (!venueData) {
        setError(`No existe un local con el slug "${slug}"`)
        setVenue(null)
        setLoading(false)
        return
      }

      const v = venueData as Venue
      setVenue(v)
      venueIdRef.current = v.id

      await refreshQueue(v.id, { promote: true })
      if (!cancelled) setLoading(false)

      pollTimer = setInterval(() => {
        if (!advancingRef.current && venueIdRef.current) {
          void loadFlags()
          void refreshQueue(venueIdRef.current, { promote: false })
        }
      }, POLL_MS)

      channel = supabase
        .channel(`player-queue-${v.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'queue_items',
            filter: `venue_id=eq.${v.id}`,
          },
          () => {
            if (!advancingRef.current) {
              void refreshQueue(v.id, { promote: false })
            }
          }
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setLiveNote('En vivo · Realtime OK')
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setLiveNote('Actualización cada 3s (Realtime off)')
          } else if (status === 'CLOSED') {
            setLiveNote('Actualización cada 3s')
          }
        })
    }

    void init()

    return () => {
      cancelled = true
      if (pollTimer) clearInterval(pollTimer)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [slug, refreshQueue, loadFlags])

  // Hooks SIEMPRE antes de cualquier return (si no, React rompe el player)
  useEffect(() => {
    function onFsChange() {
      const el = stageRef.current
      setStageFullscreen(Boolean(el && getFullscreenElement() === el))
    }
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [])

  const toggleStageFullscreen = useCallback(async () => {
    const el = stageRef.current
    if (!el) return
    try {
      const active = getFullscreenElement() === el
      if (active) {
        await exitDocFullscreen()
      } else {
        await requestElFullscreen(el)
      }
    } catch {
      setPlayerNote(
        'No se pudo poner pantalla completa. Usa F11 o el modo kiosko del navegador.'
      )
    }
  }, [])

  const currentVideo = playingItem?.videos ?? null
  const waiting = queue.filter((i) => i.id !== playingItem?.id)
  const isAutoplay = playingItem?.added_by_table?.includes('Autoplay')
  /** Siguiente YouTube id (prefetch mental / UI) — el iframe NO se recrea */
  const nextYoutubeId =
    waiting.find((i) => i.videos?.youtube_id)?.videos?.youtube_id ?? null

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center text-white">
        Cargando reproductor...
      </div>
    )
  }

  if (error && !venue) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center text-white p-6">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold mb-2">Local no encontrado</h1>
          <p className="text-red-400">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-emerald-400 text-sm tracking-[2px] uppercase">
              {venue?.slug}
            </p>
            <h1 className="text-2xl md:text-3xl font-bold">
              {venue?.name ?? 'NATMusicQR'} — TV
            </h1>
          </div>
          <div className="text-right text-sm text-zinc-400 space-y-0.5">
            <div>
              En cola:{' '}
              <span className="text-white font-medium">{waiting.length}</span>
            </div>
            {liveNote && (
              <div className="text-xs text-emerald-500/80">{liveNote}</div>
            )}
            <div className="text-xs text-zinc-500">
              Autoplay: {autoplayOn ? 'ON' : 'OFF'} · TV v{PLAYER_UI_VERSION} ·
              live
            </div>
            {lastSync && (
              <div className="text-xs text-zinc-600">Sync {lastSync}</div>
            )}
            <button
              type="button"
              onClick={() => {
                void toggleStageFullscreen()
              }}
              className="mt-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:border-emerald-600 hover:text-white"
            >
              {stageFullscreen
                ? '⤓ Salir pantalla completa'
                : '⛶ Pantalla completa (con comentarios)'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-800 bg-red-950/50 px-4 py-3 text-red-300">
            {error}
          </div>
        )}

        {playerNote && (
          <div className="mb-4 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-200">
            {playerNote}
          </div>
        )}

        {/*
          Stage = video + overlay. Fullscreen de ESTE div (no del iframe YT)
          para que comentarios/burbujas sigan visibles.
        */}
        <div
          ref={stageRef}
          className="player-stage relative mb-6 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950"
        >
          <div className="player-stage-video relative aspect-video w-full">
            <YouTubePlayer
              videoId={currentVideo?.youtube_id ?? null}
              title={currentVideo?.title}
              nextVideoId={nextYoutubeId}
              onEnded={handleEnded}
              onFadeComplete={handleFadeOutComplete}
              onError={handlePlayerError}
              fadeOutKey={
                fadeOutKey === playingItem?.id ? fadeOutKey : null
              }
              fadeOutMs={4500}
            />
            {slug && (
              <LiveFeedOverlay
                venueSlug={slug}
                fullscreen={stageFullscreen}
              />
            )}
            {!currentVideo?.youtube_id && (
              <div className="pointer-events-none absolute inset-0 z-[6] flex flex-col items-center justify-center text-center p-6">
                <p className="text-xl text-zinc-400">Esperando canciones…</p>
                <p className="text-sm text-zinc-600 mt-2">
                  Escanea el QR y pide desde /join/{venue?.slug}
                </p>
                {autoplayOn ? (
                  <p className="text-xs text-emerald-500 mt-3">
                    Autoplay ON — buscando canción del catálogo…
                  </p>
                ) : (
                  <p className="text-xs text-zinc-600 mt-3">
                    Autoplay OFF — actívalo en /admin y pulsa Guardar reglas
                  </p>
                )}
              </div>
            )}
          </div>
          {/* Botón FS dentro del stage (también usable en kiosko) */}
          <button
            type="button"
            onClick={() => void toggleStageFullscreen()}
            className="absolute bottom-3 right-3 z-[50] rounded-lg border border-white/20 bg-black/60 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm hover:bg-black/80"
          >
            {stageFullscreen ? 'Salir FS' : 'Pantalla completa'}
          </button>
        </div>

        {currentVideo && (
          <div className="mb-6 rounded-2xl bg-emerald-950/40 border border-emerald-800 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-emerald-400 text-xs tracking-[2px] uppercase">
                  {isAutoplay ? 'Autoplay · catálogo' : 'Reproduciendo ahora'}
                </p>
                <h2 className="text-2xl font-semibold mt-1">
                  {currentVideo.title}
                </h2>
                {currentVideo.artist && (
                  <p className="text-zinc-400 mt-1">{currentVideo.artist}</p>
                )}
                {playingItem?.added_by_table && (
                  <p className="text-sm text-zinc-500 mt-2">
                    {isAutoplay
                      ? playingItem.added_by_table
                      : `Pedido por ${playingItem.added_by_table}`}
                  </p>
                )}
              </div>
              {voteStats && (
                <div className="text-right text-sm">
                  <p className="text-zinc-400">
                    Votos{isAutoplay ? ' · autoplay' : ' · mesa'}
                  </p>
                  <p className="mt-1 text-lg">
                    <span className="text-emerald-400">👍 {voteStats.up}</span>
                    {'  '}
                    <span className="text-red-400">👎 {voteStats.down}</span>
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {voteStats.downPercent}% rechazo (también en autoplay)
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-xl font-semibold mb-4">
            Siguientes ({waiting.length})
          </h3>

          {waiting.length > 0 ? (
            <div className="space-y-2">
              {waiting.map((item, index) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-4 rounded-xl bg-zinc-900"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <span className="text-2xl font-mono text-zinc-500 w-8 shrink-0">
                      {index + 1}
                    </span>
                    {item.videos?.thumbnail_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.videos.thumbnail_url}
                        alt=""
                        className="w-16 h-10 object-cover rounded"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {item.videos?.title ?? 'Video sin título'}
                      </p>
                      <div className="flex flex-wrap gap-x-2 text-sm text-zinc-400">
                        {item.videos?.artist && (
                          <span className="truncate">{item.videos.artist}</span>
                        )}
                        {item.added_by_table && (
                          <span className="text-zinc-500">
                            · {item.added_by_table}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <span className="text-xs px-3 py-1 rounded-full shrink-0 ml-3 bg-zinc-700 text-zinc-300">
                    En cola
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-zinc-400">No hay más canciones en cola</p>
          )}
        </div>
      </div>
    </div>
  )
}
