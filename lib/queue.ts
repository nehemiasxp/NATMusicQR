import { supabase } from '@/lib/supabase'
import { QUEUE_SELECT, type QueueItem } from '@/lib/types'

export type QueueError = {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
  /** true = Supabase no aplicó el UPDATE (casi siempre RLS) */
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

/**
 * Asegura un item "playing".
 * Si RLS bloquea el UPDATE, devuelve el primer queued como playing local
 * (para que la TV reproduzca igual) y marca rlsBlocked.
 */
export async function ensurePlayingItem(
  venueId: string,
  options?: { excludeIds?: Set<string> }
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
    // Reproduce localmente aunque falle el write
    const localPlaying = { ...next, status: 'playing' as const }
    return {
      items: visible.map((i) => (i.id === next.id ? localPlaying : i)),
      playing: localPlaying,
      error: toError(updateError, 'No se pudo marcar como playing'),
      rlsBlocked: true,
    }
  }

  // RLS a veces devuelve 200 sin error y 0 filas → el status no cambió
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
 * Marca el actual como played y arranca el siguiente.
 * Si RLS bloquea writes, excluye el id actual y avanza en local.
 */
export async function advanceQueue(
  venueId: string,
  currentItemId: string,
  options?: { excludeIds?: Set<string> }
) {
  const exclude = new Set(options?.excludeIds ?? [])

  const { data: updated, error: doneError } = await supabase
    .from('queue_items')
    .update({ status: 'played' })
    .eq('id', currentItemId)
    .in('status', ['playing', 'queued'])
    .select('id')

  if (doneError || !updated || updated.length === 0) {
    // Avance local: no volvemos a tocar este id en esta sesión
    exclude.add(currentItemId)
    const result = await ensurePlayingItem(venueId, { excludeIds: exclude })
    return {
      ...result,
      excludeIds: exclude,
      rlsBlocked: true as boolean,
      error:
        result.error ??
        toError(
          doneError,
          doneError
            ? doneError.message
            : RLS_HINT,
          { rlsBlocked: true, code: doneError?.code ?? 'RLS_NO_UPDATE' }
        ),
    }
  }

  const result = await ensurePlayingItem(venueId, { excludeIds: exclude })
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

export { RLS_HINT }
