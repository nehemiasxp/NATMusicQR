import { NextRequest, NextResponse } from 'next/server'
import {
  mergeJukeboxConfig,
  type RuntimeJukeboxConfig,
} from '@/config/jukebox.config'
import {
  getRuntimeConfig,
  saveRuntimeConfig,
  verifyAdminPassword,
} from '@/lib/settings'
import { isDeviceApproved } from '@/lib/admin-devices'

async function requireApprovedAdmin(
  password: string | null | undefined,
  deviceId: string | null | undefined
) {
  if (!(await verifyAdminPassword(password))) {
    return { ok: false as const, status: 401, error: 'No autorizado' }
  }
  if (!(await isDeviceApproved(deviceId))) {
    return {
      ok: false as const,
      status: 403,
      error: 'Dispositivo no aprobado (pendiente o rechazado)',
      code: 'DEVICE_PENDING',
    }
  }
  return { ok: true as const }
}

export async function GET(request: NextRequest) {
  const password =
    request.headers.get('x-admin-password') ||
    request.nextUrl.searchParams.get('password')
  const deviceId =
    request.headers.get('x-admin-device-id') ||
    request.nextUrl.searchParams.get('deviceId')

  const auth = await requireApprovedAdmin(password, deviceId)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: auth.code },
      { status: auth.status }
    )
  }

  const cfg = await getRuntimeConfig()
  return NextResponse.json({
    config: cfg,
    source: 'runtime',
  })
}

export async function PUT(request: NextRequest) {
  let body: {
    password?: string
    deviceId?: string
    config?: Partial<RuntimeJukeboxConfig>
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const deviceId =
    body.deviceId || request.headers.get('x-admin-device-id') || undefined
  const auth = await requireApprovedAdmin(body.password, deviceId)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: auth.code },
      { status: auth.status }
    )
  }

  if (!body.config || typeof body.config !== 'object') {
    return NextResponse.json({ error: 'Falta config' }, { status: 400 })
  }

  const merged = mergeJukeboxConfig(body.config)
  const result = await saveRuntimeConfig(merged)

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        hint: 'Ejecuta supabase-app-settings.sql en Supabase (tabla app_settings + políticas).',
      },
      { status: 500 }
    )
  }

  return NextResponse.json({
    ok: true,
    config: merged,
  })
}
