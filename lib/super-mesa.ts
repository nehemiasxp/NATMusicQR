/**
 * Super poderes SOLO con mesa/nombre exactamente "i9" (o "Mesa i9").
 * No se activa por entrar al join normal.
 */

export const SUPER_MESA_NAME = 'i9'

/** Solo coincidencias explícitas de i9 */
export function isSuperMesa(label: string | null | undefined): boolean {
  if (!label) return false
  const t = label
    .trim()
    .toLowerCase()
    .replace(/[·•|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!t) return false
  if (t === 'i9') return true
  if (t === 'mesa i9') return true
  if (t === 'mesa-i9' || t === 'mesa_i9') return true

  // "Mesa 4 · i9" → algún segmento exacto
  const parts = t.split(' ').filter(Boolean)
  // re-split por si venía "mesa 4 · i9" ya normalizado
  const segs = label
    .split(/[·•|]/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (segs.some((s) => s === 'i9' || s === 'mesa i9')) return true

  // último recurso: solo la palabra i9 sola tras quitar "mesa"
  const stripped = t.replace(/^mesa\s+/, '').trim()
  return stripped === 'i9'
}

export function isSuperSession(session: {
  tableName?: string | null
  displayName?: string | null
  superUser?: boolean | null
} | null): boolean {
  if (!session) return false
  // Flag solo cuenta si la mesa sigue siendo i9 (evita “admin eterno”)
  if (session.superUser && isSuperMesa(session.tableName)) return true
  if (isSuperMesa(session.tableName)) return true
  if (isSuperMesa(session.displayName)) return true
  return false
}

/**
 * URL pide super de forma EXPLÍCITA:
 * - ?super=1 | ?super=i9 | ?poder=1
 * - ?mesa=i9 | ?mesa=Mesa%20i9 (no ?mesa=4)
 */
export function urlRequestsSuper(searchParams: {
  get: (key: string) => string | null
}): boolean {
  const superQ = (
    searchParams.get('super') ||
    searchParams.get('poder') ||
    ''
  )
    .trim()
    .toLowerCase()
  if (superQ && /^(1|true|yes|si|i9|on)$/i.test(superQ)) return true

  // NO usar ?admin= (choca con /admin mentalmente); solo super/poder/mesa=i9
  const mesa =
    searchParams.get('mesa') ||
    searchParams.get('table') ||
    searchParams.get('t') ||
    ''
  return isSuperMesa(mesa)
}

export function normalizeSuperTableName(raw: string): string {
  if (isSuperMesa(raw)) return SUPER_MESA_NAME
  return raw.trim()
}
