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
  pinEnabled: boolean
  pin: string
  hoursEnabled: boolean
  timezone: string
  openTime: string
  closeTime: string
}

export type AutoplayMusicConfig = {
  /** Si la cola está vacía, reproduce canciones del catálogo al azar */
  enabled: boolean
}

export type VotingConfig = {
  /** Mostrar 👍 / 👎 en mesas y permitir saltar por votos negativos */
  enabled: boolean
  /** % de votos "no me gusta" para saltar (ej. 80) */
  skipThresholdPercent: number
  /** Mínimo de votos totales antes de poder saltar */
  minVotesToSkip: number
}

export type RuntimeJukeboxConfig = {
  maxDurationSeconds: number
  perTable: LimitRule
  perDevice: LimitRule
  perIp: LimitRule
  blockDuplicateInQueue: boolean
  access: AccessConfig
  autoplayMusic: AutoplayMusicConfig
  voting: VotingConfig
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
  autoplayMusic: {
    enabled: false,
  },
  voting: {
    enabled: true,
    skipThresholdPercent: 80,
    minVotesToSkip: 2,
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
    autoplayMusic: cfg.autoplayMusic,
    voting: cfg.voting,
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
  const autoplayPartial: Partial<AutoplayMusicConfig> = p.autoplayMusic ?? {}
  const votingPartial: Partial<VotingConfig> = p.voting ?? {}
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
    autoplayMusic: {
      enabled:
        autoplayPartial.enabled ?? defaultJukeboxConfig.autoplayMusic.enabled,
    },
    voting: {
      enabled: votingPartial.enabled ?? defaultJukeboxConfig.voting.enabled,
      skipThresholdPercent: clampInt(
        votingPartial.skipThresholdPercent,
        1,
        100,
        defaultJukeboxConfig.voting.skipThresholdPercent
      ),
      minVotesToSkip: clampInt(
        votingPartial.minVotesToSkip,
        1,
        100,
        defaultJukeboxConfig.voting.minVotesToSkip
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
