import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyAdminPassword } from '@/lib/settings'
import { isDeviceApproved } from '@/lib/admin-devices'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

async function requireAdmin(request: NextRequest, password?: string | null) {
  const pwd =
    password ||
    request.headers.get('x-admin-password') ||
    request.nextUrl.searchParams.get('password')
  const deviceId =
    request.headers.get('x-admin-device-id') ||
    request.nextUrl.searchParams.get('deviceId')
  if (!(await verifyAdminPassword(pwd))) {
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
  return { ok: true as const }
}

/** GET ?password= or header x-admin-password · ?slug=natmusicqr */
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
  const supabase = getSupabase()

  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle()

  if (venueError || !venue) {
    return NextResponse.json(
      { error: venueError?.message || 'Local no encontrado' },
      { status: 404 }
    )
  }

  const { data: videos, error } = await supabase
    .from('videos')
    .select(
      'id, youtube_id, title, artist, thumbnail_url, duration_seconds, category, is_active, added_at'
    )
    .eq('venue_id', venue.id)
    .order('title', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    venue,
    videos: videos ?? [],
  })
}

/** DELETE body: { password, videoId } o ?videoId= & header password */
export async function DELETE(request: NextRequest) {
  let password =
    request.headers.get('x-admin-password') ||
    request.nextUrl.searchParams.get('password')
  let videoId =
    request.nextUrl.searchParams.get('videoId')?.trim() || null

  let deviceId =
    request.headers.get('x-admin-device-id') ||
    request.nextUrl.searchParams.get('deviceId')

  try {
    const body = await request.json()
    if (body?.password) password = body.password
    if (body?.videoId) videoId = String(body.videoId).trim()
    if (body?.deviceId) deviceId = String(body.deviceId).trim()
  } catch {
    /* query params only */
  }

  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }
  if (!(await isDeviceApproved(deviceId))) {
    return NextResponse.json(
      { error: 'Dispositivo no aprobado', code: 'DEVICE_PENDING' },
      { status: 403 }
    )
  }

  if (!videoId) {
    return NextResponse.json({ error: 'Falta videoId' }, { status: 400 })
  }

  const supabase = getSupabase()

  // Quitar de cola activa primero (si hay FK o para limpiar)
  await supabase
    .from('queue_items')
    .delete()
    .eq('video_id', videoId)
    .in('status', ['queued', 'playing'])

  const { data, error } = await supabase
    .from('videos')
    .delete()
    .eq('id', videoId)
    .select('id, title')
    .maybeSingle()

  if (error) {
    return NextResponse.json(
      {
        error: error.message,
        hint: 'Ejecuta supabase-videos-delete.sql (política DELETE en videos)',
      },
      { status: 500 }
    )
  }

  if (!data) {
    return NextResponse.json(
      { error: 'Video no encontrado o no se pudo eliminar' },
      { status: 404 }
    )
  }

  return NextResponse.json({ ok: true, deleted: data })
}
