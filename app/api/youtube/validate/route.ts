import { NextRequest, NextResponse } from 'next/server'
import { getYoutubeApiKey, validateYoutubeVideo } from '@/lib/youtube'

export async function GET(request: NextRequest) {
  if (!getYoutubeApiKey()) {
    return NextResponse.json(
      {
        error: 'Falta YOUTUBE_API_KEY en .env.local',
        code: 'MISSING_API_KEY',
      },
      { status: 503 }
    )
  }

  const id = request.nextUrl.searchParams.get('id')?.trim() ?? ''
  if (!id) {
    return NextResponse.json({ error: 'Falta el parámetro id' }, { status: 400 })
  }

  try {
    const result = await validateYoutubeVideo(id)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error validando video'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
