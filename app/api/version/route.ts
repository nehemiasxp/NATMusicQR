import { NextResponse } from 'next/server'
import {
  JOIN_UI_VERSION,
  PLAYER_UI_VERSION,
  getBuildId,
} from '@/lib/app-version'

/** Siempre fresco: los celulares preguntan si hay deploy nuevo */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      buildId: getBuildId(),
      join: JOIN_UI_VERSION,
      player: PLAYER_UI_VERSION,
      ts: Date.now(),
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
      },
    }
  )
}
