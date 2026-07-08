/** Utilidades YouTube (server-side). Requiere YOUTUBE_API_KEY. */

import { jukeboxConfig } from '@/config/jukebox.config'

/** @deprecated usa jukeboxConfig.maxDurationSeconds */
export const MAX_JUKEBOX_DURATION_SECONDS = jukeboxConfig.maxDurationSeconds

export type YouTubeSearchItem = {
  youtubeId: string
  title: string
  channelTitle: string
  thumbnailUrl: string | null
}

export type YouTubeValidation = {
  youtubeId: string
  title: string
  channelTitle: string
  thumbnailUrl: string | null
  durationSeconds: number | null
  embeddable: boolean
  playable: boolean
  reasons: string[]
}

export function getYoutubeApiKey(): string | null {
  return process.env.YOUTUBE_API_KEY?.trim() || null
}

/** Extrae ID de URLs o devuelve el string si ya parece un ID. */
export function extractYoutubeId(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  if (/^[\w-]{11}$/.test(raw)) return raw

  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^www\./, '')

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0]
      return id && /^[\w-]{11}$/.test(id) ? id : null
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = url.searchParams.get('v')
      if (v && /^[\w-]{11}$/.test(v)) return v

      const parts = url.pathname.split('/').filter(Boolean)
      // /embed/ID /shorts/ID /live/ID
      if (
        parts.length >= 2 &&
        ['embed', 'shorts', 'live'].includes(parts[0]) &&
        /^[\w-]{11}$/.test(parts[1])
      ) {
        return parts[1]
      }
    }
  } catch {
    /* no es URL */
  }

  return null
}

/** ISO 8601 duration de YouTube → segundos */
export function parseIsoDuration(iso: string | undefined | null): number | null {
  if (!iso) return null
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return null
  const h = Number(m[1] || 0)
  const min = Number(m[2] || 0)
  const s = Number(m[3] || 0)
  return h * 3600 + min * 60 + s
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds <= 0) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export async function searchYoutubeVideos(
  query: string,
  maxResults = 10
): Promise<YouTubeSearchItem[]> {
  const key = getYoutubeApiKey()
  if (!key) {
    throw new Error('Falta YOUTUBE_API_KEY en .env.local')
  }

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: String(Math.min(Math.max(maxResults, 1), 15)),
    q: query,
    videoEmbeddable: 'true',
    safeSearch: 'moderate',
    key,
  })

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?${params.toString()}`,
    { next: { revalidate: 0 } }
  )
  const data = await res.json()

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      `YouTube Search error (${res.status})`
    throw new Error(msg)
  }

  const items = (data.items ?? []) as Array<{
    id?: { videoId?: string }
    snippet?: {
      title?: string
      channelTitle?: string
      thumbnails?: { medium?: { url?: string }; default?: { url?: string } }
    }
  }>

  return items
    .map((item) => {
      const youtubeId = item.id?.videoId
      if (!youtubeId) return null
      return {
        youtubeId,
        title: item.snippet?.title ?? 'Sin título',
        channelTitle: item.snippet?.channelTitle ?? '',
        thumbnailUrl:
          item.snippet?.thumbnails?.medium?.url ??
          item.snippet?.thumbnails?.default?.url ??
          `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`,
      } satisfies YouTubeSearchItem
    })
    .filter(Boolean) as YouTubeSearchItem[]
}

export async function validateYoutubeVideo(
  youtubeIdOrUrl: string,
  options?: { maxDurationSeconds?: number }
): Promise<YouTubeValidation> {
  const key = getYoutubeApiKey()
  if (!key) {
    throw new Error('Falta YOUTUBE_API_KEY en .env.local')
  }
  const maxDurationSeconds =
    options?.maxDurationSeconds ?? jukeboxConfig.maxDurationSeconds

  const youtubeId = extractYoutubeId(youtubeIdOrUrl) ?? youtubeIdOrUrl.trim()
  if (!/^[\w-]{11}$/.test(youtubeId)) {
    return {
      youtubeId,
      title: '',
      channelTitle: '',
      thumbnailUrl: null,
      durationSeconds: null,
      embeddable: false,
      playable: false,
      reasons: ['ID de YouTube inválido'],
    }
  }

  const params = new URLSearchParams({
    part: 'snippet,status,contentDetails',
    id: youtubeId,
    key,
  })

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`,
    { next: { revalidate: 0 } }
  )
  const data = await res.json()

  if (!res.ok) {
    throw new Error(data?.error?.message || `YouTube API error (${res.status})`)
  }

  const item = data.items?.[0] as
    | {
        snippet?: {
          title?: string
          channelTitle?: string
          liveBroadcastContent?: string
          thumbnails?: { medium?: { url?: string }; default?: { url?: string } }
        }
        status?: {
          embeddable?: boolean
          privacyStatus?: string
          uploadStatus?: string
        }
        contentDetails?: {
          duration?: string
          regionRestriction?: { blocked?: string[]; allowed?: string[] }
        }
      }
    | undefined

  if (!item) {
    return {
      youtubeId,
      title: '',
      channelTitle: '',
      thumbnailUrl: null,
      durationSeconds: null,
      embeddable: false,
      playable: false,
      reasons: ['El video no existe o no es público'],
    }
  }

  const reasons: string[] = []
  const embeddable = item.status?.embeddable === true
  const privacy = item.status?.privacyStatus
  const upload = item.status?.uploadStatus
  const live = item.snippet?.liveBroadcastContent
  const durationSeconds = parseIsoDuration(item.contentDetails?.duration)

  if (!embeddable) {
    reasons.push('El dueño no permite reproducirlo embebido (embed)')
  }
  if (privacy && privacy !== 'public' && privacy !== 'unlisted') {
    reasons.push(`Privacidad: ${privacy}`)
  }
  if (upload && upload !== 'processed') {
    reasons.push('El video aún no está listo')
  }
  if (live === 'live' || live === 'upcoming') {
    reasons.push('No se admiten lives / próximos eventos')
  }
  if (durationSeconds != null && durationSeconds > maxDurationSeconds) {
    reasons.push(
      `Demasiado largo (máx. ${Math.round(maxDurationSeconds / 60)} min)`
    )
  }
  if (durationSeconds === 0) {
    reasons.push('Duración no válida')
  }

  const playable = reasons.length === 0

  return {
    youtubeId,
    title: item.snippet?.title ?? 'Sin título',
    channelTitle: item.snippet?.channelTitle ?? '',
    thumbnailUrl:
      item.snippet?.thumbnails?.medium?.url ??
      item.snippet?.thumbnails?.default?.url ??
      `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`,
    durationSeconds,
    embeddable,
    playable,
    reasons,
  }
}
