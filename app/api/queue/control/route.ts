import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isSuperMesa } from '@/lib/super-mesa'
import { getRuntimeConfig } from '@/lib/settings'
import { QUEUE_SELECT, type QueueItem } from '@/lib/types'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

type Action = 'next' | 'cancel_direct' | 'cancel_all' | 'remove'

type Body = {
  venueSlug?: string
  tableName?: string
  displayName?: string
  action?: Action
  queueItemId?: string
}

export async function POST(request: NextRequest) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const venueSlug = body.venueSlug?.trim()
  const tableName = body.tableName?.trim() || ''
  const displayName = body.displayName?.trim() || ''
  const action = body.action
  const queueItemId = body.queueItemId?.trim()

  if (!venueSlug) {
    return NextResponse.json({ error: 'Falta venueSlug' }, { status: 400 })
  }

  // Acepta i9 en mesa, nombre, o label combinado
  const superOk =
    isSuperMesa(tableName) ||
    isSuperMesa(displayName) ||
    isSuperMesa(
      displayName ? `${tableName} · ${displayName}` : tableName
    )

  if (!superOk) {
    return NextResponse.json(
      {
        error:
          'Sin super poderes. En mesa o nombre pon exactamente: i9 (luego recarga).',
        code: 'NOT_SUPER',
        got: { tableName, displayName },
      },
      { status: 403 }
    )
  }

  if (
    action !== 'next' &&
    action !== 'cancel_direct' &&
    action !== 'cancel_all' &&
    action !== 'remove'
  ) {
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 })
  }

  const supabase = getSupabase()
  const cfg = await getRuntimeConfig(supabase)

  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id, slug, name')
    .eq('slug', venueSlug)
    .maybeSingle()

  if (venueError || !venue) {
    return NextResponse.json(
      { error: venueError?.message || 'Local no encontrado' },
      { status: 404 }
    )
  }

  try {
    if (action === 'remove') {
      if (!queueItemId) {
        return NextResponse.json(
          { error: 'Falta queueItemId' },
          { status: 400 }
        )
      }
      const { data: item } = await supabase
        .from('queue_items')
        .select('id, status')
        .eq('id', queueItemId)
        .eq('venue_id', venue.id)
        .maybeSingle()

      if (!item || (item.status !== 'queued' && item.status !== 'playing')) {
        return NextResponse.json(
          { error: 'Esa canción ya no está en la cola' },
          { status: 404 }
        )
      }

      const wasPlaying = item.status === 'playing'
      await skipIds(supabase, venue.id, [item.id])
      if (wasPlaying) {
        await promoteNext(
          supabase,
          venue.id,
          Boolean(cfg.autoplayMusic?.enabled)
        )
      }
      const snapshot = await activeSnapshot(supabase, venue.id)
      return NextResponse.json({
        ok: true,
        action: 'remove',
        message: wasPlaying
          ? 'Eliminada · siguiente'
          : 'Eliminada de la cola',
        queue: snapshot,
      })
    }

    if (action === 'cancel_all') {
      const { data: active } = await supabase
        .from('queue_items')
        .select('id')
        .eq('venue_id', venue.id)
        .in('status', ['queued', 'playing'])

      const ids = (active ?? []).map((r) => r.id)
      if (ids.length === 0) {
        return NextResponse.json({
          ok: true,
          action: 'cancel_all',
          cleared: 0,
          message: 'La cola ya estaba vacía',
          queue: { items: [], playing: null },
        })
      }

      const n = await skipIds(supabase, venue.id, ids)
      return NextResponse.json({
        ok: true,
        action: 'cancel_all',
        cleared: n,
        message: `Cola vaciada (${n})`,
        queue: { items: [], playing: null },
      })
    }

    // next | cancel_direct
    const playing = await findPlaying(supabase, venue.id)
    if (!playing) {
      return NextResponse.json(
        { error: 'No hay ninguna canción sonando', ok: false },
        { status: 400 }
      )
    }

    await skipIds(supabase, venue.id, [playing.id])
    const allowAutoplay =
      action === 'next' ? Boolean(cfg.autoplayMusic?.enabled) : false
    const promoted = await promoteNext(supabase, venue.id, allowAutoplay)
    const snapshot = await activeSnapshot(supabase, venue.id)

    return NextResponse.json({
      ok: true,
      action,
      skippedId: playing.id,
      nextId: promoted?.id ?? null,
      playingId: snapshot.playing?.id ?? null,
      message:
        action === 'cancel_direct'
          ? promoted
            ? 'Cancelada · siguiente en cola'
            : 'Música en reproducción cancelada'
          : promoted
            ? 'Siguiente canción en marcha'
            : 'Saltada · no hay más en cola',
      queue: snapshot,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error en control'
    return NextResponse.json(
      {
        error: msg,
        hint: 'Si dice 0 filas: políticas RLS UPDATE en queue_items. Ejecuta supabase-rls-fix.sql',
      },
      { status: 500 }
    )
  }
}

async function findPlaying(supabase: SupabaseClient, venueId: string) {
  const { data, error } = await supabase
    .from('queue_items')
    .select('id, status')
    .eq('venue_id', venueId)
    .eq('status', 'playing')
    .order('played_at', { ascending: true, nullsFirst: false })
    .limit(1)

  if (error) throw new Error(error.message)
  return data?.[0] ?? null
}

/** Marca skipped; no falla si ya estaban skipped */
async function skipIds(
  supabase: SupabaseClient,
  venueId: string,
  ids: string[]
): Promise<number> {
  if (!ids.length) return 0
  const { data, error } = await supabase
    .from('queue_items')
    .update({ status: 'skipped' })
    .eq('venue_id', venueId)
    .in('id', ids)
    .in('status', ['queued', 'playing'])
    .select('id')

  if (error) throw new Error(error.message)
  return data?.length ?? 0
}

async function promoteNext(
  supabase: SupabaseClient,
  venueId: string,
  autoplayEnabled: boolean
): Promise<{ id: string } | null> {
  const existing = await findPlaying(supabase, venueId)
  if (existing) return existing

  const { data: nextRows, error } = await supabase
    .from('queue_items')
    .select('id')
    .eq('venue_id', venueId)
    .eq('status', 'queued')
    .order('added_at', { ascending: true })
    .limit(1)

  if (error) throw new Error(error.message)
  const next = nextRows?.[0]
  if (next) {
    const { data, error: upErr } = await supabase
      .from('queue_items')
      .update({
        status: 'playing',
        played_at: new Date().toISOString(),
      })
      .eq('id', next.id)
      .eq('status', 'queued')
      .select('id')

    if (upErr) throw new Error(upErr.message)
    if (!data?.length) {
      // carrera: otro proceso lo tomó
      return (await findPlaying(supabase, venueId)) ?? next
    }
    return next
  }

  if (!autoplayEnabled) return null

  const { data: videos } = await supabase
    .from('videos')
    .select('id, youtube_id')
    .eq('venue_id', venueId)
    .eq('is_active', true)

  const withYt = (videos ?? []).filter((v) => v.youtube_id)
  if (!withYt.length) return null

  const pick = withYt[Math.floor(Math.random() * withYt.length)]
  const { data: inserted, error: insErr } = await supabase
    .from('queue_items')
    .insert({
      venue_id: venueId,
      video_id: pick.id,
      status: 'playing',
      played_at: new Date().toISOString(),
      added_by_table: 'Autoplay 🎵',
    })
    .select('id')
    .single()

  if (insErr) throw new Error(insErr.message)
  return inserted
}

async function activeSnapshot(supabase: SupabaseClient, venueId: string) {
  const { data, error } = await supabase
    .from('queue_items')
    .select(QUEUE_SELECT)
    .eq('venue_id', venueId)
    .in('status', ['queued', 'playing'])
    .order('added_at', { ascending: true })

  if (error) {
    return { items: [] as QueueItem[], playing: null as QueueItem | null }
  }
  const items = (data ?? []) as unknown as QueueItem[]
  const playing =
    items.find((i) => i.status === 'playing' && i.videos?.youtube_id) ?? null
  return { items, playing }
}
