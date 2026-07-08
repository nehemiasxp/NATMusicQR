import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  defaultJukeboxConfig,
  mergeJukeboxConfig,
  type RuntimeJukeboxConfig,
} from '@/config/jukebox.config'

export const SETTINGS_KEY = 'jukebox'
export const ADMIN_PASSWORD_KEY = 'admin_password'

const DEV_DEFAULT_PASSWORD = 'natmusicqr-admin'

function getSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

/** Lee config en vivo desde app_settings (fallback a defaults). */
export async function getRuntimeConfig(
  supabase?: SupabaseClient
): Promise<RuntimeJukeboxConfig> {
  const client = supabase ?? getSupabase()
  try {
    const { data, error } = await client
      .from('app_settings')
      .select('value')
      .eq('key', SETTINGS_KEY)
      .maybeSingle()

    if (error || !data?.value) {
      return defaultJukeboxConfig
    }
    return mergeJukeboxConfig(data.value as Partial<RuntimeJukeboxConfig>)
  } catch {
    return defaultJukeboxConfig
  }
}

/** Guarda config (requiere políticas RLS de escritura en app_settings). */
export async function saveRuntimeConfig(
  config: RuntimeJukeboxConfig,
  supabase?: SupabaseClient
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = supabase ?? getSupabase()
  const merged = mergeJukeboxConfig(config)
  const row = {
    key: SETTINGS_KEY,
    value: merged,
    updated_at: new Date().toISOString(),
  }

  const { error } = await client.from('app_settings').upsert(row, {
    onConflict: 'key',
  })

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * Contraseña efectiva:
 * 1) Si hay una en app_settings (cambiada desde /admin) → esa
 * 2) Si no, ADMIN_PASSWORD del .env
 * 3) Si no, default de desarrollo
 */
export async function getEffectiveAdminPassword(
  supabase?: SupabaseClient
): Promise<string> {
  const client = supabase ?? getSupabase()
  try {
    const { data, error } = await client
      .from('app_settings')
      .select('value')
      .eq('key', ADMIN_PASSWORD_KEY)
      .maybeSingle()

    if (!error && data?.value) {
      const v = data.value as { password?: string } | string
      const pwd = typeof v === 'string' ? v : v?.password
      if (pwd && String(pwd).trim().length >= 4) {
        return String(pwd).trim()
      }
    }
  } catch {
    /* fallback */
  }

  const envPwd = process.env.ADMIN_PASSWORD?.trim()
  if (envPwd) return envPwd
  return DEV_DEFAULT_PASSWORD
}

export async function verifyAdminPassword(
  password: string | null | undefined,
  supabase?: SupabaseClient
): Promise<boolean> {
  if (!password) return false
  const expected = await getEffectiveAdminPassword(supabase)
  return password === expected
}

export async function changeAdminPassword(opts: {
  currentPassword: string
  newPassword: string
  supabase?: SupabaseClient
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = opts.supabase ?? getSupabase()
  const valid = await verifyAdminPassword(opts.currentPassword, client)
  if (!valid) {
    return { ok: false, error: 'Contraseña actual incorrecta' }
  }

  const next = opts.newPassword.trim()
  if (next.length < 6) {
    return { ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' }
  }
  if (next.length > 72) {
    return { ok: false, error: 'La contraseña es demasiado larga' }
  }

  const { error } = await client.from('app_settings').upsert(
    {
      key: ADMIN_PASSWORD_KEY,
      value: { password: next },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  )

  if (error) {
    return {
      ok: false,
      error: error.message,
    }
  }
  return { ok: true }
}
