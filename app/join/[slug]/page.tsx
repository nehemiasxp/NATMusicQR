'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fetchActiveMesas, fetchActiveQueue, type ActiveMesa } from '@/lib/queue'
import {
  clearMesaSession,
  formatTableLabel,
  loadMesaSession,
  saveMesaSession,
  type MesaSession,
} from '@/lib/mesa-session'
import { getOrCreateDeviceId } from '@/lib/device-id'
import type { QueueItem, Venue, Video } from '@/lib/types'

type PublicConfig = {
  maxDurationSeconds: number
  perTable: { enabled: boolean; maxSongs: number; windowMinutes: number }
  perDevice: { enabled: boolean; maxSongs: number; windowMinutes: number }
  access?: {
    pinEnabled: boolean
    pinRequired: boolean
    hoursEnabled: boolean
    timezone: string
    openTime: string
    closeTime: string
    isOpen?: boolean
    hoursLabel?: string
  }
  voting?: {
    enabled: boolean
    skipThresholdPercent: number
    minVotesToSkip: number
    upCancelsDown?: boolean
  }
  autoplayMusic?: { enabled: boolean }
}

type SearchItem = {
  youtubeId: string
  title: string
  channelTitle: string
  thumbnailUrl: string | null
}

/** v2.1 — 3 pestañas: En cola | Local | +Añadir música */
export const JOIN_UI_VERSION = '2.1.6'

type Tab = 'queue' | 'local' | 'add'

