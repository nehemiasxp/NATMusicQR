import { NextRequest, NextResponse } from 'next/server'
import { changeAdminPassword, verifyAdminPassword } from '@/lib/settings'
import { isDeviceApproved } from '@/lib/admin-devices'

/** Cambiar contraseña del admin (se guarda en app_settings). */
export async function PUT(request: NextRequest) {
  let body: {
    currentPassword?: string
    newPassword?: string
    confirmPassword?: string
    deviceId?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const current = body.currentPassword?.trim() ?? ''
  const next = body.newPassword?.trim() ?? ''
  const confirm = body.confirmPassword?.trim() ?? ''
  const deviceId =
    body.deviceId || request.headers.get('x-admin-device-id') || undefined

  if (!(await verifyAdminPassword(current))) {
    return NextResponse.json(
      { error: 'Contraseña actual incorrecta' },
      { status: 401 }
    )
  }
  if (!(await isDeviceApproved(deviceId))) {
    return NextResponse.json(
      { error: 'Dispositivo no aprobado', code: 'DEVICE_PENDING' },
      { status: 403 }
    )
  }

  if (next !== confirm) {
    return NextResponse.json(
      { error: 'La confirmación no coincide' },
      { status: 400 }
    )
  }

  const result = await changeAdminPassword({
    currentPassword: current,
    newPassword: next,
  })

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        hint: 'Asegúrate de tener la tabla app_settings (supabase-app-settings.sql).',
      },
      { status: 400 }
    )
  }

  return NextResponse.json({
    ok: true,
    message: 'Contraseña actualizada. Usa la nueva en el próximo login.',
  })
}
