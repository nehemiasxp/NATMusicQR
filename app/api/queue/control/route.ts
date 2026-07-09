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
  action?: Action
  queueItemId?: string
}

/**
 * Super poderes de mesa i9:
 * - next: salta la actual → siguiente (con autoplay si está activo)
 * - cancel_direct: cancela la que suena (promueve cola, sin autoplay)
 * - cancel_all: vacía playing + queued
 * - remove: quita un item; si era playing, promueve siguiente
 */
export async function POST(request: NextRequest) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const venueSlug = body.venueSlug?.trim()
  const tableName = body.tableName?.trim() || ''
  const action = body.action
  const queueItemId = body.queueItemId?.trim()

  if (!venueSlug) {
    return NextResponse.json({ error: 'Falta venueSlug' }, { status: 400 })
  }
  if (!isSuperMesa(tableName)) {
    return NextResponse.json(
      {
        error:
          'Sin super poderes. Entra con mesa o nombre "i9" y vuelve a intentarlo.',
        code: 'NOT_SUPER',
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
    return NextResponse.json(
      {
        error:
          'Acción inválida. Usa: next | cancel_direct | cancel_all | remove',
      },
      { status: 400 }
    )
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
          { error: 'Falta queueItemId para eliminar' },
          { status: 400 }
        )
      }

      const { data: item, error: findErr } = await supabase
        .from('queue_items')
        .select('id, status')
        .eq('id', queueItemId)
        .eq('venue_id', venue.id)
        .maybeSingle()

      if (findErr) {
        return NextResponse.json({ error: findErr.message }, { status: 500 })
      }
      if (!item || (item.status !== 'queued' && item.status !== 'playing')) {
        return NextResponse.json(
          { error: 'Esa canción ya no está en la cola' },
          { status: 404 }
        )
      }

      const wasPlaying = item.status === 'playing'
      await forceStatus(supabase, item.id, venue.id, 'skipped')

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
        skippedId: item.id,
        playingId: snapshot.playing?.id ?? null,
        message: wasPlaying
          ? snapshot.playing
            ? 'Eliminada · ahora suena la siguiente'
            : 'Eliminada · no hay más en cola'
          : 'Canción eliminada de la cola',
        queue: snapshot,
      })
    }

    if (action === 'cancel_all') {
      const { data: before, error: listErr } = await supabase
        .from('queue_items')
        .select('id')
        .eq('venue_id', venue.id)
        .in('status', ['queued', 'playing'])

      if (listErr) {
        return NextResponse.json({ error: listErr.message }, { status: 500 })
      }

      const pending = before ?? []
      if (pending.length === 0) {
        return NextResponse.json({
          ok: true,
          action: 'cancel_all',
          cleared: 0,
          playingId: null,
          message: 'La cola ya estaba vacía',
          queue: { items: [], playing: null },
        })
      }

      const { data: updated, error: clearError } = await supabase
        .from('queue_items')
        .update({ status: 'skipped' })
        .eq('venue_id', venue.id)
        .in('status', ['queued', 'playing'])
        .select('id')

      if (clearError) {
        return NextResponse.json({ error: clearError.message }, { status: 500 })
      }
      if (!updated || updated.length === 0) {
        throw new Error(
          'No se pudo vaciar la cola (0 filas). Revisa políticas RLS de queue_items (UPDATE).'
        )
      }

      // No autoplay tras cancelar todo: silencio hasta el próximo pedido
      const snapshot = await activeSnapshot(supabase, venue.id)
      return NextResponse.json({
        ok: true,
        action: 'cancel_all',
        cleared: updated.length,
        playingId: null,
        message: `Cola vaciada (${updated.length} cancelada${updated.length === 1 ? '' : 's'})`,
        queue: snapshot,
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

    await forceStatus(supabase, playing.id, venue.id, 'skipped')

    // next: puede autoplay; cancel_direct: solo cola de pedidos
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
            ? 'Cancelada en reproducción · siguiente en cola'
            : 'Música en reproducción cancelada'
          : promoted
            ? 'Siguiente canción en marcha'
            : 'Saltada · no hay más en cola',
      queue: snapshot,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error en control de cola'
    const isRls = /RLS|row-level|0 filas|no se pudo actualizar/i.test(msg)
    return NextResponse.json(
      {
        error: msg,
        hint: isRls
          ? 'Ejecuta supabase-rls-fix.sql o supabase-ONE-SHOT.sql en Supabase (política UPDATE en queue_items).'
          : undefined,
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

/**
 * Marca status y verifica que el UPDATE aplicó (detecta RLS silencioso).
 */
async function forceStatus(
  supabase: SupabaseClient,
  id: string,
  venueId: string,
  status: 'skipped' | 'played' | 'playing' | 'queued'
): Promise<boolean> {
  const { data, error } = await supabase
    .from('queue_items')
    .update({
      status,
      ...(status === 'playing' ? { played_at: new Date().toISOString() } : {}),
    })
    .eq('id', id)
    .eq('venue_id', venueId)
    .select('id')

  if (error) {
    throw new Error(error.message)
  }
  if (!data || data.length === 0) {
    throw new Error(
      'No se pudo actualizar la cola (0 filas). Revisa políticas RLS de queue_items (UPDATE).'
    )
  }
  return true
}

async function promoteNext(
  supabase: SupabaseClient,
  venueId: string,
  autoplayEnabled: boolean
): Promise<{ id: string } | null> {
  // Evitar dos "playing" a la vez: si ya hay una, no promocionar
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
    await forceStatus(supabase, next.id, venueId, 'playing')
    return next
  }

  if (!autoplayEnabled) return null

  const { data: videos, error: vErr } = await supabase
    .from('videos')
    .select('id, youtube_id')
    .eq('venue_id', venueId)
    .eq('is_active', true)

  if (vErr) throw new Error(vErr.message)
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
