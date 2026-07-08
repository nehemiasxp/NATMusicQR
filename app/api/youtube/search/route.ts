import { NextRequest, NextResponse } from 'next/server'
import { extractYoutubeId, getYoutubeApiKey, searchYoutubeVideos } from '@/lib/youtube'

export async function GET(request: NextRequest) {
  if (!getYoutubeApiKey()) {
    return NextResponse.json(
      {
        error:
          'Falta YOUTUBE_API_KEY. Crea una clave en Google Cloud (YouTube Data API v3) y añádela a .env.local',
        code: 'MISSING_API_KEY',
      },
      { status: 503 }
    )
  }

  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json(
      { error: 'Escribe al menos 2 caracteres para buscar' },
      { status: 400 }
    )
  }

  // Si pegan un link, devolvemos ese ID como único resultado “búsqueda”
  const asId = extractYoutubeId(q)
  if (asId) {
    return NextResponse.json({
      items: [
        {
          youtubeId: asId,
          title: `Video ${asId}`,
          channelTitle: '',
          thumbnailUrl: `https://img.youtube.com/vi/${asId}/hqdefault.jpg`,
        },
      ],
      fromLink: true,
    })
  }

  try {
    const items = await searchYoutubeVideos(q, 10)
    return NextResponse.json({ items, fromLink: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error buscando en YouTube'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
