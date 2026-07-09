/**
 * Clientes expulsados del jukebox (por device o por mesa).
 * Guardado en app_settings.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const BANNED_CLIENTS_KEY = 'banned_clients'

export type BannedClient = {
  id: string
  /** deviceId del celular */
  deviceId?: string | null
  /** clave de mesa normalizada (ej. "mesa 4") */
  tableKey?: string | null
  label: string
  reason?: string | null
  bannedAt: string
  bannedBy?: string | null
}

export type BannedStore = { banned: BannedClient[] }

function getSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

export function normalizeTableKey(label: string | null | undefined): string {
  if (!label) return ''
  return label.split('·')[0].trim().toLowerCase()
}

export async function loadBanned(
  supabase?: SupabaseClient
): Promise<BannedStore> {
  const client = supabase ?? getSupabase()
  const { data, error } = await client
    .from('app_settings')
    .select('value')
    .eq('key', BANNED_CLIENTS_KEY)
    .maybeSingle()

  if (error || !data?.value) return { banned: [] }
  const raw = data.value as BannedStore
  if (!raw || !Array.isArray(raw.banned)) return { banned: [] }
  return { banned: raw.banned }
}

export async function saveBanned(
  store: BannedStore,
  supabase?: SupabaseClient
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = supabase ?? getSupabase()
  const { error } = await client.from('app_settings').upsert(
    {
      key: BANNED_CLIENTS_KEY,
      value: { banned: store.banned },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export function isBanned(
  store: BannedStore,
  opts: { deviceId?: string | null; tableLabel?: string | null }
): BannedClient | null {
  const tableKey = normalizeTableKey(opts.tableLabel)
  for (const b of store.banned) {
    if (opts.deviceId && b.deviceId && b.deviceId === opts.deviceId) return b
    if (tableKey && b.tableKey && b.tableKey === tableKey) return b
  }
  return null
}

export async function banClient(opts: {
  deviceId?: string | null
  tableLabel?: string | null
  label: string
  reason?: string
  bannedBy?: string
  supabase?: SupabaseClient
}): Promise<{ ok: true; entry: BannedClient } | { ok: false; error: string }> {
  const client = opts.supabase ?? getSupabase()
  const store = await loadBanned(client)
  const entry: BannedClient = {
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `ban-${Date.now()}`,
    deviceId: opts.deviceId?.trim() || null,
    tableKey: normalizeTableKey(opts.tableLabel) || null,
    label: opts.label.trim().slice(0, 80),
    reason: opts.reason?.trim() || 'Expulsado por admin',
    bannedAt: new Date().toISOString(),
    bannedBy: opts.bannedBy || null,
  }

  if (!entry.deviceId && !entry.tableKey) {
    return { ok: false, error: 'Falta deviceId o mesa para expulsar' }
  }

  // evitar duplicados exactos
  store.banned = store.banned.filter((b) => {
    if (entry.deviceId && b.deviceId === entry.deviceId) return false
    if (entry.tableKey && b.tableKey === entry.tableKey) return false
    return true
  })
  store.banned.push(entry)
  const saved = await saveBanned(store, client)
  if (!saved.ok) return saved
  return { ok: true, entry }
}

export async function unbanClient(opts: {
  banId: string
  supabase?: SupabaseClient
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = opts.supabase ?? getSupabase()
  const store = await loadBanned(client)
  store.banned = store.banned.filter((b) => b.id !== opts.banId)
  return saveBanned(store, client)
}