function formatDuration(seconds: number | null | undefined) {
  if (!seconds || seconds <= 0) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function JoinPage() {
  const params = useParams<{ slug: string }>()
  const searchParams = useSearchParams()
  const slug = params?.slug

  const qrMesa =
    searchParams.get('mesa') ||
    searchParams.get('table') ||
    searchParams.get('t') ||
    ''

  const [venue, setVenue] = useState<Venue | null>(null)
  const [videos, setVideos] = useState<Video[]>([])
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Sesión de mesa
  const [session, setSession] = useState<MesaSession | null>(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [mesaInput, setMesaInput] = useState('')
  const [nameInput, setNameInput] = useState('')
  const [pinInput, setPinInput] = useState('')

  const [addingKey, setAddingKey] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('queue')

  const [catalogQuery, setCatalogQuery] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [apiKeyMissing, setApiKeyMissing] = useState(false)
  const [deviceId, setDeviceId] = useState('')
  const [rules, setRules] = useState<PublicConfig | null>(null)
  const [voteUp, setVoteUp] = useState(0)
  const [voteDown, setVoteDown] = useState(0)
  const [myVote, setMyVote] = useState<'up' | 'down' | null>(null)
  const [voteBusy, setVoteBusy] = useState(false)
  const [showMesas, setShowMesas] = useState(false)
  const [activeMesas, setActiveMesas] = useState<ActiveMesa[]>([])

  // Cargar sesión de mesa + deviceId + reglas
  useEffect(() => {
    if (!slug) return
    const existing = loadMesaSession(slug)
    if (existing) {
      setSession(existing)
    } else if (qrMesa) {
      setMesaInput(qrMesa.startsWith('Mesa') ? qrMesa : `Mesa ${qrMesa}`)
    }
    setDeviceId(getOrCreateDeviceId())
    setSessionReady(true)

    void fetch('/api/config')
      .then((r) => r.json())
      .then((data) => setRules(data as PublicConfig))
      .catch(() => null)
  }, [slug, qrMesa])

  const loadQueue = useCallback(async (venueId: string) => {
    const { items, error: queueError } = await fetchActiveQueue(venueId)
    if (queueError) {
      console.error('Error cargando cola:', queueError.message, queueError)
      return
    }
    setQueue(items)
  }, [])

  const loadActiveMesas = useCallback(async (venueId: string) => {
    const { mesas } = await fetchActiveMesas(venueId, 4)
    setActiveMesas(mesas)
  }, [])

  const loadCatalog = useCallback(async (venueId: string) => {
    const { data, error: videosError } = await supabase
      .from('videos')
      .select(
        'id, youtube_id, title, artist, thumbnail_url, duration_seconds, category, is_active'
      )
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .order('title', { ascending: true })

    if (videosError) {
      console.error('Error cargando videos:', videosError.message, videosError)
      setError(videosError.message || 'No se pudo cargar el catálogo')
      return
    }

    setVideos((data ?? []) as Video[])
    setError(null)
  }, [])

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
      await Promise.all([
        loadCatalog(v.id),
        loadQueue(v.id),
        loadActiveMesas(v.id),
      ])
      if (cancelled) return
      setLoading(false)

      // Polling: la cola se actualiza aunque Realtime no esté activo
      pollTimer = setInterval(() => {
        void loadQueue(v.id)
        void loadActiveMesas(v.id)
      }, 3000)

      if (cancelled) {
        clearInterval(pollTimer)
        return
      }

      channel = supabase
        .channel(`join-queue-${v.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'queue_items',
            filter: `venue_id=eq.${v.id}`,
          },
          () => {
            void loadQueue(v.id)
          }
        )
        .subscribe()
    }

    void init()

    return () => {
      cancelled = true
      if (pollTimer) clearInterval(pollTimer)
      if (channel) {
        void supabase.removeChannel(channel)
      }
    }
  }, [slug, loadCatalog, loadQueue, loadActiveMesas])

  const queuedYoutubeIds = useMemo(() => {
    return new Set(
      queue
        .map((item) => item.videos?.youtube_id)
        .filter(Boolean) as string[]
    )
  }, [queue])

  const queuedVideoIds = useMemo(() => {
    return new Set(
      queue
        .map((item) => item.video_id ?? item.videos?.id)
        .filter(Boolean) as string[]
    )
  }, [queue])

  const playing = queue.find((item) => item.status === 'playing') ?? null
  const waiting = queue.filter((item) => item.status === 'queued')

  // Cargar votos de la canción actual
  useEffect(() => {
    if (!playing?.id || !rules?.voting?.enabled || !deviceId) {
      setVoteUp(0)
      setVoteDown(0)
      setMyVote(null)
      return
    }

    let cancelled = false
    async function loadVotes() {
      try {
        const res = await fetch(
          `/api/votes?queueItemId=${encodeURIComponent(playing!.id)}&deviceId=${encodeURIComponent(deviceId)}`
        )
        const data = await res.json()
        if (cancelled || !res.ok) return
        setVoteUp(data.up ?? 0)
        setVoteDown(data.down ?? 0)
        setMyVote(data.myVote ?? null)
      } catch {
        /* ignore */
      }
    }

    void loadVotes()
    const t = setInterval(loadVotes, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [playing?.id, rules?.voting?.enabled, deviceId])

  async function castVote(vote: 'up' | 'down') {
    // Votos válidos para pedidos de mesa Y para autoplay del catálogo
    if (!slug || !session || !playing?.id || !deviceId || voteBusy) return
    if (playing.status !== 'playing') {
      setMessage('Solo puedes votar la canción que está sonando ahora')
      return
    }
    setVoteBusy(true)
    try {
      const res = await fetch('/api/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueSlug: slug,
          queueItemId: playing.id,
          deviceId,
          vote,
          accessPin: session.accessPin || pinInput.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage(data.error || data.hint || 'No se pudo votar')
        return
      }
      setVoteUp(data.up ?? 0)
      setVoteDown(data.down ?? 0)
      setMyVote(data.myVote ?? vote)
      if (data.shouldSkip) {
        setMessage('La sala rechazó el tema… la TV bajará el volumen y cambiará')
      }
    } catch {
      setMessage('Error de red al votar')
    } finally {
      setVoteBusy(false)
    }
  }

  const filteredCatalog = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase()
    if (!q) return videos
    return videos.filter((v) => {
      const haystack =
        `${v.title} ${v.artist ?? ''} ${v.category ?? ''}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [videos, catalogQuery])

  async function handleJoinMesa(e: React.FormEvent) {
    e.preventDefault()
    if (!slug) return
    const mesa = mesaInput.trim()
    if (!mesa) {
      setMessage('Indica el número o nombre de tu mesa')
      return
    }

    setMessage(null)

    // Verificar horario + PIN en el servidor (el PIN no viaja en /api/config)
    try {
      const res = await fetch('/api/access/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinInput.trim() }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setMessage(data.error || 'No se pudo entrar al jukebox')
        if (data.access) {
          setRules((r) =>
            r
              ? {
                  ...r,
                  access: { ...r.access, ...data.access },
                }
              : r
          )
        }
        return
      }
    } catch {
      setMessage('Error de red al verificar acceso')
      return
    }

    const saved = saveMesaSession(slug, {
      tableName: mesa,
      displayName: nameInput.trim() || null,
      accessPin: pinInput.trim() || null,
    })
    setSession(saved)
    setMessage(null)
  }

  function handleChangeMesa() {
    if (!slug) return
    clearMesaSession(slug)
    setSession(null)
    setMesaInput(qrMesa ? (qrMesa.startsWith('Mesa') ? qrMesa : `Mesa ${qrMesa}`) : '')
    setNameInput('')
  }

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault()
    const q = searchQuery.trim()
    if (q.length < 2) {
      setSearchError('Escribe al menos 2 caracteres o pega un link de YouTube')
      return
    }

    setSearching(true)
    setSearchError(null)
    setMessage(null)

    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()

      if (!res.ok) {
        if (data.code === 'MISSING_API_KEY') setApiKeyMissing(true)
        setSearchResults([])
        setSearchError(data.error || 'No se pudo buscar')
        return
      }

      setApiKeyMissing(false)
      setSearchResults((data.items ?? []) as SearchItem[])
      if (!data.items?.length) {
        setSearchError('Sin resultados. Prueba otra búsqueda.')
      }
    } catch {
      setSearchError('Error de red al buscar en YouTube')
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  async function requestSong(opts: {
    key: string
    youtubeId?: string
    videoId?: string
  }) {
    if (!slug || !session) return

    setAddingKey(opts.key)
    setMessage(null)

    try {
      const res = await fetch('/api/queue/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueSlug: slug,
          youtubeId: opts.youtubeId,
          videoId: opts.videoId,
          tableName: formatTableLabel(session),
          deviceId: deviceId || getOrCreateDeviceId(),
          accessPin: session.accessPin || pinInput.trim() || undefined,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        if (data.code === 'MISSING_API_KEY') setApiKeyMissing(true)
        const reasons =
          Array.isArray(data.reasons) && data.reasons.length
            ? ` (${data.reasons.join('; ')})`
            : ''
        if (res.status === 429) {
          setMessage(data.error || 'Límite de pedidos alcanzado')
          return
        }
        setMessage(
          data.alreadyInQueue
            ? 'Esa canción ya está en la cola'
            : `Error: ${data.error || 'No se pudo pedir'}${reasons}`
        )
        return
      }

      setMessage(`“${data.video?.title ?? 'Canción'}” se agregó a la cola 🎵`)
      if (venue) {
        await Promise.all([loadQueue(venue.id), loadCatalog(venue.id)])
      }
    } catch {
      setMessage('Error: no se pudo conectar con el servidor')
    } finally {
      setAddingKey(null)
    }
  }

  if (loading || !sessionReady) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-white">
        Cargando...
      </div>
    )
  }

  if (error && !venue) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-white p-6">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold mb-2">Local no encontrado</h1>
          <p className="text-red-400">{error}</p>
        </div>
      </div>
    )
  }

  // ——— Pantalla: entrar como mesa ———
  if (!session) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <p className="text-emerald-400 text-xs tracking-[2px] uppercase font-medium">
            {venue?.name ?? 'NATMusicQR'}
          </p>
          <h1 className="text-3xl font-bold mt-2 mb-2">¿En qué mesa estás?</h1>
          <p className="text-zinc-400 text-sm mb-6">
            Así sabemos quién pide cada canción. Si escaneaste un QR de mesa, ya
            puede venir rellenado.
          </p>

          {rules?.access?.hoursEnabled && (
            <div
              className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
                rules.access.isOpen === false
                  ? 'border-red-800 bg-red-950/40 text-red-200'
                  : 'border-zinc-800 bg-zinc-900/60 text-zinc-300'
              }`}
            >
              {rules.access.isOpen === false ? (
                <p>
                  Cerrado ahora. Horario:{' '}
                  {rules.access.hoursLabel ||
                    `${rules.access.openTime} – ${rules.access.closeTime}`}
                </p>
              ) : (
                <p>
                  Abierto ·{' '}
                  {rules.access.hoursLabel ||
                    `${rules.access.openTime} – ${rules.access.closeTime}`}
                </p>
              )}
            </div>
          )}

          <form onSubmit={handleJoinMesa} className="space-y-4">
            <label className="block">
              <span className="text-sm text-zinc-400">Mesa *</span>
              <input
                type="text"
                value={mesaInput}
                onChange={(e) => setMesaInput(e.target.value)}
                className="mt-1 w-full rounded-xl bg-zinc-900 border border-zinc-700 px-4 py-3 outline-none focus:border-emerald-500"
                placeholder="Ej: Mesa 4"
                maxLength={40}
                autoFocus
                required
              />
            </label>

            <label className="block">
              <span className="text-sm text-zinc-400">
                Tu nombre (opcional)
              </span>
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                className="mt-1 w-full rounded-xl bg-zinc-900 border border-zinc-700 px-4 py-3 outline-none focus:border-emerald-500"
                placeholder="Ej: Carlos"
                maxLength={30}
              />
            </label>

            {(rules?.access?.pinRequired || rules?.access?.pinEnabled) && (
              <label className="block">
                <span className="text-sm text-zinc-400">PIN del local *</span>
                <input
                  type="password"
                  inputMode="numeric"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-zinc-900 border border-zinc-700 px-4 py-3 outline-none focus:border-emerald-500 tracking-widest"
                  placeholder="Código del local"
                  maxLength={32}
                  required
                />
                <span className="text-xs text-zinc-500 mt-1 block">
                  Pídelo al mesero o míralo en la TV / carta
                </span>
              </label>
            )}

            {message && (
              <p className="text-sm text-amber-300">{message}</p>
            )}

            <button
              type="submit"
              disabled={rules?.access?.isOpen === false}
              className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 font-semibold py-3.5 disabled:opacity-40"
            >
              Entrar al jukebox
            </button>
          </form>

          {rules && (
            <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-xs text-zinc-400 space-y-1">
              <p className="text-zinc-300 font-medium mb-2">Reglas del local</p>
              <p>
                · Videos máx.{' '}
                {Math.round(rules.maxDurationSeconds / 60)} min
              </p>
              {rules.perTable.enabled && (
                <p>
                  · Por mesa: {rules.perTable.maxSongs} canción cada{' '}
                  {rules.perTable.windowMinutes} min
                </p>
              )}
              {rules.perDevice.enabled && (
                <p>
                  · Por celular: {rules.perDevice.maxSongs} canción cada{' '}
                  {rules.perDevice.windowMinutes} min
                </p>
              )}
            </div>
          )}

          <p className="text-xs text-zinc-600 mt-4 text-center">
            Luego podrás pedir del catálogo o buscar en YouTube
          </p>
        </div>
      </div>
    )
  }

  // ——— Jukebox (ya con mesa) ———
  const tabs: { id: Tab; label: string; short: string }[] = [
    { id: 'queue', label: `En cola (${waiting.length})`, short: `Cola (${waiting.length})` },
    {
      id: 'local',
      label: `Biblioteca de Música (${videos.length})`,
      short: `Biblioteca (${videos.length})`,
    },
    { id: 'add', label: '+ Añadir Música', short: '+ Añadir' },
  ]

  return (
    <div className="min-h-screen bg-[#07080a] font-[family-name:var(--font-geist-sans)] text-zinc-100 antialiased">
      <div className="mx-auto max-w-3xl px-4 py-5 pb-28">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-400/90">
                {venue?.slug}
              </p>
              <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300/90 ring-1 ring-emerald-500/25">
                v{JOIN_UI_VERSION}
              </span>
            </div>
            <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-white">
              {venue?.name}
            </h1>
          </div>
          <div className="relative shrink-0 text-right">
            <button
              type="button"
              onClick={() => {
                setShowMesas((v) => !v)
                if (venue) void loadActiveMesas(venue.id)
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-800/60 bg-emerald-950/50 px-3 py-1.5 text-sm font-medium transition hover:border-emerald-500/50 hover:bg-emerald-950"
              aria-expanded={showMesas}
              title="Ver mesas activas"
            >
              <span className="text-emerald-400">🪑</span>
              <span className="max-w-[9rem] truncate">
                {formatTableLabel(session)}
              </span>
              <span className="text-[10px] text-emerald-500/80">
                {showMesas ? '▲' : '▼'}
              </span>
            </button>
            <button
              type="button"
              onClick={handleChangeMesa}
              className="mt-1 block w-full text-xs text-zinc-500 hover:text-zinc-300"
            >
              Cambiar mesa
            </button>

            {showMesas && (
              <div className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-zinc-700/90 bg-zinc-900 shadow-2xl shadow-black/50">
                <div className="border-b border-zinc-800 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                    Mesas activas
                  </p>
                  <p className="text-[10px] text-zinc-600">
                    Con pedidos en las últimas horas
                  </p>
                </div>
                <div className="max-h-60 overflow-y-auto py-1">
                  {activeMesas.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-zinc-500">
                      Ninguna mesa activa aún
                    </p>
                  ) : (
                    activeMesas.map((m) => {
                      const isMine =
                        m.name.toLowerCase() ===
                        session.tableName.trim().toLowerCase()
                      return (
                        <div
                          key={m.name}
                          className={`flex items-center justify-between gap-2 px-3 py-2.5 text-left text-sm ${
                            isMine
                              ? 'bg-emerald-500/10 text-emerald-200'
                              : 'text-zinc-200'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {m.name}
                              {isMine ? ' · tú' : ''}
                            </p>
                            <p className="text-[10px] text-zinc-500">
                              {m.requests} pedido{m.requests === 1 ? '' : 's'}
                              {m.inQueue ? ' · en cola ahora' : ''}
                            </p>
                          </div>
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              m.inQueue ? 'bg-emerald-400' : 'bg-zinc-600'
                            }`}
                          />
                        </div>
                      )
                    })
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setShowMesas(false)}
                  className="w-full border-t border-zinc-800 py-2 text-xs text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
                >
                  Cerrar
                </button>
              </div>
            )}
          </div>
        </header>

        {showMesas && (
          <button
            type="button"
            className="fixed inset-0 z-30 cursor-default bg-black/40"
            aria-label="Cerrar lista de mesas"
            onClick={() => setShowMesas(false)}
          />
        )}

        {/* Ahora suena (siempre visible) */}
        <section className="mb-4 overflow-hidden rounded-2xl border border-zinc-800/90 bg-gradient-to-br from-emerald-950/70 to-zinc-900/80">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-400">
              Ahora suena
            </p>
            <span className="text-xs text-zinc-500">
              {waiting.length} en cola
            </span>
          </div>
          {playing?.videos ? (
            <div className="space-y-3 p-4">
              <div className="flex items-center gap-3">
                {playing.videos.thumbnail_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={playing.videos.thumbnail_url}
                    alt=""
                    className="h-14 w-20 shrink-0 rounded-lg object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-zinc-50">
                    {playing.videos.title}
                  </p>
                  {playing.videos.artist && (
                    <p className="truncate text-sm text-zinc-400">
                      {playing.videos.artist}
                    </p>
                  )}
                  {playing.added_by_table && (
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {playing.added_by_table.includes('Autoplay')
                        ? playing.added_by_table
                        : `Pedido por ${playing.added_by_table}`}
                    </p>
                  )}
                </div>
              </div>

              {/* Votos: pedidos de usuarios Y canciones de autoplay */}
              {rules?.voting?.enabled !== false && (
                <div className="space-y-2 border-t border-white/5 pt-3">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                    {playing.added_by_table?.includes('Autoplay')
                      ? 'Votar autoplay (también cuenta)'
                      : 'Votar esta canción'}
                  </p>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={voteBusy || !playing.id}
                        onClick={() => castVote('up')}
                        className={`rounded-full px-3.5 py-1.5 text-base transition ${
                          myVote === 'up'
                            ? 'bg-emerald-600 text-white'
                            : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                        }`}
                        aria-label="Me gusta"
                      >
                        👍{' '}
                        <span className="ml-0.5 text-sm font-medium">
                          {voteUp}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={voteBusy || !playing.id}
                        onClick={() => castVote('down')}
                        className={`rounded-full px-3.5 py-1.5 text-base transition ${
                          myVote === 'down'
                            ? 'bg-red-600 text-white'
                            : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                        }`}
                        aria-label="No me gusta"
                      >
                        👎{' '}
                        <span className="ml-0.5 text-sm font-medium">
                          {voteDown}
                        </span>
                      </button>
                    </div>
                    <p className="max-w-[9rem] text-right text-[10px] leading-snug text-zinc-500">
                      {rules?.voting?.upCancelsDown !== false
                        ? '👍 cancela 👎 · '
                        : ''}
                      👎 ≥ {rules?.voting?.skipThresholdPercent ?? 80}% (mín.{' '}
                      {rules?.voting?.minVotesToSkip ?? 2}) salta
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="p-4 text-sm text-zinc-400">
              Nadie está reproduciendo. ¡Sé el primero!
            </p>
          )}
        </section>

        {/* 3 pestañas — tipografía alta y legible */}
        <div className="mb-4 grid grid-cols-3 gap-1.5 rounded-2xl border border-zinc-800/90 bg-zinc-900/70 p-1.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`min-h-[3.25rem] rounded-xl px-1.5 py-2.5 text-center font-[family-name:var(--font-geist-sans)] text-[13px] font-bold leading-[1.15] tracking-tight transition sm:min-h-[3.5rem] sm:text-[15px] sm:leading-snug ${
                tab === t.id
                  ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-900/30'
                  : 'text-zinc-300 hover:bg-zinc-800/80 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {rules && (
          <p className="mb-3 text-[11px] text-zinc-500">
            Máx. {Math.round(rules.maxDurationSeconds / 60)} min
            {rules.perDevice.enabled &&
              ` · ${rules.perDevice.maxSongs}/celular cada ${rules.perDevice.windowMinutes} min`}
            {rules.perTable.enabled &&
              ` · ${rules.perTable.maxSongs}/mesa cada ${rules.perTable.windowMinutes} min`}
          </p>
        )}

        {apiKeyMissing && (
          <div className="mb-3 rounded-xl border border-amber-800/60 bg-amber-950/40 px-3 py-2.5 text-sm text-amber-100">
            Falta YOUTUBE_API_KEY. Usa el catálogo local.
          </div>
        )}

        {message && (
          <div
            className={`mb-3 rounded-xl px-3 py-2.5 text-sm ${
              message.startsWith('Error') || message.includes('ya está')
                ? 'border border-amber-800/60 bg-amber-950/40 text-amber-100'
                : 'border border-emerald-800/50 bg-emerald-950/30 text-emerald-200'
            }`}
          >
            {message}
          </div>
        )}

        {/* ——— EN COLA ——— */}
        {tab === 'queue' && (
          <div>
            <h2 className="mb-3 text-sm font-semibold tracking-tight text-zinc-200">
              Próximas a reproducir
            </h2>
            {waiting.length === 0 ? (
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-8 text-center">
                <p className="text-sm text-zinc-400">La cola está vacía</p>
                <button
                  type="button"
                  onClick={() => setTab('local')}
                  className="mt-3 text-sm font-medium text-emerald-400 hover:text-emerald-300"
                >
                  Ver biblioteca de música →
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {waiting.map((item, index) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3"
                  >
                    <span className="w-7 shrink-0 text-center font-[family-name:var(--font-geist-mono)] text-lg text-zinc-600">
                      {index + 1}
                    </span>
                    {item.videos?.thumbnail_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.videos.thumbnail_url}
                        alt=""
                        className="h-11 w-16 shrink-0 rounded-md object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">
                        {item.videos?.title ?? 'Canción'}
                      </p>
                      <p className="truncate text-xs text-zinc-500">
                        {item.videos?.artist ?? ''}
                        {item.added_by_table
                          ? ` · ${item.added_by_table}`
                          : ''}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                      En cola
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ——— MÚSICAS DEL LOCAL ——— */}
        {tab === 'local' && (
          <div>
            <label className="mb-3 block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Filtrar catálogo
              </span>
              <input
                type="search"
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-zinc-800 bg-zinc-900/80 px-4 py-2.5 text-sm outline-none focus:border-emerald-500/50"
                placeholder="Título, artista…"
              />
            </label>

            {filteredCatalog.length === 0 ? (
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-8 text-center">
                <p className="text-sm text-zinc-400">
                  No hay canciones en el catálogo.
                </p>
                <button
                  type="button"
                  onClick={() => setTab('add')}
                  className="mt-3 text-sm font-medium text-emerald-400 hover:text-emerald-300"
                >
                  + Añadir música →
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredCatalog.map((video) => {
                  const inQueue = queuedVideoIds.has(video.id)
                  const duration = formatDuration(video.duration_seconds)
                  const key = `cat-${video.id}`

                  return (
                    <div
                      key={video.id}
                      className="flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3"
                    >
                      {video.thumbnail_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={video.thumbnail_url}
                          alt=""
                          className="h-12 w-[4.5rem] shrink-0 rounded-md object-cover"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {video.title}
                        </p>
                        {video.artist && (
                          <p className="truncate text-xs text-zinc-400">
                            {video.artist}
                          </p>
                        )}
                        <div className="mt-0.5 flex gap-2 text-[11px] text-zinc-600">
                          {video.category && <span>{video.category}</span>}
                          {duration && <span>· {duration}</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={addingKey === key || inQueue}
                        onClick={() =>
                          requestSong({
                            key,
                            videoId: video.id,
                            youtubeId: video.youtube_id,
                          })
                        }
                        className="shrink-0 rounded-full bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:bg-zinc-700 disabled:text-zinc-400"
                      >
                        {inQueue
                          ? 'En cola'
                          : addingKey === key
                            ? '…'
                            : 'Pedir'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ——— + AÑADIR MÚSICA (YouTube) ——— */}
        {tab === 'add' && (
          <div>
            <div className="mb-4 rounded-2xl border border-zinc-800/90 bg-zinc-900/40 p-4">
              <h2 className="text-sm font-semibold text-zinc-100">
                Añadir música
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                Busca en YouTube o pega un enlace. Validamos embed y duración
                antes de encolar.
              </p>

              <form onSubmit={runSearch} className="mt-4 space-y-2.5">
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    Buscar en YouTube
                  </span>
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-zinc-800 bg-zinc-950/80 px-4 py-2.5 text-sm outline-none focus:border-emerald-500/50"
                    placeholder="Canción, artista o https://youtu.be/…"
                  />
                </label>
                <button
                  type="submit"
                  disabled={searching}
                  className="w-full rounded-xl bg-white py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-50"
                >
                  {searching ? 'Buscando…' : 'Buscar en YouTube'}
                </button>
              </form>
            </div>

            {searchError && (
              <p className="mb-3 text-sm text-amber-300">{searchError}</p>
            )}

            {searchResults.length > 0 && (
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Resultados
              </h3>
            )}

            <div className="space-y-2">
              {searchResults.map((item) => {
                const inQueue = queuedYoutubeIds.has(item.youtubeId)
                const key = `yt-${item.youtubeId}`
                return (
                  <div
                    key={item.youtubeId}
                    className="flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3"
                  >
                    {item.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        className="h-12 w-[4.5rem] shrink-0 rounded-md object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.title}
                      </p>
                      {item.channelTitle && (
                        <p className="truncate text-xs text-zinc-400">
                          {item.channelTitle}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={addingKey === key || inQueue}
                      onClick={() =>
                        requestSong({
                          key,
                          youtubeId: item.youtubeId,
                        })
                      }
                      className="shrink-0 rounded-full bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:bg-zinc-700 disabled:text-zinc-400"
                    >
                      {inQueue
                        ? 'En cola'
                        : addingKey === key
                          ? '…'
                          : 'Pedir'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <p className="mt-8 text-center text-[10px] text-zinc-700">
          NatMusicQR V. {JOIN_UI_VERSION}
        </p>
      </div>
    </div>
  )
}
