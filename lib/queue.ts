import { supabase } from '@/lib/supabase'
import { QUEUE_SELECT, type QueueItem } from '@/lib/types'

export type QueueError = {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
  rlsBlocked?: boolean
}

function toError(
  err: { message: string; code?: string; details?: string; hint?: string } | null,
  fallback: string,
  extra?: Partial<QueueError>
): QueueError {
  if (!err) {
    return { message: fallback, ...extra }
  }
  return {
    message: err.message || fallback,
    code: err.code,
    details: err.details,
    hint: err.hint,
    ...extra,
  }
}

export async function fetchActiveQueue(venueId: string) {
  const { data, error } = await supabase
    .from('queue_items')
    .select(QUEUE_SELECT)
    .eq('venue_id', venueId)
    .in('status', ['queued', 'playing'])
    .order('added_at', { ascending: true })

  return {
    items: (data ?? []) as unknown as QueueItem[],
    error: error ? toError(error, 'No se pudo cargar la cola') : null,
  }
}

/** Elige un video activo al azar del catálogo del local. */
export async function pickRandomCatalogVideo(venueId: string) {
  const { data, error } = await supabase
    .from('videos')
    .select(
      'id, youtube_id, title, artist, thumbnail_url, duration_seconds, category, is_active'
    )
    .eq('venue_id', venueId)
    .eq('is_active', true)

  if (error || !data?.length) {
    return { video: null, error: error ? toError(error, 'Sin catálogo') : null }
  }

  const withYt = data.filter((v) => v.youtube_id)
  if (!withYt.length) return { video: null, error: null }

  const video = withYt[Math.floor(Math.random() * withYt.length)]
  return { video, error: null }
}

/**
 * Si no hay cola y autoplay está activo, inserta una canción random del catálogo
 * como playing (added_by_table = Autoplay).
 */
