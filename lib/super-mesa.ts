/**
 * Super poderes: mesa o nombre "i9", o flag de sesión, o URL ?super=1 / ?mesa=i9
 */

export const SUPER_MESA_NAME = 'i9'

function tokenIsSuper(raw: string | null | undefined): boolean {
  if (!raw) return false
  let t = raw.trim().toLowerCase()
  if (!t) return false

  // quitar acentos raros / puntos
  t = t.replace(/[·•|]/g, ' ').replace(/\s+/g, ' ').trim()

  if (t === SUPER_MESA_NAME) return true
  if (t === `mesa ${SUPER_MESA_NAME}`) return true
  if (t === `mesa${SUPER_MESA_NAME}`) return true

  const stripped = t
    .replace(/^mesa[\s_-]+/i, '')
    .replace(/[\s_-]+/g, '')
    .trim()
  if (stripped === SUPER_MESA_NAME) return true

  // token suelto i9
  if (/(^|[\s._\-])i9($|[\s._\-])/i.test(t)) return true
  // solo dígitos/letras: "i9"
  if (/^i9$/i.test(stripped)) return true

  return false
}

export function isSuperMesa(label: string | null | undefined): boolean {
  if (!label) return false
  const full = label.trim()
  if (!full) return false

  // partes "Mesa 4 · i9"
  const parts = full.split(/[·•|]/).map((p) => p.trim())
  if (parts.some((p) => tokenIsSuper(p))) return true
  return tokenIsSuper(full)
}

export function isSuperSession(session: {
  tableName?: string | null
  displayName?: string | null
  superUser?: boolean | null
} | null): boolean {
  if (!session) return false
  if (session.superUser === true) return true
  if (isSuperMesa(session.tableName)) return true
  if (isSuperMesa(session.displayName)) return true
  return false
}

/** ¿La URL pide super? ?super=1 | ?admin=1 | ?mesa=i9 | ?t=i9 */
export function urlRequestsSuper(searchParams: {
  get: (key: string) => string | null
}): boolean {
  const superQ =
    searchParams.get('super') ||
    searchParams.get('admin') ||
    searchParams.get('poder')
  if (superQ && /^(1|true|yes|si|i9|on)$/i.test(superQ.trim())) return true

  const mesa =
    searchParams.get('mesa') ||
    searchParams.get('table') ||
    searchParams.get('t') ||
    searchParams.get('name') ||
    ''
  return isSuperMesa(mesa)
}

/** Normaliza el nombre de mesa super a "i9" limpio */
export function normalizeSuperTableName(raw: string): string {
  if (isSuperMesa(raw)) return SUPER_MESA_NAME
  return raw.trim()
}
