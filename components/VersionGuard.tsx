'use client'

/**
 * Detecta deploys nuevos y fuerza actualizar en móviles con caché agresiva.
 * - Compara /api/version (sin caché) con el build con el que cargó la página
 * - Banner "Actualizar" o auto-reload suave en TV
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'natmusicqr:build-id'
const POLL_MS = 45_000

type VersionPayload = {
  buildId: string
  join?: string
  player?: string
}

type Props = {
  /** 'banner' = el usuario toca para recargar (join). 'auto' = recarga sola (player TV) */
  mode?: 'banner' | 'auto'
}

export default function VersionGuard({ mode = 'banner' }: Props) {
  const bootIdRef = useRef<string | null>(null)
  const [updateReady, setUpdateReady] = useState(false)
  const [remoteId, setRemoteId] = useState<string | null>(null)

  const check = useCallback(async () => {
    try {
      const res = await fetch(`/api/version?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { Pragma: 'no-cache', 'Cache-Control': 'no-cache' },
      })
      if (!res.ok) return
      const data = (await res.json()) as VersionPayload
      if (!data.buildId) return

      if (!bootIdRef.current) {
        bootIdRef.current = data.buildId
        try {
          sessionStorage.setItem(STORAGE_KEY, data.buildId)
        } catch {
          /* ignore */
        }
        return
      }

      if (data.buildId !== bootIdRef.current) {
        setRemoteId(data.buildId)
        setUpdateReady(true)
      }
    } catch {
      /* offline */
    }
  }, [])

  useEffect(() => {
    void check()
    const t = window.setInterval(() => void check(), POLL_MS)
    // Al volver a la pestaña (muy común en móviles)
    const onVis = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
    }
  }, [check])

  useEffect(() => {
    if (!updateReady || mode !== 'auto') return
    // TV: recarga automática tras un momento
    const t = window.setTimeout(() => {
      hardReload()
    }, 2500)
    return () => window.clearTimeout(t)
  }, [updateReady, mode])

  function hardReload() {
    try {
      if (remoteId) sessionStorage.setItem(STORAGE_KEY, remoteId)
    } catch {
      /* ignore */
    }
    // Cache-buster en la URL para Safari iOS
    const url = new URL(window.location.href)
    url.searchParams.set('_v', String(Date.now()))
    window.location.replace(url.toString())
  }

  if (!updateReady || mode === 'auto') {
    // En auto el reload va solo; no molestar con UI (salvo un aviso breve)
    if (updateReady && mode === 'auto') {
      return (
        <div className="fixed bottom-4 left-1/2 z-[9999] -translate-x-1/2 rounded-full bg-amber-500 px-4 py-2 text-sm font-bold text-black shadow-lg">
          Actualizando TV…
        </div>
      )
    }
    return null
  }

  return (
    <div className="fixed inset-x-0 top-0 z-[9999] flex justify-center p-3 pointer-events-none">
      <button
        type="button"
        onClick={hardReload}
        className="pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl border border-amber-400/60 bg-amber-500 px-4 py-3 text-left text-sm font-bold text-zinc-950 shadow-2xl shadow-black/40"
      >
        <span className="text-lg" aria-hidden>
          🔄
        </span>
        <span>
          Hay una versión nueva
          <span className="mt-0.5 block text-xs font-semibold text-zinc-800">
            Toca aquí para actualizar (limpia caché)
          </span>
        </span>
      </button>
    </div>
  )
}
