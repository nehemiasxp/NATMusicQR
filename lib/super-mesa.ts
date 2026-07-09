/**
 * Mesa secreta con super poderes (control de cola desde el join).
 * Activar con mesa "i9" o nombre de usuario "i9" (sin importar mayúsculas).
 */

export const SUPER_MESA_NAME = 'i9'

function tokenIsSuper(raw: string | null | undefined): boolean {
  if (!raw) return false
  const t = raw.trim().toLowerCase()
  if (!t) return false
  if (t === SUPER_MESA_NAME) return true
  // "Mesa i9" / "mesa-i9"
  const stripped = t
    .replace(/^mesa[\s_-]+/i, '')
    .replace(/[\s_-]+/g, '')
    .trim()
  return stripped === SUPER_MESA_NAME
}

/**
 * True si el label de mesa o el nombre indica super usuario.
 * Acepta: "i9", "Mesa i9", "i9 · Carlos", "Mesa 4 · i9"
 */
export function isSuperMesa(label: string | null | undefined): boolean {
  if (!label) return false
  const full = label.trim()
  if (!full) return false

  const parts = full.split('·').map((p) => p.trim())
  // Cualquier segmento (mesa o nombre) puede ser i9
  if (parts.some((p) => tokenIsSuper(p))) return true
  // Por si viene todo junto sin separador
  return tokenIsSuper(full)
}

/** Sesión de join con mesa y/o display name */
export function isSuperSession(session: {
  tableName?: string | null
  displayName?: string | null
} | null): boolean {
  if (!session) return false
  if (isSuperMesa(session.tableName)) return true
  if (isSuperMesa(session.displayName)) return true
  return false
}
