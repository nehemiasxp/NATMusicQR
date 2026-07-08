/** Identidad de mesa del cliente (localStorage, por venue). */

export type MesaSession = {
  tableName: string
  displayName: string | null
  joinedAt: string
  /** PIN del local verificado (se reenvía en cada pedido) */
  accessPin?: string | null
}

const PREFIX = 'natmusicqr:mesa:'

export function mesaStorageKey(venueSlug: string) {
  return `${PREFIX}${venueSlug}`
}

export function loadMesaSession(venueSlug: string): MesaSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(mesaStorageKey(venueSlug))
    if (!raw) return null
    const parsed = JSON.parse(raw) as MesaSession
    if (!parsed?.tableName?.trim()) return null
    return parsed
  } catch {
    return null
  }
}

export function saveMesaSession(
  venueSlug: string,
  session: Omit<MesaSession, 'joinedAt'> & { joinedAt?: string }
) {
  const value: MesaSession = {
    tableName: session.tableName.trim(),
    displayName: session.displayName?.trim() || null,
    joinedAt: session.joinedAt ?? new Date().toISOString(),
    accessPin: session.accessPin?.trim() || null,
  }
  localStorage.setItem(mesaStorageKey(venueSlug), JSON.stringify(value))
  return value
}

export function clearMesaSession(venueSlug: string) {
  localStorage.removeItem(mesaStorageKey(venueSlug))
}

/** Etiqueta que se guarda en queue_items.added_by_table */
export function formatTableLabel(session: MesaSession): string {
  const mesa = session.tableName.trim()
  const name = session.displayName?.trim()
  if (name) return `${mesa} · ${name}`
  return mesa
}
