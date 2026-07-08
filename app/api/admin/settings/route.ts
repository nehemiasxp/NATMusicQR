import { NextRequest, NextResponse } from 'next/server'
import {
  mergeJukeboxConfig,
  publicJukeboxConfig,
  type RuntimeJukeboxConfig,
} from '@/config/jukebox.config'
import {
  getRuntimeConfig,
  saveRuntimeConfig,
  verifyAdminPassword,
} from '@/lib/settings'

export async function GET(request: NextRequest) {
  const password =
    request.headers.get('x-admin-password') ||
    request.nextUrl.searchParams.get('password')

  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const cfg = await getRuntimeConfig()
  // Admin autenticado: incluye PIN (no usar publicJukeboxConfig aquí)
  return NextResponse.json({
    config: cfg,
    source: 'runtime',
  })
}

export async function PUT(request: NextRequest) {
  let body: { password?: string; config?: Partial<RuntimeJukeboxConfig> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  if (!(await verifyAdminPassword(body.password))) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
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