export async function enqueueAutoplayIfEmpty(venueId: string) {
  const { items, error } = await fetchActiveQueue(venueId)
  if (error) return { items, playing: null as QueueItem | null, error, didAutoplay: false }
  if (items.length > 0) {
    const playing = items.find((i) => i.status === 'playing') ?? null
    return { items, playing, error: null, didAutoplay: false }
  }

  const { video, error: catError } = await pickRandomCatalogVideo(venueId)
  if (catError || !video) {
    return {
      items: [],
      playing: null,
      error: catError,
      didAutoplay: false,
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('queue_items')
    .insert({
      venue_id: venueId,
      video_id: video.id,
      status: 'playing',
      played_at: new Date().toISOString(),
      added_by_table: 'Autoplay 🎵',
    })
    .select(QUEUE_SELECT)
    .single()

  if (insertError || !inserted) {
    return {
      items: [],
      playing: null,
      error: toError(insertError, 'No se pudo iniciar autoplay'),
      didAutoplay: false,
    }
  }

  const item = inserted as unknown as QueueItem
  return {
    items: [item],
    playing: item,
    error: null,
    didAutoplay: true,
  }
}

/**
 * Asegura un item "playing".
 * Si autoplayEnabled y no hay cola, llena con catálogo random.
 */
export async function ensurePlayingItem(
  venueId: string,
  options?: { excludeIds?: Set<string>; autoplayEnabled?: boolean }
) {
  const exclude = options?.excludeIds ?? new Set<string>()
  const { items, error } = await fetchActiveQueue(venueId)
  if (error) return { items, playing: null as QueueItem | null, error, rlsBlocked: false }

  const visible = items.filter((i) => !exclude.has(i.id))

  const playing =
    visible.find((i) => i.status === 'playing' && i.videos?.youtube_id) ?? null
  if (playing) {
    return { items: visible, playing, error: null, rlsBlocked: false }
  }

  const next =
    visible.find((i) => i.status === 'queued' && i.videos?.youtube_id) ?? null

  if (!next) {
    if (options?.autoplayEnabled) {
      const auto = await enqueueAutoplayIfEmpty(venueId)
      return {
        items: auto.items,
        playing: auto.playing,
        error: auto.error,
        rlsBlocked: false,
      }
    }
    return { items: visible, playing: null, error: null, rlsBlocked: false }
  }

  const { data: updated, error: updateError } = await supabase
    .from('queue_items')
    .update({
      status: 'playing',
      played_at: new Date().toISOString(),
    })
    .eq('id', next.id)
    .eq('status', 'queued')
    .select('id')

  if (updateError) {
    const localPlaying = { ...next, status: 'playing' as const }
    return {
      items: visible.map((i) => (i.id === next.id ? localPlaying : i)),
      playing: localPlaying,
      error: toError(updateError, 'No se pudo marcar como playing'),
      rlsBlocked: true,
    }
  }

  if (!updated || updated.length === 0) {
    const localPlaying = { ...next, status: 'playing' as const }
    return {
      items: visible.map((i) => (i.id === next.id ? localPlaying : i)),
      playing: localPlaying,
      error: toError(null, RLS_HINT, { rlsBlocked: true, code: 'RLS_NO_UPDATE' }),
      rlsBlocked: true,
    }
  }

  const refreshed = await fetchActiveQueue(venueId)
  const newPlaying =
    refreshed.items.find((i) => i.status === 'playing') ??
    ({ ...next, status: 'playing' } as QueueItem)

  return {
    items: refreshed.items,
    playing: newPlaying,
    error: refreshed.error,
    rlsBlocked: false,
  }
}

const RLS_HINT =
  'Supabase bloqueó el UPDATE de queue_items (RLS). Agrega políticas de INSERT/UPDATE. La TV reproducirá en modo local.'

/**
 * Marca el actual como played/skipped y arranca el siguiente (o autoplay).
 */
export async function advanceQueue(
  venueId: string,
  currentItemId: string,
  options?: {
    excludeIds?: Set<string>
    status?: 'played' | 'skipped'
    autoplayEnabled?: boolean
  }
) {
  const exclude = new Set(options?.excludeIds ?? [])
  const endStatus = options?.status ?? 'played'

  const { data: updated, error: doneError } = await supabase
    .from('queue_items')
    .update({ status: endStatus })
    .eq('id', currentItemId)
    .in('status', ['playing', 'queued'])
    .select('id')

  if (doneError || !updated || updated.length === 0) {
    exclude.add(currentItemId)
    const result = await ensurePlayingItem(venueId, {
      excludeIds: exclude,
      autoplayEnabled: options?.autoplayEnabled,
    })
    return {
      ...result,
      excludeIds: exclude,
      rlsBlocked: true as boolean,
      error:
        result.error ??
        toError(
          doneError,
          doneError ? doneError.message : RLS_HINT,
          { rlsBlocked: true, code: doneError?.code ?? 'RLS_NO_UPDATE' }
        ),
    }
  }

  const result = await ensurePlayingItem(venueId, {
    excludeIds: exclude,
    autoplayEnabled: options?.autoplayEnabled,
  })
  return { ...result, excludeIds: exclude }
}

export async function isVideoAlreadyInQueue(venueId: string, videoId: string) {
  const { data, error } = await supabase
    .from('queue_items')
    .select('id')
    .eq('venue_id', venueId)
    .eq('video_id', videoId)
    .in('status', ['queued', 'playing'])
    .limit(1)

  if (error) return { exists: false, error: toError(error, 'No se pudo verificar la cola') }
  return { exists: (data?.length ?? 0) > 0, error: null }
}

export type VoteTally = {
  up: number
  down: number
  total: number
  /** 👎 que cuentan tras restar 👍 (si upCancelsDown) */
  effectiveDown: number
  downPercent: number
  myVote: 'up' | 'down' | null
  shouldSkip: boolean
  upCancelsDown: boolean
}

export function tallyVotes(
  votes: Array<{ vote: string; device_id?: string }>,
  opts: {
    deviceId?: string | null
    skipThresholdPercent: number
    minVotesToSkip: number
    /** Por defecto true: cada 👍 cancela un 👎 */
    upCancelsDown?: boolean
  }
): VoteTally {
  let up = 0
  let down = 0
  let myVote: 'up' | 'down' | null = null
  for (const v of votes) {
    if (v.vote === 'up') up++
    if (v.vote === 'down') down++
    if (opts.deviceId && v.device_id === opts.deviceId) {
      myVote = v.vote === 'up' || v.vote === 'down' ? v.vote : null
    }
  }
  const total = up + down
  const upCancelsDown = opts.upCancelsDown !== false
  const effectiveDown = upCancelsDown ? Math.max(0, down - up) : down
  const downPercent =
    total === 0 ? 0 : Math.round((effectiveDown / total) * 100)
  const shouldSkip =
    total >= opts.minVotesToSkip &&
    downPercent >= opts.skipThresholdPercent

  return {
    up,
    down,
    total,
    effectiveDown,
    downPercent,
    myVote,
    shouldSkip,
    upCancelsDown,
  }
}

export { RLS_HINT }
