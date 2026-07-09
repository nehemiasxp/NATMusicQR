import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { checkVenueAccess } from '@/lib/access'
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

function feedSettingsKey(venueId: string) {
  return `live_feed:${venueId}`
}

function newId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `lf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function pruneItems(items: LiveFeedItem[]): LiveFeedItem[] {
  const floor = Date.now() - LIVE_FEED_WINDOW_MS
  return items
    .filter((i) => {
      const t = Date.parse(i.created_at)
      return !Number.isNaN(t) && t >= floor
    })
    .slice(-50)
}

/** Lee feed desde tabla live_feed o fallback app_settings */
async function readFeed(
  supabase: SupabaseClient,
  venueId: string,
  sinceIso: string
): Promise<{ items: LiveFeedItem[]; backend: 'table' | 'settings' }> {
  const { data, error } = await supabase
    .from('live_feed')
    .select(
      'id, venue_id, kind, body, display_name, table_label, device_id, queue_item_id, created_at'
    )
    .eq('venue_id', venueId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(40)

  if (!error) {
    return { items: (data ?? []) as LiveFeedItem[], backend: 'table' }
  }

  // Fallback: app_settings (sin migración SQL)
  const key = feedSettingsKey(venueId)
  const { data: row } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle()

  const raw = (row?.value as { items?: LiveFeedItem[] } | null)?.items ?? []
  const items = pruneItems(raw).filter(
    (i) => Date.parse(i.created_at) >= Date.parse(sinceIso)
  )
  return { items, backend: 'settings' }
}

async function appendFeed(
  supabase: SupabaseClient,
  venueId: string,
  item: Omit<LiveFeedItem, 'id' | 'created_at'> & {
    id?: string
    created_at?: string
  }
): Promise<{ item: LiveFeedItem; backend: 'table' | 'settings' }> {
  const full: LiveFeedItem = {
    id: item.id ?? newId(),
    venue_id: venueId,
    kind: item.kind,
    body: item.body,
    display_name: item.display_name,
    table_label: item.table_label,
    device_id: item.device_id,
    queue_item_id: item.queue_item_id,
    created_at: item.created_at ?? new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('live_feed')
    .insert({
      id: full.id,
      venue_id: full.venue_id,
      kind: full.kind,
      body: full.body,
      display_name: full.display_name,
      table_label: full.table_label,
      device_id: full.device_id,
      queue_item_id: full.queue_item_id,
      created_at: full.created_at,
    })
    .select(
      'id, venue_id, kind, body, display_name, table_label, device_id, queue_item_id, created_at'
    )
    .single()

  if (!error && data) {
    return { item: data as LiveFeedItem, backend: 'table' }
  }

  // Fallback app_settings
  const key = feedSettingsKey(venueId)
  const { data: row } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle()

  const prev = (row?.value as { items?: LiveFeedItem[] } | null)?.items ?? []
  const items = pruneItems([...prev, full])

  const { error: upErr } = await supabase.from('app_settings').upsert(
    {
      key,
      value: { items },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  )

  if (upErr) {
    throw new Error(
      upErr.message ||
        error?.message ||
        'No se pudo guardar el feed (live_feed ni app_settings)'
    )
  }

  return { item: full, backend: 'settings' }
}

async function recentForDevice(
  supabase: SupabaseClient,
  venueId: string,
  deviceId: string
): Promise<LiveFeedItem[]> {
  const sinceMin = new Date(Date.now() - 60_000).toISOString()
  const { items } = await readFeed(supabase, venueId, sinceMin)
  return items.filter((i) => i.device_id === deviceId)
}

/** GET ?venueSlug= &since=iso */
export async function GET(request: NextRequest) {
  const venueSlug = request.nextUrl.searchParams.get('venueSlug')?.trim()
  const sinceParam = request.nextUrl.searchParams.get('since')?.trim()

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

  const floor = new Date(Date.now() - LIVE_FEED_WINDOW_MS).toISOString()
  let since = floor
  if (sinceParam) {
    const t = Date.parse(sinceParam)
    if (!Number.isNaN(t)) {
      since = new Date(Math.max(t, Date.parse(floor))).toISOString()
    }
  }

  try {
    const { items, backend } = await readFeed(supabase, venue.id, since)
    return NextResponse.json({
      ok: true,
      items,
      backend,
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
  const deviceId = body.deviceId?.trim()?.slice(0, 80)
  const kindRaw = body.kind?.trim()
  const kind: LiveFeedKind | null =
    kindRaw === 'comment' || kindRaw === 'like' || kindRaw === 'dislike'
      ? kindRaw
      : null

  if (!venueSlug || !deviceId || !kind) {
    return NextResponse.json(
      { error: 'Faltan venueSlug, deviceId o kind' },
      { status: 400 }
    )
  }

  const supabase = getSupabase()
  const cfg = await getRuntimeConfig(supabase)

  const access = checkVenueAccess(cfg, { pin: body.accessPin })
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error, code: access.code },
      { status: access.code === 'CLOSED' ? 403 : 401 }
    )
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
            'Comentario no válido (vacío, demasiado largo o contenido bloqueado)',
        },
        { status: 400 }
      )
    }
  }

  let recent: LiveFeedItem[] = []
  try {
    recent = await recentForDevice(supabase, venue.id, deviceId)
  } catch {
    recent = []
  }

  const sameKind = recent
    .filter((r) => r.kind === kind)
    .sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
    )
  const lastSame = sameKind[0]
  if (lastSame) {
    const age = Date.now() - Date.parse(lastSame.created_at)
    const minGap =
      kind === 'comment' ? COMMENT_MIN_INTERVAL_MS : REACT_MIN_INTERVAL_MS
    if (age < minGap) {
      const wait = Math.ceil((minGap - age) / 1000)
      return NextResponse.json(
        {
          error:
            kind === 'comment'
              ? `Espera ${wait}s para otro comentario (anti-spam)`
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
  if (sameKind.length >= maxPerMin) {
    return NextResponse.json(
      {
        error: 'Demasiados envíos. Respira un momento 😊',
        code: 'RATE_LIMIT',
      },
      { status: 429 }
    )
  }

  try {
    const { item, backend } = await appendFeed(supabase, venue.id, {
      venue_id: venue.id,
      kind,
      body: text,
      display_name: author.display_name,
      table_label: author.table_label,
      device_id: deviceId,
      queue_item_id: body.queueItemId?.trim() || null,
    })

    return NextResponse.json({ ok: true, item, backend })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : 'No se pudo publicar',
        hint: 'Opcional: ejecuta supabase-live-feed.sql para tabla dedicada. Mientras, usa app_settings.',
      },
      { status: 500 }
    )
  }
}
