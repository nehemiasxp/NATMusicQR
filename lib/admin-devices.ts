/**
 * Dispositivos admin: solo los aprobados entran al panel.
 * Primero en entrar con contraseña correcta = dueño (auto-aprobado).
 * El resto queda pending hasta que un admin aprobado acepte.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const ADMIN_DEVICES_KEY = 'admin_devices'

export type AdminDeviceStatus = 'pending' | 'approved' | 'rejected'

export type AdminDevice = {
  id: string
  label: string
  status: AdminDeviceStatus
  createdAt: string
  lastSeenAt: string
  /** Primer dispositivo dueño */
  isOwner?: boolean
}

export type AdminDevicesStore = {
  devices: AdminDevice[]
}

function getSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Faltan variables de Supabase')
  return createClient(url, key)
}

export async function loadAdminDevices(
  supabase?: SupabaseClient
): Promise<AdminDevicesStore> {
  const client = supabase ?? getSupabase()
  const { data, error } = await client
    .from('app_settings')
    .select('value')
    .eq('key', ADMIN_DEVICES_KEY)
    .maybeSingle()

  if (error || !data?.value) return { devices: [] }
  const raw = data.value as AdminDevicesStore
  if (!raw || !Array.isArray(raw.devices)) return { devices: [] }
  return { devices: raw.devices }
}

export async function saveAdminDevices(
  store: AdminDevicesStore,
  supabase?: SupabaseClient
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = supabase ?? getSupabase()
  const { error } = await client.from('app_settings').upsert(
    {
      key: ADMIN_DEVICES_KEY,
      value: { devices: store.devices },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export function findDevice(
  store: AdminDevicesStore,
  deviceId: string
): AdminDevice | undefined {
  return store.devices.find((d) => d.id === deviceId)
}

export function hasAnyApproved(store: AdminDevicesStore): boolean {
  return store.devices.some((d) => d.status === 'approved')
}

/**
 * Login con password ya verificado:
 * - sin approved → este device pasa a approved (owner)
 * - device approved → ok
 * - device desconocido → pending
 * - rejected → rejected
 */
export async function registerOrCheckDevice(opts: {
  deviceId: string
  label?: string
  supabase?: SupabaseClient
}): Promise<
  | { status: 'approved'; device: AdminDevice; store: AdminDevicesStore }
  | { status: 'pending'; device: AdminDevice; store: AdminDevicesStore }
  | { status: 'rejected'; device: AdminDevice; store: AdminDevicesStore }
> {
  const client = opts.supabase ?? getSupabase()
  let store = await loadAdminDevices(client)
  const now = new Date().toISOString()
  const id = opts.deviceId.trim().slice(0, 80)
  const label = (opts.label || 'Dispositivo').trim().slice(0, 60)

  let device = findDevice(store, id)

  if (!device) {
    const isFirst = !hasAnyApproved(store)
    device = {
      id,
      label,
      status: isFirst ? 'approved' : 'pending',
      createdAt: now,
      lastSeenAt: now,
      isOwner: isFirst,
    }
    store = { devices: [...store.devices, device] }
    await saveAdminDevices(store, client)
    return { status: device.status, device, store }
  }

  // actualizar lastSeen / label
  device = {
    ...device,
    label: label || device.label,
    lastSeenAt: now,
  }
  store = {
    devices: store.devices.map((d) => (d.id === id ? device! : d)),
  }
  await saveAdminDevices(store, client)

  return { status: device.status, device, store }
}

export async function isDeviceApproved(
  deviceId: string | null | undefined,
  supabase?: SupabaseClient
): Promise<boolean> {
  if (!deviceId?.trim()) return false
  const store = await loadAdminDevices(supabase)
  // Si aún no hay nadie aprobado, permitir solo tras register (first wins)
  const d = findDevice(store, deviceId.trim())
  return d?.status === 'approved'
}

export async function setDeviceStatus(opts: {
  deviceId: string
  status: AdminDeviceStatus
  actorDeviceId: string
  supabase?: SupabaseClient
}): Promise<{ ok: true; store: AdminDevicesStore } | { ok: false; error: string }> {
  const client = opts.supabase ?? getSupabase()
  const store = await loadAdminDevices(client)
  const actor = findDevice(store, opts.actorDeviceId)
  if (!actor || actor.status !== 'approved') {
    return { ok: false, error: 'Solo un admin aprobado puede gestionar dispositivos' }
  }

  const target = findDevice(store, opts.deviceId)
  if (!target) return { ok: false, error: 'Dispositivo no encontrado' }
  if (target.isOwner && opts.status !== 'approved') {
    return { ok: false, error: 'No se puede rechazar al dueño' }
  }

  const next: AdminDevicesStore = {
    devices: store.devices.map((d) =>
      d.id === opts.deviceId
        ? { ...d, status: opts.status, lastSeenAt: new Date().toISOString() }
        : d
    ),
  }
  const saved = await saveAdminDevices(next, client)
  if (!saved.ok) return saved
  return { ok: true, store: next }
}
