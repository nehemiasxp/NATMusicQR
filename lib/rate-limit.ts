import {
  defaultJukeboxConfig,
  type RuntimeJukeboxConfig,
} from '@/config/jukebox.config'
import type { SupabaseClient } from '@supabase/supabase-js'

export type RateLimitResult =
  | { ok: true }
  | {
      ok: false
      code: 'TABLE_LIMIT' | 'DEVICE_LIMIT' | 'IP_LIMIT' | 'DEVICE_REQUIRED'
      error: string
      retryAfterMinutes: number
    }

function minutesAgoIso(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

function normalizeTableKey(label: string) {
  return label.split('·')[0].trim().toLowerCase()
}

type RecentRow = {
  added_at: string
  added_by_table: string | null
  added_by_device?: string | null
  added_by_ip?: string | null
}

/**
 * Cuotas según config en vivo (Supabase /admin o defaults).
 * Prioridad: por celular (deviceId).
 */
export async function checkRequestRateLimits(
  supabase: SupabaseClient,
  opts: {
    venueId: string
    tableLabel: string
    deviceId: string | null
    ip: string | null
    config?: RuntimeJukeboxConfig
  }
): Promise<RateLimitResult> {
  const cfg = opts.config ?? defaultJukeboxConfig
  const tableKey = normalizeTableKey(opts.tableLabel)

  if (cfg.perDevice.enabled && !opts.deviceId) {
    return {
      ok: false,
      code: 'DEVICE_REQUIRED',
      error: 'No se pudo identificar el celular. Recarga la página e intenta de nuevo.',
      retryAfterMinutes: 0,
    }
  }

  const windows = [
    cfg.perTable.windowMinutes,
    cfg.perDevice.windowMinutes,
    cfg.perIp.windowMinutes,
  ]
  const lookback = Math.max(...windows, 1)

  const { data, error } = await supabase
    .from('queue_items')
    .select('added_at, added_by_table, added_by_device, added_by_ip')
    .eq('venue_id', opts.venueId)
    .gte('added_at', minutesAgoIso(lookback))
    .order('added_at', { ascending: false })
    .limit(200)

  let rows: RecentRow[] = (data ?? []) as RecentRow[]
  if (error) {
    const { data: fallback, error: err2 } = await supabase
      .from('queue_items')
      .select('added_at, added_by_table, added_by_ip')
      .eq('venue_id', opts.venueId)
      .gte('added_at', minutesAgoIso(lookback))
      .order('added_at', { ascending: false })
      .limit(200)

    if (err2) {
      console.error('rate-limit query error', err2)
      return { ok: true }
    }
    rows = (fallback ?? []) as RecentRow[]
  }

  const now = Date.now()

  // —— Por dispositivo (principal) ——
  if (cfg.perDevice.enabled && opts.deviceId) {
    const winMs = cfg.perDevice.windowMinutes * 60 * 1000
    const max = cfg.perDevice.maxSongs
    const hits = rows.filter((r) => {
      if (!r.added_by_device) return false
      if (r.added_by_device !== opts.deviceId) return false
      return now - new Date(r.added_at).getTime() <= winMs
    })
    if (hits.length >= max) {
      const oldest = hits[hits.length - 1]
      const elapsed = now - new Date(oldest.added_at).getTime()
      const retry = Math.max(1, Math.ceil((winMs - elapsed) / 60000))
      return {
        ok: false,
        code: 'DEVICE_LIMIT',
        error: `Desde este celular solo ${max} canción cada ${cfg.perDevice.windowMinutes} min. Espera ~${retry} min.`,
        retryAfterMinutes: retry,
      }
    }
  }

  // —— Por mesa ——
  if (cfg.perTable.enabled) {
    const winMs = cfg.perTable.windowMinutes * 60 * 1000
    const max = cfg.perTable.maxSongs
    const hits = rows.filter((r) => {
      if (!r.added_by_table) return false
      if (normalizeTableKey(r.added_by_table) !== tableKey) return false
      return now - new Date(r.added_at).getTime() <= winMs
    })
    if (hits.length >= max) {
      const oldest = hits[hits.length - 1]
      const elapsed = now - new Date(oldest.added_at).getTime()
      const retry = Math.max(1, Math.ceil((winMs - elapsed) / 60000))
      return {
        ok: false,
        code: 'TABLE_LIMIT',
        error: `Esta mesa ya pidió ${max} canción(es) en los últimos ${cfg.perTable.windowMinutes} min. Espera ~${retry} min.`,
        retryAfterMinutes: retry,
      }
    }
  }

  // —— Por IP (opcional) ——
  if (cfg.perIp.enabled && opts.ip) {
    const winMs = cfg.perIp.windowMinutes * 60 * 1000
    const max = cfg.perIp.maxSongs
    const hits = rows.filter((r) => {
      if (!r.added_by_ip) return false
      if (r.added_by_ip !== opts.ip) return false
      return now - new Date(r.added_at).getTime() <= winMs
    })
    if (hits.length >= max) {
      const oldest = hits[hits.length - 1]
      const elapsed = now - new Date(oldest.added_at).getTime()
      const retry = Math.max(1, Math.ceil((winMs - elapsed) / 60000))
      return {
        ok: false,
        code: 'IP_LIMIT',
        error: `Límite de red alcanzado. Espera ~${retry} min.`,
        retryAfterMinutes: retry,
      }
    }
  }

  return { ok: true }
}

export function getClientIp(request: Request): string | null {
  const h = request.headers
  const xf = h.get('x-forwarded-for')
  if (xf) return xf.split(',')[0]?.trim() || null
  const real = h.get('x-real-ip')
  if (real) return real.trim()
  return null
}
