import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyAdminPassword } from '@/lib/settings'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

/** GET ?password= or header x-admin-password · ?slug=natmusicqr */
export async function GET(request: NextRequest) {
  const password =
    request.headers.get('x-admin-password') ||
    request.nextUrl.searchParams.get('password')

  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
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

  try {
    const body = await request.json()
    if (body?.password) password = body.password
    if (body?.videoId) videoId = String(body.videoId).trim()
  } catch {
    /* query params only */
  }

  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
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
