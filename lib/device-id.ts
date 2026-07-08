/** ID estable por teléfono/navegador (localStorage). */

const KEY = 'natmusicqr:device-id'

function randomId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `dev-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Cada celular obtiene un UUID único y persistente.
 * Así 3 personas en la misma mesa = 3 deviceIds distintos
 * aunque compartan WiFi/IP.
 */
export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return ''
  try {
    const existing = localStorage.getItem(KEY)
    if (existing && existing.length >= 8) return existing
    const id = randomId()
    localStorage.setItem(KEY, id)
    return id
  } catch {
    return randomId()
  }
}
