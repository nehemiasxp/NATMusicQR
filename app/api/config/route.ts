import { NextResponse } from 'next/server'
import { publicJukeboxConfig } from '@/config/jukebox.config'
import { formatHoursLabel, isWithinBusinessHours } from '@/lib/access'
import { getRuntimeConfig } from '@/lib/settings'

/** Config pública en vivo (Supabase + defaults). Nunca incluye el PIN. */
export async function GET() {
  const cfg = await getRuntimeConfig()
  const pub = publicJukeboxConfig(cfg)
  return NextResponse.json({
    ...pub,
    access: {
      ...pub.access,
      isOpen: isWithinBusinessHours(cfg.access),
      hoursLabel: formatHoursLabel(cfg.access),
    },
  })
}
