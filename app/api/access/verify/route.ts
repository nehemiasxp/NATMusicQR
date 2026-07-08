import { NextRequest, NextResponse } from 'next/server'
import { checkVenueAccess, formatHoursLabel, isWithinBusinessHours } from '@/lib/access'
import { getRuntimeConfig } from '@/lib/settings'

/** Verifica PIN + horario sin exponer el PIN. */
export async function POST(request: NextRequest) {
  let body: { pin?: string }
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const cfg = await getRuntimeConfig()
  const check = checkVenueAccess(cfg, { pin: body.pin })

  if (!check.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: check.code,
        error: check.error,
        access: {
          pinEnabled: cfg.access.pinEnabled,
          hoursEnabled: cfg.access.hoursEnabled,
          openTime: cfg.access.openTime,
          closeTime: cfg.access.closeTime,
          timezone: cfg.access.timezone,
          isOpen: isWithinBusinessHours(cfg.access),
          hoursLabel: formatHoursLabel(cfg.access),
        },
      },
      { status: check.code === 'CLOSED' ? 403 : 401 }
    )
  }

  return NextResponse.json({
    ok: true,
    access: {
      pinEnabled: cfg.access.pinEnabled,
      hoursEnabled: cfg.access.hoursEnabled,
      openTime: cfg.access.openTime,
      closeTime: cfg.access.closeTime,
      timezone: cfg.access.timezone,
      isOpen: true,
      hoursLabel: formatHoursLabel(cfg.access),
    },
  })
}
