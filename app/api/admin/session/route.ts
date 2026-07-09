import { NextRequest, NextResponse } from 'next/server'
import { verifyAdminPassword } from '@/lib/settings'
import { registerOrCheckDevice } from '@/lib/admin-devices'

/**
 * POST { password, deviceId, label? }
 * → { status: approved|pending|rejected, device }
 */
export async function POST(request: NextRequest) {
  let body: { password?: string; deviceId?: string; label?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const password = body.password?.trim()
  const deviceId = body.deviceId?.trim()
  if (!password || !deviceId) {
    return NextResponse.json(
      { error: 'Faltan password o deviceId' },
      { status: 400 }
    )
  }

  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'Contraseña incorrecta' }, { status: 401 })
  }

  try {
    const result = await registerOrCheckDevice({
      deviceId,
      label: body.label,
    })

    if (result.status === 'rejected') {
      return NextResponse.json(
        {
          ok: false,
          status: 'rejected',
          error: 'Este dispositivo fue rechazado por un administrador',
          device: result.device,
        },
        { status: 403 }
      )
    }

    if (result.status === 'pending') {
      return NextResponse.json({
        ok: true,
        status: 'pending',
        message:
          'Acceso pendiente. Un administrador debe aceptar este dispositivo.',
        device: result.device,
        pendingCount: result.store.devices.filter((d) => d.status === 'pending')
          .length,
      })
    }

    return NextResponse.json({
      ok: true,
      status: 'approved',
      device: result.device,
      devices: result.store.devices,
    })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : 'Error de sesión admin',
      },
      { status: 500 }
    )
  }
}

/** GET: revalidar si el device sigue aprobado (polling mientras pending) */
export async function GET(request: NextRequest) {
  const password =
    request.headers.get('x-admin-password') ||
    request.nextUrl.searchParams.get('password')
  const deviceId =
    request.headers.get('x-admin-device-id') ||
    request.nextUrl.searchParams.get('deviceId')

  if (!password || !deviceId) {
    return NextResponse.json({ error: 'Faltan credenciales' }, { status: 400 })
  }
  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const result = await registerOrCheckDevice({ deviceId })
  return NextResponse.json({
    ok: result.status === 'approved',
    status: result.status,
    device: result.device,
    devices:
      result.status === 'approved' ? result.store.devices : undefined,
  })
}
