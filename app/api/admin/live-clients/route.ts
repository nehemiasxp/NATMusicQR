import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyAdminPassword } from '@/lib/settings'
import { isDeviceApproved } from '@/lib/admin-devices'
import {
  banClient,
  isBanned,
  loadBanned,
  normalizeTableKey,
  unbanClient,
} from '@/lib/banned-clients'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

async function requireAdmin(request: NextRequest, body?: { password?: string; deviceId?: string }) {
  const password =
    body?.password ||
    request.headers.get('x-admin-password') ||
    request.nextUrl.searchParams.get('password')
  const deviceId =
    body?.deviceId ||
    request.headers.get('x-admin-device-id') ||
    request.nextUrl.searchParams.get('deviceId')

  if (!(await verifyAdminPassword(password))) {
    return { ok: false as const, status: 401, error: 'No autorizado' }
  }
  if (!(await isDeviceApproved(deviceId))) {
    return {
      ok: false as const,
      status: 403,
      error: 'Dispositivo no aprobado',
      code: 'DEVICE_PENDING',
    }
  }
  return { ok: true as const, deviceId: deviceId!.trim() }
}

export type ClientSong = {
  id: string
  title: string
  artist: string | null
  status: string
  addedAt: string
}

export type LiveClient = {
  key: string
  label: string
  deviceId: string | null
  tableKey: string
  requests: number
  inQueue: number
  playing: boolean
  lastActivity: string
  songs: ClientSong[]
  banned: boolean
}

/**
 * GET ?slug=natmusicqr&hours=4
 * Lista clientes activos (por mesa/device) y temas que pusieron.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: auth.code },
      { status: auth.status }
    )
  }

  const slug =
    request.nextUrl.searchParams.get('slug')?.trim() || 'natmusicqr'
  const hours = Math.min(
    24,
    Math.max(1, Number(request.nextUrl.searchParams.get('hours') || 6))
  )

  const supabase = getSupabase()
  const { data: venue } = await supabase
    .from('venues')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle()

  if (!venue) {
    return NextResponse.json({ error: 'Local no encontrado' }, { status: 404 })
  }

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

  const { data: rows, error } = await supabase
    .from('queue_items')
    .select(
      `
      id,
      status,
      added_at,
      added_by_table,
      added_by_device,
      videos (
        title,
        artist
      )
    `
    )
    .eq('venue_id', venue.id)
    .gte('added_at', since)
    .order('added_at', { ascending: false })
    .limit(400)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const banStore = await loadBanned(supabase)
  const map = new Map<string, LiveClient>()

  for (const row of rows ?? []) {
    const table = (row.added_by_table as string | null)?.trim() || null
    if (table?.toLowerCase().includes('autoplay')) continue

    const device = (row.added_by_device as string | null)?.trim() || null
    const tableKey = normalizeTableKey(table) || 'sin-mesa'
    // Agrupar por device si existe; si no, por mesa
    const key = device ? `dev:${device}` : `mesa:${tableKey}`
    const label = table || device || 'Desconocido'

    const video = row.videos as
      | { title?: string; artist?: string | null }
      | { title?: string; artist?: string | null }[]
      | null
    const v = Array.isArray(video) ? video[0] : video

    const song: ClientSong = {
      id: row.id as string,
      title: v?.title || 'Canción',
      artist: v?.artist ?? null,
      status: row.status as string,
      addedAt: row.added_at as string,
    }

    const existing = map.get(key)
    if (!existing) {
      map.set(key, {
        key,
        label,
        deviceId: device,
        tableKey,
        requests: 1,
        inQueue:
          row.status === 'queued' || row.status === 'playing' ? 1 : 0,
        playing: row.status === 'playing',
        lastActivity: row.added_at as string,
        songs: [song],
        banned: Boolean(
          isBanned(banStore, { deviceId: device, tableLabel: table })
        ),
      })
    } else {
      existing.requests += 1
      if (row.status === 'queued' || row.status === 'playing') {
        existing.inQueue += 1
      }
      if (row.status === 'playing') existing.playing = true
      if ((row.added_at as string) > existing.lastActivity) {
        existing.lastActivity = row.added_at as string
        existing.label = label
      }
      if (existing.songs.length < 12) existing.songs.push(song)
    }
  }

  const clients = Array.from(map.values()).sort((a, b) => {
    if (a.playing !== b.playing) return a.playing ? -1 : 1
    if (a.inQueue !== b.inQueue) return b.inQueue - a.inQueue
    return a.lastActivity < b.lastActivity ? 1 : -1
  })

  return NextResponse.json({
    ok: true,
    venue,
    hours,
    clients,
    banned: banStore.banned,
    serverTime: new Date().toISOString(),
  })
}

/**
 * POST expulsar / desbloquear
 * { password, deviceId, action: 'kick'|'unban', targetDeviceId?, tableLabel?, banId?, label? }
 */
