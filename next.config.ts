import type { NextConfig } from 'next'

/**
 * Anti-caché en HTML/rutas de app (móviles Safari/Chrome guardan el shell viejo).
 * Los assets con hash en /_next/static/* siguen cacheables (immutable).
 */
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Documentos HTML y rutas de la app (no estáticos hasheados)
        source: '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
        ],
      },
      {
        // Assets de Next con hash: cache largo (el nombre cambia en cada build)
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ]
  },
}

export default nextConfig
