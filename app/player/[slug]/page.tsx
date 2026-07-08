'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import YouTubePlayer from '@/components/YouTubePlayer'
import { supabase } from '@/lib/supabase'
import { advanceQueue, ensurePlayingItem, fetchActiveQueue } from '@/lib/queue'
import type { QueueItem, Venue } from '@/lib/types'

const POLL_MS = 3000

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

  const advancingRef = useRef(false)
  const venueIdRef = useRef<string | null>(null)
  /** Solo para modo local cuando RLS bloquea writes */
  const excludeIdsRef = useRef<Set<string>>(new Set())
  const playingItemRef = useRef<QueueItem | null>(null)
  const rlsLocalRef = useRef(false)

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

  const refreshQueue = useCallback(
    async (venueId: string, opts?: { promote?: boolean }) => {
      const promote = opts?.promote !== false

      if (promote) {
        const { items, playing, error: syncError, rlsBlocked } =
          await ensurePlayingItem(venueId, {
            excludeIds: rlsLocalRef.current
              ? excludeIdsRef.current
              : new Set(),
          })

        if (rlsBlocked) {
          rlsLocalRef.current = true
        }

        if (syncError && !playing && items.length === 0) {
          console.error('Error sincronizando cola:', syncError)
          setError(syncError.message || 'No se pudo cargar la cola')
          return
        }

        applyQueueState(items, playing)
        if (syncError && !playing) {
          setError(syncError.message)
        } else {
          setError(null)
        }
        return
      }

      // Solo lectura (poll suave): no forzar promote si ya hay playing
      const { items, error: fetchError } = await fetchActiveQueue(venueId)
      if (fetchError) {
        console.error('Error leyendo cola:', fetchError)
        return
      }

      let list = items
      if (rlsLocalRef.current && excludeIdsRef.current.size > 0) {
        list = items.filter((i) => !excludeIdsRef.current.has(i.id))
      }

      const playing =
        list.find((i) => i.status === 'playing' && i.videos?.youtube_id) ??
        null

      // Si no hay playing pero hay cola, promover
      if (!playing && list.some((i) => i.status === 'queued')) {
        await refreshQueue(venueId, { promote: true })
        return
      }

      // Mantener el item actual si el poll devuelve el mismo id
      const currentId = playingItemRef.current?.id
      if (
        currentId &&
        playing &&
        playing.id === currentId &&
        playingItemRef.current
      ) {
        applyQueueState(list, playing)
      } else {
        applyQueueState(list, playing)
      }
      setError(null)
    },
    [applyQueueState]
  )

  const handleEnded = useCallback(async () => {
    const venueId = venueIdRef.current
    const current = playingItemRef.current
    if (!venueId || !current || advancingRef.current) return

    advancingRef.current = true
    setPlayerNote('Pasando a la siguiente canción…')

    try {
      if (rlsLocalRef.current) {
        excludeIdsRef.current.add(current.id)
      }

      const result = await advanceQueue(venueId, current.id, {
        excludeIds: rlsLocalRef.current
          ? excludeIdsRef.current
          : new Set(),
      })

      if (result.excludeIds && rlsLocalRef.current) {
        excludeIdsRef.current = result.excludeIds
      }
      if (result.rlsBlocked) {
        rlsLocalRef.current = true
      }

      if (result.error && !result.playing && result.items.length === 0) {
        console.error('Error avanzando cola:', result.error)
        setError(result.error.message || 'No se pudo avanzar la cola')
        return
      }

      applyQueueState(result.items, result.playing)
      setPlayerNote(
        result.playing ? null : 'Cola vacía — esperando pedidos'
      )
    } finally {
      advancingRef.current = false
    }
  }, [applyQueueState])

  const handlePlayerError = useCallback(
    (code: number) => {
      console.error('Error del reproductor YouTube:', code)
      setPlayerNote(
        `YouTube no pudo reproducir este video (código ${code}). Saltando…`
      )
      window.setTimeout(() => {
        void handleEnded()
      }, 1500)
    },
    [handleEnded]
  )

  useEffect(() => {
    if (!slug) return

    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null
    let pollTimer: ReturnType<typeof setInterval> | undefined

    async function init() {
      setLoading(true)
      setError(null)

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

      // Polling fiable (funciona aunque Realtime no esté habilitado)
      pollTimer = setInterval(() => {
        if (!advancingRef.current && venueIdRef.current) {
          void refreshQueue(venueIdRef.current, { promote: false })
        }
      }, POLL_MS)

      // Realtime (bonus si está activo en Supabase)
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
      if (channel) {
        void supabase.removeChannel(channel)
      }
    }
  }, [slug, refreshQueue])

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

  const currentVideo = playingItem?.videos ?? null
  const waiting = queue.filter((i) => i.id !== playingItem?.id)

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
            {lastSync && (
              <div className="text-xs text-zinc-600">Sync {lastSync}</div>
            )}
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

        <div className="aspect-video bg-zinc-950 rounded-2xl mb-6 overflow-hidden border border-zinc-800">
          {currentVideo?.youtube_id ? (
            <YouTubePlayer
              key={playingItem?.id}
              videoId={currentVideo.youtube_id}
              title={currentVideo.title}
              onEnded={handleEnded}
              onError={handlePlayerError}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-6">
              <p className="text-xl text-zinc-400">Esperando canciones…</p>
              <p className="text-sm text-zinc-600 mt-2">
                Escanea el QR y pide desde /join/{venue?.slug}
              </p>
            </div>
          )}
        </div>

        {currentVideo && (
          <div className="mb-6 rounded-2xl bg-emerald-950/40 border border-emerald-800 px-5 py-4">
            <p className="text-emerald-400 text-xs tracking-[2px] uppercase">
              Reproduciendo ahora
            </p>
            <h2 className="text-2xl font-semibold mt-1">{currentVideo.title}</h2>
            {currentVideo.artist && (
              <p className="text-zinc-400 mt-1">{currentVideo.artist}</p>
            )}
            {playingItem?.added_by_table && (
              <p className="text-sm text-zinc-500 mt-2">
                Pedido por {playingItem.added_by_table}
              </p>
            )}
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
