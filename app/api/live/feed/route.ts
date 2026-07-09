import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getRuntimeConfig } from '@/lib/settings'
import {
  COMMENT_MAX_PER_MIN,
  COMMENT_MIN_INTERVAL_MS,
  LIVE_FEED_WINDOW_MS,
  REACT_MAX_PER_MIN,
  REACT_MIN_INTERVAL_MS,
  buildAuthorLabel,
  sanitizeComment,
  type LiveFeedItem,
  type LiveFeedKind,
} from '@/lib/live-feed'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

function feedKey(venueId: string) {
  return `live_feed:${venueId}`
}

function newId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `lf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function prune(items: LiveFeedItem[]): LiveFeedItem[] {
  const floor = Date.now() - LIVE_FEED_WINDOW_MS
  return items
    .filter((i) => {
      const t = Date.parse(i.created_at)
      return !Number.isNaN(t) && t >= floor
    })
    .slice(-60)
}

/**
 * Storage en app_settings (tabla live_feed opcional no requerida).
 * Probado: upsert/select funcionan en producción con anon key.
 */
async function loadItems(
  supabase: SupabaseClient,
  venueId: string
): Promise<LiveFeedItem[]> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', feedKey(venueId))
    .maybeSingle()

  if (error) {
    console.error('[live/feed] read', error.message)
    return []
  }

  const raw = (data?.value as { items?: LiveFeedItem[] } | null)?.items
  if (!Array.isArray(raw)) return []
  return prune(raw)
}

async function saveItems(
  supabase: SupabaseClient,
  venueId: string,
  items: LiveFeedItem[]
) {
  const { error } = await supabase.from('app_settings').upsert(
    {
      key: feedKey(venueId),
      value: { items: prune(items) },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  )
  if (error) throw new Error(error.message)
}

/** GET ?venueSlug= → últimos eventos (ventana 90s) */
export async function GET(request: NextRequest) {
  const venueSlug = request.nextUrl.searchParams.get('venueSlug')?.trim()
  if (!venueSlug) {
    return NextResponse.json({ error: 'Falta venueSlug' }, { status: 400 })
  }

  const supabase = getSupabase()
  const { data: venue } = await supabase
    .from('venues')
    .select('id')
    .eq('slug', venueSlug)
    .maybeSingle()

  if (!venue) {
    return NextResponse.json({ error: 'Local no encontrado' }, { status: 404 })
  }

  try {
    const items = await loadItems(supabase, venue.id)
    // Orden cronológico (viejo → nuevo) para la TV
    items.sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
    )
    return NextResponse.json({
      ok: true,
      items,
      backend: 'settings',
      serverTime: new Date().toISOString(),
    })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : 'Error leyendo feed',
        items: [],
      },
      { status: 500 }
    )
  }
}

type Body = {
  venueSlug?: string
  kind?: string
  body?: string
  displayName?: string
  tableName?: string
  deviceId?: string
  queueItemId?: string
  accessPin?: string
}

/** POST: comment | like | dislike */
export async function POST(request: NextRequest) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const venueSlug = body.venueSlug?.trim()
  const deviceId = (body.deviceId?.trim() || 'anon').slice(0, 80)
  const kindRaw = body.kind?.trim()
  const kind: LiveFeedKind | null =
    kindRaw === 'comment' || kindRaw === 'like' || kindRaw === 'dislike'
      ? kindRaw
      : null

  if (!venueSlug || !kind) {
    return NextResponse.json(
      { error: 'Faltan venueSlug o kind' },
      { status: 400 }
    )
  }

  const supabase = getSupabase()
  const cfg = await getRuntimeConfig(supabase)

  // PIN/horario: si el join ya entró, no bloquear el feed social
  // (solo exigir si pinEnabled y se mandó pin incorrecto)
  if (cfg.access.pinEnabled && cfg.access.pin.trim()) {
    const pin = body.accessPin?.trim()
    if (pin && pin !== cfg.access.pin.trim()) {
      return NextResponse.json({ error: 'PIN incorrecto' }, { status: 401 })
    }
  }

  const { data: venue } = await supabase
    .from('venues')
    .select('id')
    .eq('slug', venueSlug)
    .maybeSingle()

  if (!venue) {
    return NextResponse.json({ error: 'Local no encontrado' }, { status: 404 })
  }

  const author = buildAuthorLabel({
    displayName: body.displayName,
    tableName: body.tableName,
  })

  let text: string | null = null
  if (kind === 'comment') {
    text = sanitizeComment(body.body)
    if (!text) {
      return NextResponse.json(
        {
          error:
            'Comentario no válido (vacío, muy largo o contenido bloqueado)',
        },
        { status: 400 }
      )
    }
  }

  // Anti-spam: leer feed actual
  let items: LiveFeedItem[] = []
  try {
    items = await loadItems(supabase, venue.id)
  } catch {
    items = []
  }

  const sinceMin = Date.now() - 60_000
  const recentSame = items
    .filter(
      (r) =>
        r.device_id === deviceId &&
        r.kind === kind &&
        Date.parse(r.created_at) >= sinceMin
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))

  const last = recentSame[0]
  if (last) {
    const age = Date.now() - Date.parse(last.created_at)
    const minGap =
      kind === 'comment' ? COMMENT_MIN_INTERVAL_MS : REACT_MIN_INTERVAL_MS
    if (age < minGap) {
      const wait = Math.ceil((minGap - age) / 1000)
      return NextResponse.json(
        {
          error:
            kind === 'comment'
              ? `Espera ${wait}s para otro comentario`
              : `Espera ${wait}s`,
          code: 'RATE_LIMIT',
          retryAfterSeconds: wait,
        },
        { status: 429 }
      )
    }
  }

  const maxPerMin =
    kind === 'comment' ? COMMENT_MAX_PER_MIN : REACT_MAX_PER_MIN
  if (recentSame.length >= maxPerMin) {
    return NextResponse.json(
      { error: 'Demasiados envíos. Respira un momento 😊', code: 'RATE_LIMIT' },
      { status: 429 }
    )
  }

  const item: LiveFeedItem = {
    id: newId(),
    venue_id: venue.id,
    kind,
    body: text,
    display_name: author.display_name,
    table_label: author.table_label,
    device_id: deviceId,
    queue_item_id: body.queueItemId?.trim() || null,
    created_at: new Date().toISOString(),
  }

  try {
    // Re-read + append (reduce race)
    const latest = await loadItems(supabase, venue.id)
    latest.push(item)
    await saveItems(supabase, venue.id, latest)
    return NextResponse.json({ ok: true, item, backend: 'settings' })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : 'No se pudo publicar',
        hint: 'Revisa políticas RLS de app_settings (INSERT/UPDATE).',
      },
      { status: 500 }
    )
  }
}
