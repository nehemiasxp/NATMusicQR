import type { AccessConfig, RuntimeJukeboxConfig } from '@/config/jukebox.config'

export type AccessCheck =
  | { ok: true }
  | { ok: false; code: 'CLOSED' | 'BAD_PIN' | 'PIN_REQUIRED'; error: string }

function minutesFromMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * ¿Está dentro del horario? Soporta cruce de medianoche (18:00 → 02:00).
 */
export function isWithinBusinessHours(
  access: AccessConfig,
  now: Date = new Date()
): boolean {
  if (!access.hoursEnabled) return true

  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: access.timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
  } catch {
    // timezone inválida → usar local del servidor
    parts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
  }

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const nowMin = hour * 60 + minute
  const open = minutesFromMidnight(access.openTime)
  const close = minutesFromMidnight(access.closeTime)

  if (open === close) {
    // mismo valor = 24h abierto si hoursEnabled
    return true
  }

  if (open < close) {
    // mismo día: 10:00 - 22:00
    return nowMin >= open && nowMin < close
  }

  // cruza medianoche: 18:00 - 02:00
  return nowMin >= open || nowMin < close
}

export function formatHoursLabel(access: AccessConfig): string {
  return `${access.openTime} – ${access.closeTime} (${access.timezone})`
}

export function checkVenueAccess(
  cfg: RuntimeJukeboxConfig,
  opts: { pin?: string | null }
): AccessCheck {
  const { access } = cfg

  if (!isWithinBusinessHours(access)) {
    return {
      ok: false,
      code: 'CLOSED',
      error: `El jukebox está cerrado. Horario: ${formatHoursLabel(access)}`,
    }
  }

  if (access.pinEnabled && access.pin.trim()) {
    const entered = (opts.pin ?? '').trim()
    if (!entered) {
      return {
        ok: false,
        code: 'PIN_REQUIRED',
        error: 'Ingresa el PIN del local (está en el menú o en la TV)',
      }
    }
    if (entered !== access.pin.trim()) {
      return {
        ok: false,
        code: 'BAD_PIN',
        error: 'PIN incorrecto',
      }
    }
  }

  return { ok: true }
}
