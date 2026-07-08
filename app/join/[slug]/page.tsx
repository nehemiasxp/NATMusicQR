'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fetchActiveQueue } from '@/lib/queue'
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
  }
  autoplayMusic?: { enabled: boolean }
}

type SearchItem = {
  youtubeId: string
  title: string
  channelTitle: string
  thumbnailUrl: string | null
}

type Tab = 'catalog' | 'search'

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
  const [tab, setTab] = useState<Tab>('catalog')

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
      await Promise.all([loadCatalog(v.id), loadQueue(v.id)])
      if (cancelled) return
      setLoading(false)

      // Polling: la cola se actualiza aunque Realtime no esté activo
      pollTimer = setInterval(() => {
        void loadQueue(v.id)
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
  }, [slug, loadCatalog, loadQueue])

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
    if (!slug || !session || !playing?.id || !deviceId || voteBusy) return
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
          accessPin: session.accessPin || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage(data.error || 'No se pudo votar')
        return
      }
      setVoteUp(data.up ?? 0)
      setVoteDown(data.down ?? 0)
      setMyVote(data.myVote ?? vote)
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
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-3xl mx-auto px-4 py-6 pb-24">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-emerald-400 text-xs tracking-[2px] uppercase font-medium">
              Jukebox · {venue?.slug}
            </p>
            <h1 className="text-2xl font-bold mt-1">{venue?.name}</h1>
          </div>
          <div className="text-right shrink-0">
            <div className="rounded-full bg-emerald-950 border border-emerald-800 px-3 py-1.5 text-sm">
              <span className="text-emerald-400">🪑 </span>
              {formatTableLabel(session)}
            </div>
            <button
              type="button"
              onClick={handleChangeMesa}
              className="text-xs text-zinc-500 hover:text-zinc-300 mt-1"
            >
              Cambiar mesa
            </button>
          </div>
        </header>

        {/* Now playing */}
        <section className="mb-6 rounded-2xl overflow-hidden border border-zinc-800 bg-gradient-to-br from-emerald-950/80 to-zinc-900">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <p className="text-emerald-400 text-xs tracking-[2px] uppercase">
              Ahora suena
            </p>
            <span className="text-xs text-zinc-500">{waiting.length} en cola</span>
          </div>
          {playing?.videos ? (
            <div className="p-4 space-y-3">
              <div className="flex gap-4 items-center">
                {playing.videos.thumbnail_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={playing.videos.thumbnail_url}
                    alt=""
                    className="w-20 h-14 object-cover rounded-lg shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold truncate">{playing.videos.title}</p>
                  {playing.videos.artist && (
                    <p className="text-sm text-zinc-400 truncate">
                      {playing.videos.artist}
                    </p>
                  )}
                  {playing.added_by_table && (
                    <p className="text-xs text-zinc-500 mt-1">
                      {playing.added_by_table.includes('Autoplay')
                        ? playing.added_by_table
                        : `Pedido por ${playing.added_by_table}`}
                    </p>
                  )}
                </div>
              </div>

              {rules?.voting?.enabled && (
                <div className="flex items-center justify-between gap-3 pt-1 border-t border-white/5">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={voteBusy}
                      onClick={() => castVote('up')}
                      className={`rounded-full px-4 py-2 text-lg transition-colors ${
                        myVote === 'up'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                      }`}
                      aria-label="Me gusta"
                    >
                      👍{' '}
                      <span className="text-sm font-medium ml-1">{voteUp}</span>
                    </button>
                    <button
                      type="button"
                      disabled={voteBusy}
                      onClick={() => castVote('down')}
                      className={`rounded-full px-4 py-2 text-lg transition-colors ${
                        myVote === 'down'
                          ? 'bg-red-600 text-white'
                          : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                      }`}
                      aria-label="No me gusta"
                    >
                      👎{' '}
                      <span className="text-sm font-medium ml-1">{voteDown}</span>
                    </button>
                  </div>
                  <p className="text-[10px] text-zinc-500 text-right max-w-[9rem] leading-snug">
                    Si 👎 ≥ {rules.voting.skipThresholdPercent}% (mín.{' '}
                    {rules.voting.minVotesToSkip} votos) se salta
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p className="p-4 text-zinc-400 text-sm">
              Nadie está reproduciendo todavía. ¡Sé el primero!
            </p>
          )}

          {waiting.length > 0 && (
            <div className="px-4 pb-4">
              <p className="text-xs text-zinc-500 mb-2 uppercase tracking-wide">
                Próximas
              </p>
              <div className="space-y-1">
                {waiting.slice(0, 5).map((item, i) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 text-sm text-zinc-300"
                  >
                    <span className="text-zinc-600 w-4">{i + 1}.</span>
                    <span className="truncate flex-1">
                      {item.videos?.title ?? 'Canción'}
                    </span>
                    {item.added_by_table && (
                      <span className="text-xs text-zinc-600 shrink-0">
                        {item.added_by_table}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Tabs */}
        <div className="flex gap-2 mb-4 p-1 rounded-xl bg-zinc-900 border border-zinc-800">
          <button
            type="button"
            onClick={() => setTab('catalog')}
            className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors ${
              tab === 'catalog'
                ? 'bg-emerald-600 text-white'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            Del local ({videos.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('search')}
            className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors ${
              tab === 'search'
                ? 'bg-emerald-600 text-white'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            Buscar YouTube
          </button>
        </div>

        {rules && (
          <p className="mb-3 text-xs text-zinc-500">
            Máx. {Math.round(rules.maxDurationSeconds / 60)} min
            {rules.perDevice.enabled &&
              ` · ${rules.perDevice.maxSongs}/celular cada ${rules.perDevice.windowMinutes} min`}
            {rules.perTable.enabled &&
              ` · ${rules.perTable.maxSongs}/mesa cada ${rules.perTable.windowMinutes} min`}
          </p>
        )}

        {apiKeyMissing && (
          <div className="mb-4 rounded-xl border border-amber-800 bg-amber-950/40 px-4 py-3 text-amber-100 text-sm">
            Falta o falló YOUTUBE_API_KEY. Usa el catálogo del local.
          </div>
        )}

        {message && (
          <div
            className={`mb-4 rounded-xl px-4 py-3 text-sm ${
              message.startsWith('Error') || message.includes('ya está')
                ? 'border border-amber-800 bg-amber-950/40 text-amber-200'
                : 'border border-emerald-800 bg-emerald-950/40 text-emerald-300'
            }`}
          >
            {message}
          </div>
        )}

        {tab === 'catalog' ? (
          <div>
            <label className="block mb-4">
              <span className="text-sm text-zinc-400">Filtrar catálogo</span>
              <input
                type="search"
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
                className="mt-1 w-full rounded-xl bg-zinc-900 border border-zinc-700 px-4 py-3 outline-none focus:border-emerald-500"
                placeholder="Título, artista…"
              />
            </label>

            {filteredCatalog.length === 0 ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">
                <p className="text-zinc-400">
                  No hay canciones en el catálogo del local.
                </p>
                <button
                  type="button"
                  onClick={() => setTab('search')}
                  className="mt-3 text-emerald-400 text-sm hover:underline"
                >
                  Buscar en YouTube →
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredCatalog.map((video) => {
                  const inQueue = queuedVideoIds.has(video.id)
                  const duration = formatDuration(video.duration_seconds)
                  const key = `cat-${video.id}`

                  return (
                    <div
                      key={video.id}
                      className="flex items-center gap-3 p-3 rounded-2xl bg-zinc-900/80 border border-zinc-800"
                    >
                      {video.thumbnail_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={video.thumbnail_url}
                          alt=""
                          className="w-20 h-14 object-cover rounded-lg shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{video.title}</p>
                        {video.artist && (
                          <p className="text-sm text-zinc-400 truncate">
                            {video.artist}
                          </p>
                        )}
                        <div className="flex gap-2 mt-1 text-xs text-zinc-500">
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
                        className="shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-400"
                      >
                        {inQueue
                          ? 'En cola'
                          : addingKey === key
                            ? '...'
                            : 'Pedir'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div>
            <form onSubmit={runSearch} className="mb-4 space-y-2">
              <label className="block">
                <span className="text-sm text-zinc-400">
                  Busca o pega un link de YouTube
                </span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-zinc-900 border border-zinc-700 px-4 py-3 outline-none focus:border-emerald-500"
                  placeholder="Ej: saqra carnaval, o https://youtu.be/..."
                />
              </label>
              <button
                type="submit"
                disabled={searching}
                className="w-full rounded-xl bg-zinc-100 text-zinc-900 font-semibold py-3 hover:bg-white disabled:opacity-50"
              >
                {searching ? 'Buscando…' : 'Buscar'}
              </button>
              <p className="text-xs text-zinc-500">
                Validamos embed, duración y que no sea live antes de encolar.
              </p>
            </form>

            {searchError && (
              <p className="mb-3 text-sm text-amber-300">{searchError}</p>
            )}

            <div className="space-y-3">
              {searchResults.map((item) => {
                const inQueue = queuedYoutubeIds.has(item.youtubeId)
                const key = `yt-${item.youtubeId}`
                return (
                  <div
                    key={item.youtubeId}
                    className="flex items-center gap-3 p-3 rounded-2xl bg-zinc-900/80 border border-zinc-800"
                  >
                    {item.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        className="w-20 h-14 object-cover rounded-lg shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{item.title}</p>
                      {item.channelTitle && (
                        <p className="text-sm text-zinc-400 truncate">
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
                      className="shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-400"
                    >
                      {inQueue
                        ? 'En cola'
                        : addingKey === key
                          ? 'Validando…'
                          : 'Pedir'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
