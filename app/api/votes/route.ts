import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkVenueAccess } from '@/lib/access'
import { tallyVotes } from '@/lib/queue'
import { getRuntimeConfig } from '@/lib/settings'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

/** GET ?queueItemId=&deviceId= → conteo de votos */
export async function GET(request: NextRequest) {
  const queueItemId = request.nextUrl.searchParams.get('queueItemId')?.trim()
  const deviceId = request.nextUrl.searchParams.get('deviceId')?.trim() || null

  if (!queueItemId) {
    return NextResponse.json({ error: 'Falta queueItemId' }, { status: 400 })
  }

  const cfg = await getRuntimeConfig()
  if (!cfg.voting.enabled) {
    return NextResponse.json({
      enabled: false,
      up: 0,
      down: 0,
      total: 0,
      downPercent: 0,
      myVote: null,
      shouldSkip: false,
      skipThresholdPercent: cfg.voting.skipThresholdPercent,
      minVotesToSkip: cfg.voting.minVotesToSkip,
    })
  }

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('song_votes')
    .select('vote, device_id')
    .eq('queue_item_id', queueItemId)

  if (error) {
    return NextResponse.json(
      {
        error: error.message,
        hint: 'Ejecuta supabase-votes-autoplay.sql en Supabase',
      },
      { status: 500 }
    )
  }

  const tally = tallyVotes(data ?? [], {
    deviceId,
    skipThresholdPercent: cfg.voting.skipThresholdPercent,
    minVotesToSkip: cfg.voting.minVotesToSkip,
    upCancelsDown: cfg.voting.upCancelsDown,
  })

  return NextResponse.json({
    enabled: true,
    ...tally,
    skipThresholdPercent: cfg.voting.skipThresholdPercent,
    minVotesToSkip: cfg.voting.minVotesToSkip,
    upCancelsDown: cfg.voting.upCancelsDown,
  })
}

/** POST { venueSlug, queueItemId, deviceId, vote: up|down, accessPin? } */
export async function POST(request: NextRequest) {
  let body: {
    venueSlug?: string
    queueItemId?: string
    deviceId?: string
    vote?: string
    accessPin?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const venueSlug = body.venueSlug?.trim()
  const queueItemId = body.queueItemId?.trim()
  const deviceId = body.deviceId?.trim()?.slice(0, 80)
  const vote = body.vote === 'up' || body.vote === 'down' ? body.vote : null

  if (!venueSlug || !queueItemId || !deviceId || !vote) {
    return NextResponse.json(
      { error: 'Faltan venueSlug, queueItemId, deviceId o vote' },
      { status: 400 }
    )
  }

  const supabase = getSupabase()
  const cfg = await getRuntimeConfig(supabase)

  if (!cfg.voting.enabled) {
    return NextResponse.json(
      { error: 'Las votaciones están desactivadas' },
      { status: 403 }
    )
  }

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

  // Cualquier canción en playing: pedidos de mesa O autoplay del catálogo
  const { data: item } = await supabase
    .from('queue_items')
    .select('id, status, venue_id, added_by_table')
    .eq('id', queueItemId)
    .eq('venue_id', venue.id)
    .maybeSingle()

  if (!item || item.status !== 'playing') {
    return NextResponse.json(
      {
        error:
          'Solo se puede votar la canción en reproducción (pedidos o autoplay)',
      },
      { status: 400 }
    )
  }

  const { error: upsertError } = await supabase.from('song_votes').upsert(
    {
      venue_id: venue.id,
      queue_item_id: queueItemId,
      device_id: deviceId,
      vote,
    },
    { onConflict: 'queue_item_id,device_id' }
  )

  if (upsertError) {
    return NextResponse.json(
      {
        error: upsertError.message,
        hint: 'Ejecuta supabase-votes-autoplay.sql (tabla song_votes)',
      },
      { status: 500 }
    )
  }

  const { data: allVotes } = await supabase
    .from('song_votes')
    .select('vote, device_id')
    .eq('queue_item_id', queueItemId)

  const tally = tallyVotes(allVotes ?? [], {
    deviceId,
    skipThresholdPercent: cfg.voting.skipThresholdPercent,
    minVotesToSkip: cfg.voting.minVotesToSkip,
    upCancelsDown: cfg.voting.upCancelsDown,
  })

  return NextResponse.json({
    ok: true,
    enabled: true,
    ...tally,
    skipThresholdPercent: cfg.voting.skipThresholdPercent,
    minVotesToSkip: cfg.voting.minVotesToSkip,
    upCancelsDown: cfg.voting.upCancelsDown,
  })
}
