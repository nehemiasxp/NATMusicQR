import { NextRequest, NextResponse } from 'next/server'
import { verifyAdminPassword } from '@/lib/settings'
import {
  isDeviceApproved,
  loadAdminDevices,
  setDeviceStatus,
  type AdminDeviceStatus,
} from '@/lib/admin-devices'

async function auth(request: NextRequest) {
  const password =
    request.headers.get('x-admin-password') ||
    request.nextUrl.searchParams.get('password')
  const deviceId =
    request.headers.get('x-admin-device-id') ||
    request.nextUrl.searchParams.get('deviceId')

  if (!(await verifyAdminPassword(password))) {
    return { ok: false as const, status: 401, error: 'No autorizado' }
  }
  if (!(await isDeviceApproved(deviceId))) {
    return {
      ok: false as const,
      status: 403,
      error: 'Dispositivo no aprobado',
    }
  }
  return { ok: true as const, deviceId: deviceId!.trim(), password: password! }
}

/** GET lista de dispositivos (solo admin aprobado) */
export async function GET(request: NextRequest) {
  const a = await auth(request)
  if (!a.ok) {
    return NextResponse.json({ error: a.error }, { status: a.status })
  }
  const store = await loadAdminDevices()
  return NextResponse.json({
    ok: true,
    devices: store.devices.sort((x, y) =>
      x.createdAt < y.createdAt ? 1 : -1
    ),
  })
}

/** POST { password, deviceId, targetId, status: approved|rejected } */
export async function POST(request: NextRequest) {
  let body: {
    password?: string
    deviceId?: string
    targetId?: string
    status?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  if (!(await verifyAdminPassword(body.password))) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }
  const actorId = body.deviceId?.trim()
  if (!(await isDeviceApproved(actorId))) {
    return NextResponse.json(
      { error: 'Solo un admin aprobado puede aceptar/rechazar' },
      { status: 403 }
    )
  }

  const targetId = body.targetId?.trim()
  const status = body.status as AdminDeviceStatus
  if (!targetId || (status !== 'approved' && status !== 'rejected')) {
    return NextResponse.json(
      { error: 'Faltan targetId o status (approved|rejected)' },
      { status: 400 }
    )
  }

  const result = await setDeviceStatus({
    deviceId: targetId,
    status,
    actorDeviceId: actorId!,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  return NextResponse.json({
    ok: true,
    devices: result.store.devices,
  })
}
