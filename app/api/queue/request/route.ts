import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkVenueAccess } from '@/lib/access'
import { checkRequestRateLimits, getClientIp } from '@/lib/rate-limit'
import { getRuntimeConfig } from '@/lib/settings'
import { isSuperMesa } from '@/lib/super-mesa'
import { isBanned, loadBanned } from '@/lib/banned-clients'
import { getYoutubeApiKey, validateYoutubeVideo } from '@/lib/youtube'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error('Faltan variables de Supabase')
  }
  return createClient(url, key)
}

type Body = {
  venueSlug?: string
  youtubeId?: string
  videoId?: string
  tableName?: string
  deviceId?: string
  accessPin?: string
  skipYoutubeCheck?: boolean
}

export async function POST(request: NextRequest) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const venueSlug = body.venueSlug?.trim()
  const tableName = (body.tableName?.trim() || 'Mesa').slice(0, 60)
  const youtubeId = body.youtubeId?.trim()
  const catalogVideoId = body.videoId?.trim()
  const deviceId = body.deviceId?.trim()?.slice(0, 80) || null
  const accessPin = body.accessPin?.trim() || null
  const ip = getClientIp(request)

  if (!venueSlug) {
    return NextResponse.json({ error: 'Falta venueSlug' }, { status: 400 })
  }
  if (!youtubeId && !catalogVideoId) {
    return NextResponse.json(
      { error: 'Falta youtubeId o videoId' },
      { status: 400 }
    )
  }

  const supabase = getSupabase()
  const cfg = await getRuntimeConfig(supabase)

  const access = checkVenueAccess(cfg, { pin: accessPin })
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error, code: access.code },
      { status: access.code === 'CLOSED' ? 403 : 401 }
    )
  }

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

  // Expulsados: no pueden pedir
  if (!isSuperMesa(tableName)) {
    try {
      const banStore = await loadBanned(supabase)
      const ban = isBanned(banStore, {
        deviceId,
        tableLabel: tableName,
      })
      if (ban) {
        return NextResponse.json(
          {
            error:
              'Fuiste expulsado del jukebox. Habla con el personal del local.',
            code: 'BANNED',
          },
          { status: 403 }
        )
      }
    } catch {
      /* si falla ban store, no bloquear el local */
    }
  }

  // Mesa i9: sin cuotas (super poderes)
  if (!isSuperMesa(tableName)) {
    const limits = await checkRequestRateLimits(supabase, {
      venueId: venue.id,
      tableLabel: tableName,
      deviceId,
      ip,
      config: cfg,
    })
    if (!limits.ok) {
      return NextResponse.json(
        {
          error: limits.error,
          code: limits.code,
          retryAfterMinutes: limits.retryAfterMinutes,
        },
        { status: 429 }
      )
    }
  }

  let resolvedYoutubeId = youtubeId
  let title = ''
  let artist: string | null = null
  let thumbnailUrl: string | null = null
  let durationSeconds: number | null = null
  let videoRowId = catalogVideoId ?? null

  if (catalogVideoId) {
    const { data: existing, error: vidErr } = await supabase
      .from('videos')
      .select(
        'id, youtube_id, title, artist, thumbnail_url, duration_seconds, is_active'
      )
      .eq('id', catalogVideoId)
      .eq('venue_id', venue.id)
      .maybeSingle()

    if (vidErr || !existing) {
      return NextResponse.json(
        { error: vidErr?.message || 'Video del catálogo no encontrado' },
        { status: 404 }
      )
    }

    resolvedYoutubeId = existing.youtube_id
    title = existing.title
    artist = existing.artist
    thumbnailUrl = existing.thumbnail_url
    durationSeconds = existing.duration_seconds
    videoRowId = existing.id

    if (
      durationSeconds != null &&
      durationSeconds > cfg.maxDurationSeconds
    ) {
      return NextResponse.json(
        {
          error: `La canción supera el máximo de ${Math.round(cfg.maxDurationSeconds / 60)} min`,
          code: 'DURATION_LIMIT',
        },
        { status: 422 }
      )
    }
  }

  const shouldValidate =
    !body.skipYoutubeCheck &&
    Boolean(getYoutubeApiKey()) &&
    Boolean(resolvedYoutubeId)

  if (shouldValidate && resolvedYoutubeId) {
    try {
      const v = await validateYoutubeVideo(resolvedYoutubeId, {
        maxDurationSeconds: cfg.maxDurationSeconds,
      })
      if (!v.playable) {
        return NextResponse.json(
          {
            error: 'Este video no se puede reproducir en el jukebox',
            reasons: v.reasons,
            playable: false,
          },
          { status: 422 }
        )
      }
      resolvedYoutubeId = v.youtubeId
      title = v.title || title
      artist = v.channelTitle || artist
      thumbnailUrl = v.thumbnailUrl || thumbnailUrl
      durationSeconds = v.durationSeconds
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error validando YouTube'
      if (!catalogVideoId) {
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }
  } else if (!catalogVideoId && !getYoutubeApiKey()) {
    return NextResponse.json(
      {
        error:
          'Falta YOUTUBE_API_KEY para pedir canciones de búsqueda. Usa el catálogo del local o configura la clave.',
        code: 'MISSING_API_KEY',
      },
      { status: 503 }
    )
  }

  if (!resolvedYoutubeId) {
    return NextResponse.json({ error: 'youtubeId inválido' }, { status: 400 })
  }

  if (!videoRowId) {
    const { data: found } = await supabase
      .from('videos')
      .select('id')
      .eq('venue_id', venue.id)
      .eq('youtube_id', resolvedYoutubeId)
      .maybeSingle()

    if (found?.id) {
      videoRowId = found.id
      await supabase
        .from('videos')
        .update({
          title: title || undefined,
          artist,
          thumbnail_url: thumbnailUrl,
          duration_seconds: durationSeconds,
          is_active: true,
        })
        .eq('id', found.id)
    } else {
      const { data: inserted, error: insertVideoError } = await supabase
        .from('videos')
        .insert({
          venue_id: venue.id,
          youtube_id: resolvedYoutubeId,
          title: title || resolvedYoutubeId,
          artist,
          thumbnail_url: thumbnailUrl,
          duration_seconds: durationSeconds,
          category: 'YouTube',
          is_active: true,
        })
        .select('id')
        .single()

      if (insertVideoError || !inserted) {
        return NextResponse.json(
          {
            error:
              insertVideoError?.message ||
              'No se pudo guardar el video. ¿Falta política INSERT en videos (RLS)?',
            code: insertVideoError?.code,
          },
          { status: 403 }
        )
      }
      videoRowId = inserted.id
    }
  }

  if (cfg.blockDuplicateInQueue) {
    const { data: dup } = await supabase
      .from('queue_items')
      .select('id')
      .eq('venue_id', venue.id)
      .eq('video_id', videoRowId)
      .in('status', ['queued', 'playing'])
      .limit(1)

    if (dup && dup.length > 0) {
      return NextResponse.json(
        { error: 'Esa canción ya está en la cola', alreadyInQueue: true },
        { status: 409 }
      )
    }
  }

  const baseInsert = {
    venue_id: venue.id,
    video_id: videoRowId,
    status: 'queued' as const,
    added_by_table: tableName,
    added_by_ip: ip,
    added_by_device: deviceId,
  }

  const { data: queueItem, error: queueError } = await supabase
    .from('queue_items')
    .insert(baseInsert)
    .select('id, status, added_at')
    .single()

  if (queueError || !queueItem) {
    // fallback sin device si la columna fallara
    if (queueError?.message?.includes('added_by_device')) {
      const { added_by_device: _, ...rest } = baseInsert
      const fb = await supabase
        .from('queue_items')
        .insert(rest)
        .select('id, status, added_at')
        .single()
      if (fb.data) {
        return NextResponse.json({
          ok: true,
          queueItem: fb.data,
          video: {
            id: videoRowId,
            youtube_id: resolvedYoutubeId,
            title,
            artist,
            thumbnail_url: thumbnailUrl,
            duration_seconds: durationSeconds,
          },
          limits: {
            maxDurationSeconds: cfg.maxDurationSeconds,
            perTable: cfg.perTable,
            perDevice: cfg.perDevice,
          },
        })
      }
    }

    return NextResponse.json(
      {
        error: queueError?.message || 'No se pudo agregar a la cola',
        code: queueError?.code,
      },
      { status: 403 }
    )
  }

  return NextResponse.json({
    ok: true,
    queueItem,
    video: {
      id: videoRowId,
      youtube_id: resolvedYoutubeId,
      title,
      artist,
      thumbnail_url: thumbnailUrl,
      duration_seconds: durationSeconds,
    },
    limits: {
      maxDurationSeconds: cfg.maxDurationSeconds,
      perTable: cfg.perTable,
      perDevice: cfg.perDevice,
    },
  })
}
