/**
 * Versión de la app para anti-caché en móviles.
 * En Vercel usa el commit; en local un fallback.
 * También se exportan versiones de UI (join/player).
 */

export const JOIN_UI_VERSION = '2.6.0'
export const PLAYER_UI_VERSION = '2.6.0'

/** Id de build (cambia en cada deploy de Vercel) */
export function getBuildId(): string {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.NEXT_PUBLIC_APP_VERSION?.trim()
  if (sha) return sha.slice(0, 12)
  return `local-${JOIN_UI_VERSION}`
}
