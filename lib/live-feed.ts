/** Feed efímero TV: comentarios + burbujas like (anti-spam). */

export type LiveFeedKind = 'comment' | 'like' | 'dislike'

export type LiveFeedItem = {
  id: string
  venue_id: string
  kind: LiveFeedKind
  body: string | null
  display_name: string
  table_label: string | null
  device_id: string
  queue_item_id: string | null
  created_at: string
}

export const LIVE_FEED_SELECT =
  'id, venue_id, kind, body, display_name, table_label, device_id, queue_item_id, created_at' as const

/** Ventana de eventos que la TV muestra */
export const LIVE_FEED_WINDOW_MS = 90_000

/** Comentarios */
export const COMMENT_MAX_LEN = 80
export const COMMENT_MIN_INTERVAL_MS = 18_000 // 1 cada 18s por dispositivo
export const COMMENT_MAX_PER_MIN = 3

/** Likes/dislikes burbuja (además del voto formal) */
export const REACT_MIN_INTERVAL_MS = 4_000
export const REACT_MAX_PER_MIN = 12

const BAD_PATTERNS = [
  /(.)\1{6,}/i, // aaaaaaa
  /https?:\/\//i,
  /www\./i,
  /<[^>]+>/,
  /gratis|crypto|casino|viagra|telegram\.me/i,
]

export function sanitizeDisplayName(raw: string | null | undefined): string {
  const t = (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28)
  return t || 'Anónimo'
}

export function sanitizeComment(raw: string | null | undefined): string | null {
  if (!raw) return null
  let t = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COMMENT_MAX_LEN)
  if (t.length < 1) return null
  for (const re of BAD_PATTERNS) {
    if (re.test(t)) return null
  }
  return t
}

export function buildAuthorLabel(opts: {
  displayName?: string | null
  tableName?: string | null
}): { display_name: string; table_label: string | null } {
  const table = (opts.tableName ?? '').trim().slice(0, 40) || null
  const name = sanitizeDisplayName(opts.displayName)
  // Si el "nombre" es solo la mesa, usarlo
  if ((!opts.displayName || !opts.displayName.trim()) && table) {
    return { display_name: sanitizeDisplayName(table), table_label: table }
  }
  return { display_name: name, table_label: table }
}
