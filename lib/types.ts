export type Venue = {
  id: string
  name: string
  slug: string
  description: string | null
}

export type Video = {
  id: string
  youtube_id: string
  title: string
  artist: string | null
  thumbnail_url: string | null
  duration_seconds: number | null
  category: string | null
  is_active: boolean
}

export type QueueStatus = 'queued' | 'playing' | 'played' | 'skipped' | string

export type QueueItem = {
  id: string
  venue_id?: string
  video_id?: string
  status: QueueStatus
  added_at: string
  played_at?: string | null
  added_by_table: string | null
  videos: Video | null
}

export const QUEUE_SELECT = `
  id,
  venue_id,
  video_id,
  status,
  added_at,
  played_at,
  added_by_table,
  videos (
    id,
    youtube_id,
    title,
    artist,
    thumbnail_url,
    duration_seconds,
    category,
    is_active
  )
` as const
