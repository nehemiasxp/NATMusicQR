/**
 * Valores por defecto del jukebox.
 * La configuración en vivo se edita en /admin y se guarda en Supabase (app_settings).
 */

export type LimitRule = {
  enabled: boolean
  maxSongs: number
  windowMinutes: number
}

export type AccessConfig = {
  /** Exigir PIN del local al entrar / pedir */
  pinEnabled: boolean
  /** PIN del local (solo se guarda en DB/admin; no se expone al público) */
  pin: string
  /** Restringir por horario de atención */
  hoursEnabled: boolean
  /** IANA timezone, ej. America/Lima, America/Mexico_City */
  timezone: string
  /** HH:mm apertura */
  openTime: string
  /** HH:mm cierre (puede ser menor que open = cruza medianoche, ej. 02:00) */
  closeTime: string
}

export type RuntimeJukeboxConfig = {
  maxDurationSeconds: number
  perTable: LimitRule
  perDevice: LimitRule
  perIp: LimitRule
  blockDuplicateInQueue: boolean
  access: AccessConfig
  ui: {
    showQueueOnJoin: boolean
    pollIntervalMs: number
  }
}

export const defaultJukeboxConfig: RuntimeJukeboxConfig = {
  maxDurationSeconds: 5 * 60,
  perTable: {
    enabled: true,
    maxSongs: 1,
    windowMinutes: 20,
  },
  perDevice: {
    enabled: true,
    maxSongs: 1,
    windowMinutes: 30,
  },
  perIp: {
    enabled: false,
    maxSongs: 3,
    windowMinutes: 30,
  },
  blockDuplicateInQueue: true,
  access: {
    pinEnabled: true,
    pin: '1234',
    hoursEnabled: true,
    timezone: 'America/Lima',
    openTime: '18:00',
    closeTime: '02:00',
  },
  ui: {
    showQueueOnJoin: true,
    pollIntervalMs: 3000,
  },
}

/** @deprecated usar defaultJukeboxConfig o getRuntimeConfig() */
export const jukeboxConfig = defaultJukeboxConfig

/** Config pública: NUNCA incluye el PIN en claro. */
export function publicJukeboxConfig(cfg: RuntimeJukeboxConfig = defaultJukeboxConfig) {
  return {
    maxDurationSeconds: cfg.maxDurationSeconds,
    perTable: cfg.perTable,
    perDevice: cfg.perDevice,
    perIp: {
      enabled: cfg.perIp.enabled,
      maxSongs: cfg.perIp.maxSongs,
      windowMinutes: cfg.perIp.windowMinutes,
    },
    blockDuplicateInQueue: cfg.blockDuplicateInQueue,
    access: {
      pinEnabled: cfg.access.pinEnabled,
      pinRequired: cfg.access.pinEnabled && Boolean(cfg.access.pin?.trim()),
      hoursEnabled: cfg.access.hoursEnabled,
      timezone: cfg.access.timezone,
      openTime: cfg.access.openTime,
      closeTime: cfg.access.closeTime,
    },
    ui: cfg.ui,
  }
}

function normalizeTime(t: string | undefined, fallback: string) {
  const v = (t || fallback).trim()
  if (!/^\d{1,2}:\d{2}$/.test(v)) return fallback
  const [h, m] = v.split(':').map(Number)
  if (h < 0 || h > 23 || m < 0 || m > 59) return fallback
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function mergeJukeboxConfig(
  partial: Partial<RuntimeJukeboxConfig> | null | undefined
): RuntimeJukeboxConfig {
  const p = partial ?? {}
  const accessPartial: Partial<AccessConfig> = p.access ?? {}
  return {
    maxDurationSeconds:
      typeof p.maxDurationSeconds === 'number' && p.maxDurationSeconds > 0
        ? Math.min(p.maxDurationSeconds, 60 * 60)
        : defaultJukeboxConfig.maxDurationSeconds,
    perTable: {
      ...defaultJukeboxConfig.perTable,
      ...p.perTable,
      maxSongs: clampInt(p.perTable?.maxSongs, 1, 50, defaultJukeboxConfig.perTable.maxSongs),
      windowMinutes: clampInt(
        p.perTable?.windowMinutes,
        1,
        24 * 60,
        defaultJukeboxConfig.perTable.windowMinutes
      ),
      enabled: p.perTable?.enabled ?? defaultJukeboxConfig.perTable.enabled,
    },
    perDevice: {
      ...defaultJukeboxConfig.perDevice,
      ...p.perDevice,
      maxSongs: clampInt(
        p.perDevice?.maxSongs,
        1,
        50,
        defaultJukeboxConfig.perDevice.maxSongs
      ),
      windowMinutes: clampInt(
        p.perDevice?.windowMinutes,
        1,
        24 * 60,
        defaultJukeboxConfig.perDevice.windowMinutes
      ),
      enabled: p.perDevice?.enabled ?? defaultJukeboxConfig.perDevice.enabled,
    },
    perIp: {
      ...defaultJukeboxConfig.perIp,
      ...p.perIp,
      maxSongs: clampInt(p.perIp?.maxSongs, 1, 100, defaultJukeboxConfig.perIp.maxSongs),
      windowMinutes: clampInt(
        p.perIp?.windowMinutes,
        1,
        24 * 60,
        defaultJukeboxConfig.perIp.windowMinutes
      ),
      enabled: p.perIp?.enabled ?? defaultJukeboxConfig.perIp.enabled,
    },
    blockDuplicateInQueue:
      p.blockDuplicateInQueue ?? defaultJukeboxConfig.blockDuplicateInQueue,
    access: {
      pinEnabled: accessPartial.pinEnabled ?? defaultJukeboxConfig.access.pinEnabled,
      pin: String(accessPartial.pin ?? defaultJukeboxConfig.access.pin)
        .trim()
        .slice(0, 32),
      hoursEnabled:
        accessPartial.hoursEnabled ?? defaultJukeboxConfig.access.hoursEnabled,
      timezone: (accessPartial.timezone || defaultJukeboxConfig.access.timezone).trim(),
      openTime: normalizeTime(
        accessPartial.openTime,
        defaultJukeboxConfig.access.openTime
      ),
      closeTime: normalizeTime(
        accessPartial.closeTime,
        defaultJukeboxConfig.access.closeTime
      ),
    },
    ui: {
      ...defaultJukeboxConfig.ui,
      ...p.ui,
      pollIntervalMs: clampInt(
        p.ui?.pollIntervalMs,
        1000,
        60000,
        defaultJukeboxConfig.ui.pollIntervalMs
      ),
    },
  }
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