export async function POST(request: NextRequest) {
  let body: {
    password?: string
    deviceId?: string
    action?: string
    targetDeviceId?: string
    tableLabel?: string
    banId?: string
    label?: string
    reason?: string
    venueSlug?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const auth = await requireAdmin(request, body)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: auth.code },
      { status: auth.status }
    )
  }

  const action = body.action
  const supabase = getSupabase()

  if (action === 'unban') {
    if (!body.banId) {
      return NextResponse.json({ error: 'Falta banId' }, { status: 400 })
    }
    const result = await unbanClient({ banId: body.banId, supabase })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }
    const store = await loadBanned(supabase)
    return NextResponse.json({ ok: true, banned: store.banned })
  }

  if (action === 'kick') {
    const targetDevice = body.targetDeviceId?.trim() || null
    const tableLabel = body.tableLabel?.trim() || null
    const label =
      body.label?.trim() || tableLabel || targetDevice || 'Cliente'

    const banned = await banClient({
      deviceId: targetDevice,
      tableLabel,
      label,
      reason: body.reason || 'Expulsado por admin',
      bannedBy: auth.deviceId,
      supabase,
    })
    if (!banned.ok) {
      return NextResponse.json({ error: banned.error }, { status: 400 })
    }

    // Quitar de la cola sus canciones pendientes
    const slug = body.venueSlug?.trim() || 'natmusicqr'
    const { data: venue } = await supabase
      .from('venues')
      .select('id')
      .eq('slug', slug)
      .maybeSingle()

    let cleared = 0
    if (venue) {
      let q = supabase
        .from('queue_items')
        .update({ status: 'skipped' })
        .eq('venue_id', venue.id)
        .in('status', ['queued', 'playing'])

      if (targetDevice) {
        q = q.eq('added_by_device', targetDevice)
      } else if (tableLabel) {
        // mesa: match por prefijo en added_by_table es difícil; traemos y filtramos
        const { data: active } = await supabase
          .from('queue_items')
          .select('id, added_by_table, status')
          .eq('venue_id', venue.id)
          .in('status', ['queued', 'playing'])

        const key = normalizeTableKey(tableLabel)
        const ids = (active ?? [])
          .filter(
            (r) =>
              normalizeTableKey(r.added_by_table as string) === key
          )
          .map((r) => r.id)

        if (ids.length) {
          const { data: upd } = await supabase
            .from('queue_items')
            .update({ status: 'skipped' })
            .in('id', ids)
            .select('id')
          cleared = upd?.length ?? 0
        }

        const store = await loadBanned(supabase)
        return NextResponse.json({
          ok: true,
          cleared,
          ban: banned.entry,
          banned: store.banned,
          message: `Expulsado · ${cleared} canción(es) quitadas de la cola`,
        })
      }

      if (targetDevice) {
        const { data: upd } = await q.select('id')
        cleared = upd?.length ?? 0
      }
    }

    const store = await loadBanned(supabase)
    return NextResponse.json({
      ok: true,
      cleared,
      ban: banned.entry,
      banned: store.banned,
      message: `Expulsado · ${cleared} canción(es) quitadas de la cola`,
    })
  }

  return NextResponse.json({ error: 'Acción inválida' }, { status: 400 })
}
