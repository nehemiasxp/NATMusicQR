'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { RuntimeJukeboxConfig } from '@/config/jukebox.config'

const STORAGE_KEY = 'natmusicqr:admin-password'
const DEVICE_KEY = 'natmusicqr:admin-device-id'

/** Sube este número en cada release para verificar el deploy en Vercel */
export const ADMIN_UI_VERSION = '2.3.0'

type AdminDeviceRow = {
  id: string
  label: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  lastSeenAt: string
  isOwner?: boolean
}

function getOrCreateAdminDeviceId(): string {
  if (typeof window === 'undefined') return ''
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing && existing.length >= 8) return existing
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `adm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(DEVICE_KEY, id)
    return id
  } catch {
    return `adm-${Date.now()}`
  }
}

function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Dispositivo'
  const ua = navigator.userAgent
  if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad'
  if (/Android/i.test(ua)) return 'Android'
  if (/Mac/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows'
  return 'Navegador'
}

const emptyConfig: RuntimeJukeboxConfig = {
  maxDurationSeconds: 300,
  perTable: { enabled: true, maxSongs: 1, windowMinutes: 20 },
  perDevice: { enabled: true, maxSongs: 1, windowMinutes: 30 },
  perIp: { enabled: false, maxSongs: 3, windowMinutes: 30 },
  blockDuplicateInQueue: true,
  access: {
    pinEnabled: true,
    pin: '1234',
    hoursEnabled: true,
    timezone: 'America/Lima',
    openTime: '18:00',
    closeTime: '02:00',
  },
  autoplayMusic: { enabled: false },
  voting: {
    enabled: true,
    skipThresholdPercent: 80,
    minVotesToSkip: 2,
    upCancelsDown: true,
  },
  ui: { showQueueOnJoin: true, pollIntervalMs: 3000 },
}

type TabId = 'rules' | 'qr' | 'security' | 'library'

type LibraryVideo = {
  id: string
  youtube_id: string
  title: string
  artist: string | null
  thumbnail_url: string | null
  duration_seconds: number | null
  category: string | null
  is_active: boolean
}

function qrImageUrl(data: string, size = 140) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(data)}`
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
        checked ? 'bg-emerald-500' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
      {hint ? <span className="mt-1 block text-[11px] leading-snug text-zinc-600">{hint}</span> : null}
    </label>
  )
}

const inputClass =
  'w-full rounded-lg border border-zinc-800/90 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40'

const cardClass =
  'rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)_inset]'

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [authed, setAuthed] = useState(false)
  const [pending, setPending] = useState(false)
  const [deviceId, setDeviceId] = useState('')
  const [devices, setDevices] = useState<AdminDeviceRow[]>([])
  const [config, setConfig] = useState<RuntimeJukeboxConfig>(emptyConfig)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('rules')

  const [baseUrl, setBaseUrl] = useState('')
  const [venueSlug, setVenueSlug] = useState('natmusicqr')
  const [tableCount, setTableCount] = useState(12)
  const [tableStart, setTableStart] = useState(1)
  const [copied, setCopied] = useState<string | null>(null)

  const [currentPwd, setCurrentPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const [pwdMessage, setPwdMessage] = useState<string | null>(null)
  const [pwdError, setPwdError] = useState<string | null>(null)

  const [library, setLibrary] = useState<LibraryVideo[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryFilter, setLibraryFilter] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null)

  const adminHeaders = useCallback(
    (pwd: string) => ({
      'x-admin-password': pwd,
      'x-admin-device-id': deviceId || getOrCreateAdminDeviceId(),
    }),
    [deviceId]
  )

  const loadConfig = useCallback(
    async (pwd: string) => {
      setLoading(true)
      setError(null)
      try {
        const did = deviceId || getOrCreateAdminDeviceId()
        const res = await fetch('/api/admin/settings', {
          headers: {
            'x-admin-password': pwd,
            'x-admin-device-id': did,
          },
        })
        const data = await res.json()
        if (!res.ok) {
          setAuthed(false)
          if (data.code === 'DEVICE_PENDING') {
            setPending(true)
            setError(null)
          } else {
            setPending(false)
            setError(data.error || 'No autorizado')
            sessionStorage.removeItem(STORAGE_KEY)
          }
          return
        }
        setConfig({
          ...emptyConfig,
          ...data.config,
          access: {
            ...emptyConfig.access,
            ...data.config?.access,
            pin: data.config?.access?.pin ?? emptyConfig.access.pin,
          },
          autoplayMusic: {
            ...emptyConfig.autoplayMusic,
            ...data.config?.autoplayMusic,
          },
          voting: {
            ...emptyConfig.voting,
            ...data.config?.voting,
          },
        })
        setAuthed(true)
        setPending(false)
        sessionStorage.setItem(STORAGE_KEY, pwd)
        setMessage(null)
        // cargar lista de dispositivos
        void fetch('/api/admin/devices', {
          headers: {
            'x-admin-password': pwd,
            'x-admin-device-id': did,
          },
        })
          .then((r) => r.json())
          .then((d) => {
            if (d.devices) setDevices(d.devices as AdminDeviceRow[])
          })
          .catch(() => null)
      } catch {
        setError('No se pudo conectar')
        setAuthed(false)
      } finally {
        setLoading(false)
      }
    },
    [deviceId]
  )

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin)
      setDeviceId(getOrCreateAdminDeviceId())
    }
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (saved) {
      setPassword(saved)
    }
  }, [])

  // Reintentar carga cuando ya tenemos deviceId + password guardado
  useEffect(() => {
    if (!deviceId) return
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (saved && !authed && !pending) {
      void loadConfig(saved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  // Polling si está pendiente de aprobación
  useEffect(() => {
    if (!pending || !password || !deviceId) return
    const t = window.setInterval(async () => {
      try {
        const res = await fetch(
          `/api/admin/session?password=${encodeURIComponent(password)}&deviceId=${encodeURIComponent(deviceId)}`,
          { cache: 'no-store' }
        )
        const data = await res.json()
        if (data.status === 'approved') {
          setPending(false)
          await loadConfig(password)
        } else if (data.status === 'rejected') {
          setPending(false)
          setError('Este dispositivo fue rechazado')
          sessionStorage.removeItem(STORAGE_KEY)
        }
      } catch {
        /* ignore */
      }
    }, 3000)
    return () => window.clearInterval(t)
  }, [pending, password, deviceId, loadConfig])

  const tableLinks = useMemo(() => {
    const origin = (baseUrl || '').replace(/\/$/, '')
    if (!origin || !venueSlug.trim()) return []
    const count = Math.min(50, Math.max(1, tableCount || 1))
    const start = Math.max(1, tableStart || 1)
    return Array.from({ length: count }, (_, i) => {
      const n = start + i
      const url = `${origin}/join/${venueSlug.trim()}?mesa=${n}`
      return { mesa: n, url, label: `Mesa ${n}` }
    })
  }, [baseUrl, venueSlug, tableCount, tableStart])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setPending(false)
    const pwd = password.trim()
    const did = deviceId || getOrCreateAdminDeviceId()
    try {
      const res = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: pwd,
          deviceId: did,
          label: deviceLabel(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'No autorizado')
        setAuthed(false)
        return
      }
      if (data.status === 'pending') {
        setPending(true)
        setAuthed(false)
        sessionStorage.setItem(STORAGE_KEY, pwd)
        setMessage(null)
        setError(null)
        return
      }
      if (data.status === 'approved') {
        if (data.devices) setDevices(data.devices as AdminDeviceRow[])
        await loadConfig(pwd)
      }
    } catch {
      setError('No se pudo conectar')
    } finally {
      setLoading(false)
    }
  }

  async function handleDeviceAction(
    targetId: string,
    status: 'approved' | 'rejected'
  ) {
    setDeviceBusy(targetId)
    try {
      const res = await fetch('/api/admin/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          deviceId,
          targetId,
          status,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'No se pudo actualizar')
        return
      }
      if (data.devices) setDevices(data.devices as AdminDeviceRow[])
      setMessage(
        status === 'approved' ? 'Dispositivo aceptado' : 'Dispositivo rechazado'
      )
    } catch {
      setError('Error de red')
    } finally {
      setDeviceBusy(null)
    }
  }

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault()
    setSaving(true)
    setError(null)
    setMessage(null)
    const payload: RuntimeJukeboxConfig = {
      ...emptyConfig,
      ...config,
      access: { ...emptyConfig.access, ...config.access },
      autoplayMusic: {
        enabled: config.autoplayMusic?.enabled ?? false,
      },
      voting: {
        ...emptyConfig.voting,
        ...config.voting,
      },
    }
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...adminHeaders(password),
        },
        body: JSON.stringify({ password, deviceId, config: payload }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(
          data.hint
            ? `${data.error} — ${data.hint}`
            : data.error || 'Error al guardar'
        )
        return
      }
      setConfig({
        ...emptyConfig,
        ...data.config,
        access: { ...emptyConfig.access, ...data.config?.access },
        autoplayMusic: {
          ...emptyConfig.autoplayMusic,
          ...data.config?.autoplayMusic,
        },
        voting: { ...emptyConfig.voting, ...data.config?.voting },
      })
      setMessage(
        `Guardado · Autoplay ${
          data.config?.autoplayMusic?.enabled ? 'ON' : 'OFF'
        } · recarga la TV`
      )
    } catch {
      setError('Error de red al guardar')
    } finally {
      setSaving(false)
    }
  }

  function logout() {
    sessionStorage.removeItem(STORAGE_KEY)
    setAuthed(false)
    setPending(false)
    setPassword('')
    setCurrentPwd('')
    setNewPwd('')
    setConfirmPwd('')
    setDevices([])
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwdSaving(true)
    setPwdError(null)
    setPwdMessage(null)
    try {
      const res = await fetch('/api/admin/password', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...adminHeaders(password),
        },
        body: JSON.stringify({
          currentPassword: currentPwd || password,
          newPassword: newPwd,
          confirmPassword: confirmPwd,
          deviceId,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPwdError(
          data.hint ? `${data.error} — ${data.hint}` : data.error || 'Error'
        )
        return
      }
      setPassword(newPwd)
      sessionStorage.setItem(STORAGE_KEY, newPwd)
      setCurrentPwd('')
      setNewPwd('')
      setConfirmPwd('')
      setPwdMessage(data.message || 'Contraseña actualizada')
    } catch {
      setPwdError('Error de red al cambiar la contraseña')
    } finally {
      setPwdSaving(false)
    }
  }

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      setError('No se pudo copiar')
    }
  }

  function copyAllLinks() {
    const text = tableLinks.map((t) => `${t.label}\t${t.url}`).join('\n')
    void copyText(text, 'all')
  }

  const loadLibrary = useCallback(
    async (pwd: string, slug: string) => {
      setLibraryLoading(true)
      try {
        const did = deviceId || getOrCreateAdminDeviceId()
        const res = await fetch(
          `/api/admin/videos?slug=${encodeURIComponent(slug)}&deviceId=${encodeURIComponent(did)}`,
          {
            headers: {
              'x-admin-password': pwd,
              'x-admin-device-id': did,
            },
          }
        )
        const data = await res.json()
        if (!res.ok) {
          setError(data.error || 'No se pudo cargar la biblioteca')
          return
        }
        setLibrary((data.videos ?? []) as LibraryVideo[])
      } catch {
        setError('Error de red al cargar biblioteca')
      } finally {
        setLibraryLoading(false)
      }
    },
    [deviceId]
  )

  useEffect(() => {
    if (authed && tab === 'library' && password) {
      void loadLibrary(password, venueSlug.trim() || 'natmusicqr')
    }
  }, [authed, tab, password, venueSlug, loadLibrary])

  const filteredLibrary = useMemo(() => {
    const q = libraryFilter.trim().toLowerCase()
    if (!q) return library
    return library.filter((v) => {
      const hay = `${v.title} ${v.artist ?? ''} ${v.category ?? ''} ${v.youtube_id}`.toLowerCase()
      return hay.includes(q)
    })
  }, [library, libraryFilter])

  async function deleteVideo(video: LibraryVideo) {
    const ok = window.confirm(
      `¿Eliminar de la biblioteca?\n\n“${video.title}”\n\nTambién se quitará de la cola si está pendiente.`
    )
    if (!ok) return

    setDeletingId(video.id)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/videos', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...adminHeaders(password),
        },
        body: JSON.stringify({ password, deviceId, videoId: video.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(
          data.hint
            ? `${data.error} — ${data.hint}`
            : data.error || 'No se pudo eliminar'
        )
        return
      }
      setLibrary((list) => list.filter((v) => v.id !== video.id))
      setMessage(`Eliminada: ${data.deleted?.title ?? video.title}`)
    } catch {
      setError('Error de red al eliminar')
    } finally {
      setDeletingId(null)
    }
  }

  /* ——— Pendiente de aprobación ——— */
  if (pending && !authed) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-[#07080a] font-[family-name:var(--font-geist-sans)] text-zinc-100">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(245,158,11,0.12),_transparent_55%)]" />
        <div className="relative flex min-h-screen items-center justify-center p-5">
          <div className="w-full max-w-[400px] rounded-2xl border border-amber-800/50 bg-zinc-900/60 p-7 shadow-2xl backdrop-blur-xl text-center">
            <p className="text-3xl" aria-hidden>
              ⏳
            </p>
            <h1 className="mt-3 text-xl font-semibold text-white">
              Acceso pendiente
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              La contraseña es correcta, pero este dispositivo debe ser{' '}
              <strong className="text-amber-200">aceptado</strong> por un
              administrador que ya esté dentro del panel (pestaña Seguridad).
            </p>
            <p className="mt-4 text-xs text-zinc-500">
              Esperando aprobación… se actualiza solo.
            </p>
            <div className="mt-4 h-1 overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-amber-500" />
            </div>
            <button
              type="button"
              onClick={logout}
              className="mt-6 text-xs text-zinc-500 hover:text-zinc-300"
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ——— Login ——— */
  if (!authed) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-[#07080a] font-[family-name:var(--font-geist-sans)] text-zinc-100">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(16,185,129,0.12),_transparent_55%)]" />
        <div className="relative flex min-h-screen items-center justify-center p-5">
          <form
            onSubmit={handleLogin}
            className="w-full max-w-[380px] rounded-2xl border border-zinc-800/90 bg-zinc-900/50 p-7 shadow-2xl backdrop-blur-xl"
          >
            <div className="mb-6">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-400/90">
                  NATMusicQR
                </p>
                <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-emerald-300 ring-1 ring-emerald-500/30">
                  v{ADMIN_UI_VERSION}
                </span>
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                Panel de control
              </h1>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-500">
                Contraseña + aprobación de dispositivo
              </p>
            </div>
            <Field label="Contraseña">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
                placeholder="••••••••"
                autoFocus
              />
            </Field>
            {error && (
              <p className="mt-3 text-sm text-red-400">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="mt-5 w-full rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
            >
              {loading ? 'Verificando…' : 'Entrar'}
            </button>
            <p className="mt-3 text-center text-[11px] text-zinc-600">
              El primer acceso queda como dueño. Los siguientes quedan pendientes
              hasta que aceptes el dispositivo.
            </p>
            <Link
              href="/"
              className="mt-4 block text-center text-xs text-zinc-600 transition hover:text-zinc-400"
            >
              Volver al inicio
            </Link>
          </form>
        </div>
      </div>
    )
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'rules', label: 'Reglas' },
    { id: 'qr', label: 'QR mesas' },
    { id: 'security', label: 'Seguridad' },
    { id: 'library', label: 'Biblioteca' },
  ]

  return (
    <div className="min-h-screen bg-[#07080a] font-[family-name:var(--font-geist-sans)] text-zinc-100 antialiased">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,_rgba(16,185,129,0.08),_transparent)]" />

      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-[#07080a]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 md:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-400/90">
                NATMusicQR
              </p>
              <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-emerald-300 ring-1 ring-emerald-500/30">
                v{ADMIN_UI_VERSION}
              </span>
            </div>
            <h1 className="truncate text-lg font-semibold tracking-tight text-white md:text-xl">
              Administración
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/player/natmusicqr"
              className="hidden rounded-lg border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200 sm:inline-block"
            >
              TV
            </Link>
            <Link
              href="/join/natmusicqr"
              className="hidden rounded-lg border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200 sm:inline-block"
            >
              Join
            </Link>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
            <button
              type="button"
              onClick={logout}
              className="rounded-lg px-2 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
            >
              Salir
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="mx-auto flex max-w-5xl gap-1 px-4 pb-2 md:px-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition ${
                tab === t.id
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <main className="relative mx-auto max-w-5xl px-4 py-5 pb-24 md:px-6">
        {(error || message) && (
          <div
            className={`mb-4 rounded-lg border px-3.5 py-2.5 text-sm ${
              error
                ? 'border-red-900/60 bg-red-950/40 text-red-300'
                : 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300'
            }`}
          >
            {error || message}
          </div>
        )}

        {/* ——— REGLAS ——— */}
        {tab === 'rules' && (
          <form onSubmit={handleSave} className="space-y-3">
            {/* Status chips */}
            <div className="flex flex-wrap gap-2">
              <StatusChip
                on={config.autoplayMusic?.enabled}
                label="Autoplay"
              />
              <StatusChip on={config.voting?.enabled} label="Votos" />
              <StatusChip on={config.access.pinEnabled} label="PIN" />
              <StatusChip on={config.access.hoursEnabled} label="Horario" />
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              {/* Acceso */}
              <section className={cardClass}>
                <SectionHead
                  title="Acceso del local"
                  desc="PIN y horario para limitar uso fuera del bar"
                />
                <div className="mt-3 space-y-3">
                  <RowToggle
                    title="Exigir PIN"
                    checked={config.access.pinEnabled}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        access: { ...c.access, pinEnabled: v },
                      }))
                    }
                  />
                  <Field label="Código PIN">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={config.access.pin}
                      disabled={!config.access.pinEnabled}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          access: { ...c.access, pin: e.target.value },
                        }))
                      }
                      className={`${inputClass} tracking-[0.2em]`}
                      maxLength={32}
                      placeholder="1234"
                    />
                  </Field>
                  <div className="border-t border-zinc-800/80 pt-3">
                    <RowToggle
                      title="Horario de atención"
                      checked={config.access.hoursEnabled}
                      onChange={(v) =>
                        setConfig((c) => ({
                          ...c,
                          access: { ...c.access, hoursEnabled: v },
                        }))
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <Field label="Abre">
                      <input
                        type="time"
                        disabled={!config.access.hoursEnabled}
                        value={config.access.openTime}
                        onChange={(e) =>
                          setConfig((c) => ({
                            ...c,
                            access: { ...c.access, openTime: e.target.value },
                          }))
                        }
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Cierra">
                      <input
                        type="time"
                        disabled={!config.access.hoursEnabled}
                        value={config.access.closeTime}
                        onChange={(e) =>
                          setConfig((c) => ({
                            ...c,
                            access: { ...c.access, closeTime: e.target.value },
                          }))
                        }
                        className={inputClass}
                      />
                    </Field>
                  </div>
                  <Field label="Zona horaria">
                    <select
                      disabled={!config.access.hoursEnabled}
                      value={config.access.timezone}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          access: { ...c.access, timezone: e.target.value },
                        }))
                      }
                      className={inputClass}
                    >
                      <option value="America/Lima">Lima (Perú)</option>
                      <option value="America/Bogota">Bogotá</option>
                      <option value="America/Mexico_City">Ciudad de México</option>
                      <option value="America/Santiago">Santiago</option>
                      <option value="America/Argentina/Buenos_Aires">
                        Buenos Aires
                      </option>
                      <option value="America/New_York">New York</option>
                      <option value="Europe/Madrid">Madrid</option>
                      <option value="UTC">UTC</option>
                    </select>
                  </Field>
                </div>
              </section>

              {/* Reproducción */}
              <section className={cardClass}>
                <SectionHead
                  title="Reproducción"
                  desc="Duración, autoplay y catálogo"
                />
                <div className="mt-3 space-y-3">
                  <Field label="Duración máxima (min)">
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={Math.round(config.maxDurationSeconds / 60)}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          maxDurationSeconds:
                            Math.max(1, Number(e.target.value) || 1) * 60,
                        }))
                      }
                      className={inputClass}
                    />
                  </Field>
                  <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
                    <RowToggle
                      title="autoplayMusica"
                      subtitle="Cola vacía → canciones del catálogo al azar"
                      checked={config.autoplayMusic?.enabled ?? false}
                      onChange={(v) =>
                        setConfig((c) => ({
                          ...c,
                          autoplayMusic: { enabled: v },
                        }))
                      }
                    />
                  </div>
                  <RowToggle
                    title="Bloquear duplicados en cola"
                    checked={config.blockDuplicateInQueue}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        blockDuplicateInQueue: v,
                      }))
                    }
                  />
                </div>
              </section>

              {/* Límites */}
              <section className={cardClass}>
                <SectionHead
                  title="Límites de pedidos"
                  desc="Cuotas por celular y por mesa"
                />
                <div className="mt-3 space-y-4">
                  <div>
                    <RowToggle
                      title="Por celular"
                      subtitle="UUID del dispositivo"
                      checked={config.perDevice.enabled}
                      onChange={(v) =>
                        setConfig((c) => ({
                          ...c,
                          perDevice: { ...c.perDevice, enabled: v },
                        }))
                      }
                    />
                    <div className="mt-2 grid grid-cols-2 gap-2.5">
                      <Field label="Máx. canciones">
                        <input
                          type="number"
                          min={1}
                          max={50}
                          disabled={!config.perDevice.enabled}
                          value={config.perDevice.maxSongs}
                          onChange={(e) =>
                            setConfig((c) => ({
                              ...c,
                              perDevice: {
                                ...c.perDevice,
                                maxSongs: Number(e.target.value) || 1,
                              },
                            }))
                          }
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Cada (min)">
                        <input
                          type="number"
                          min={1}
                          max={1440}
                          disabled={!config.perDevice.enabled}
                          value={config.perDevice.windowMinutes}
                          onChange={(e) =>
                            setConfig((c) => ({
                              ...c,
                              perDevice: {
                                ...c.perDevice,
                                windowMinutes: Number(e.target.value) || 1,
                              },
                            }))
                          }
                          className={inputClass}
                        />
                      </Field>
                    </div>
                  </div>
                  <div className="border-t border-zinc-800/80 pt-3">
                    <RowToggle
                      title="Por mesa"
                      subtitle="Compartido entre celulares de la mesa"
                      checked={config.perTable.enabled}
                      onChange={(v) =>
                        setConfig((c) => ({
                          ...c,
                          perTable: { ...c.perTable, enabled: v },
                        }))
                      }
                    />
                    <div className="mt-2 grid grid-cols-2 gap-2.5">
                      <Field label="Máx. canciones">
                        <input
                          type="number"
                          min={1}
                          max={50}
                          disabled={!config.perTable.enabled}
                          value={config.perTable.maxSongs}
                          onChange={(e) =>
                            setConfig((c) => ({
                              ...c,
                              perTable: {
                                ...c.perTable,
                                maxSongs: Number(e.target.value) || 1,
                              },
                            }))
                          }
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Cada (min)">
                        <input
                          type="number"
                          min={1}
                          max={1440}
                          disabled={!config.perTable.enabled}
                          value={config.perTable.windowMinutes}
                          onChange={(e) =>
                            setConfig((c) => ({
                              ...c,
                              perTable: {
                                ...c.perTable,
                                windowMinutes: Number(e.target.value) || 1,
                              },
                            }))
                          }
                          className={inputClass}
                        />
                      </Field>
                    </div>
                  </div>
                </div>
              </section>

              {/* Votos */}
              <section className={cardClass}>
                <SectionHead
                  title="Votos en vivo"
                  desc="👍 / 👎 desde cada celular · salta si hay rechazo"
                />
                <div className="mt-3 space-y-3">
                  <RowToggle
                    title="Habilitar votación"
                    checked={config.voting?.enabled ?? false}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        voting: {
                          ...(c.voting ?? emptyConfig.voting),
                          enabled: v,
                        },
                      }))
                    }
                  />
                  <div className="grid grid-cols-2 gap-2.5">
                    <Field
                      label="% 👎 para saltar"
                      hint="Ej. 80"
                    >
                      <input
                        type="number"
                        min={1}
                        max={100}
                        disabled={!config.voting?.enabled}
                        value={config.voting?.skipThresholdPercent ?? 80}
                        onChange={(e) =>
                          setConfig((c) => ({
                            ...c,
                            voting: {
                              ...(c.voting ?? emptyConfig.voting),
                              skipThresholdPercent:
                                Number(e.target.value) || 80,
                            },
                          }))
                        }
                        className={inputClass}
                      />
                    </Field>
                    <Field
                      label="Mín. votos"
                      hint="Evita saltos con 1 voto"
                    >
                      <input
                        type="number"
                        min={1}
                        max={100}
                        disabled={!config.voting?.enabled}
                        value={config.voting?.minVotesToSkip ?? 2}
                        onChange={(e) =>
                          setConfig((c) => ({
                            ...c,
                            voting: {
                              ...(c.voting ?? emptyConfig.voting),
                              minVotesToSkip: Number(e.target.value) || 2,
                            },
                          }))
                        }
                        className={inputClass}
                      />
                    </Field>
                  </div>
                  <div
                    className={`rounded-lg border p-3 ${
                      config.voting?.enabled
                        ? 'border-emerald-500/20 bg-emerald-500/5'
                        : 'border-zinc-800/80 opacity-50'
                    }`}
                  >
                    <RowToggle
                      title="Voto + resta Voto −"
                      subtitle="Cada 👍 cancela un 👎 al calcular el % de salto"
                      checked={config.voting?.upCancelsDown ?? true}
                      onChange={(v) =>
                        setConfig((c) => ({
                          ...c,
                          voting: {
                            ...(c.voting ?? emptyConfig.voting),
                            upCancelsDown: v,
                          },
                        }))
                      }
                    />
                  </div>
                </div>
              </section>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="mt-1 w-full rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50 lg:hidden"
            >
              {saving ? 'Guardando…' : 'Guardar reglas'}
            </button>
          </form>
        )}

        {/* ——— QR ——— */}
        {tab === 'qr' && (
          <section className="space-y-3">
            <div className={`${cardClass} space-y-3`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <SectionHead
                  title="Códigos QR por mesa"
                  desc="Cada QR abre el join con mesa preasignada"
                />
                <button
                  type="button"
                  onClick={copyAllLinks}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-emerald-500/40 hover:text-emerald-300"
                >
                  {copied === 'all' ? 'Copiado' : 'Copiar todos'}
                </button>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="URL base" className="sm:col-span-2 lg:col-span-2">
                  <input
                    type="url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className={inputClass}
                    placeholder="https://nat-music-qr.vercel.app"
                  />
                </Field>
                <Field label="Slug">
                  <input
                    type="text"
                    value={venueSlug}
                    onChange={(e) => setVenueSlug(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2.5 sm:col-span-2 lg:col-span-1 lg:grid-cols-2">
                  <Field label="Desde #">
                    <input
                      type="number"
                      min={1}
                      value={tableStart}
                      onChange={(e) =>
                        setTableStart(Number(e.target.value) || 1)
                      }
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Cantidad">
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={tableCount}
                      onChange={(e) =>
                        setTableCount(Number(e.target.value) || 1)
                      }
                      className={inputClass}
                    />
                  </Field>
                </div>
              </div>
              <p className="text-[11px] text-zinc-600">
                En producción usa tu dominio Vercel. En red local, la IP del PC
                (no localhost).
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {tableLinks.map((t) => (
                <div
                  key={t.mesa}
                  className="flex flex-col items-center rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-2.5 text-center"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qrImageUrl(t.url, 132)}
                    alt={`QR ${t.label}`}
                    width={112}
                    height={112}
                    className="rounded-md bg-white p-1"
                  />
                  <p className="mt-2 text-xs font-semibold text-zinc-200">
                    {t.label}
                  </p>
                  <button
                    type="button"
                    onClick={() => copyText(t.url, String(t.mesa))}
                    className="mt-1 text-[10px] font-medium text-emerald-400/90 hover:text-emerald-300"
                  >
                    {copied === String(t.mesa) ? 'Copiado' : 'Copiar link'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ——— SEGURIDAD ——— */}
        {tab === 'security' && (
          <section className={`${cardClass} max-w-lg`}>
            <SectionHead
              title="Contraseña de admin"
              desc="Se guarda en Supabase. Tiene prioridad sobre .env"
            />
            <form onSubmit={handleChangePassword} className="mt-4 space-y-2.5">
              <Field label="Actual">
                <input
                  type="password"
                  value={currentPwd}
                  onChange={(e) => setCurrentPwd(e.target.value)}
                  placeholder="Vacío = sesión actual"
                  className={inputClass}
                  autoComplete="current-password"
                />
              </Field>
              <Field label="Nueva (mín. 6)">
                <input
                  type="password"
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  minLength={6}
                  required
                  className={inputClass}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirmar">
                <input
                  type="password"
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  minLength={6}
                  required
                  className={inputClass}
                  autoComplete="new-password"
                />
              </Field>
              {pwdError && (
                <p className="text-sm text-red-400">{pwdError}</p>
              )}
              {pwdMessage && (
                <p className="text-sm text-emerald-400">{pwdMessage}</p>
              )}
              <button
                type="submit"
                disabled={pwdSaving}
                className="mt-1 w-full rounded-lg border border-zinc-700 py-2.5 text-sm font-medium text-zinc-200 transition hover:border-emerald-500/40 hover:text-white disabled:opacity-50"
              >
                {pwdSaving ? 'Actualizando…' : 'Cambiar contraseña'}
              </button>
            </form>

            <div className={`${cardClass} space-y-3`}>
              <SectionHead
                title="Dispositivos admin"
                desc="Quién puede entrar al panel. Los pendientes necesitan tu aceptación."
              />
              {devices.filter((d) => d.status === 'pending').length > 0 && (
                <p className="rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
                  ⏳ Hay{' '}
                  {devices.filter((d) => d.status === 'pending').length}{' '}
                  dispositivo(s) pendiente(s) de aprobación
                </p>
              )}
              <div className="space-y-2">
                {devices.length === 0 ? (
                  <p className="text-sm text-zinc-500">Ningún dispositivo aún</p>
                ) : (
                  devices.map((d) => (
                    <div
                      key={d.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-100">
                          {d.label}
                          {d.isOwner ? (
                            <span className="ml-2 text-[10px] font-bold uppercase text-emerald-400">
                              dueño
                            </span>
                          ) : null}
                          {d.id === deviceId ? (
                            <span className="ml-2 text-[10px] text-sky-400">
                              este equipo
                            </span>
                          ) : null}
                        </p>
                        <p className="text-[11px] text-zinc-500">
                          {d.status === 'pending'
                            ? '⏳ Pendiente'
                            : d.status === 'approved'
                              ? '✅ Aprobado'
                              : '🚫 Rechazado'}
                          {' · '}
                          {new Date(d.createdAt).toLocaleString()}
                        </p>
                      </div>
                      {d.status === 'pending' && (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={deviceBusy === d.id}
                            onClick={() =>
                              void handleDeviceAction(d.id, 'approved')
                            }
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            Aceptar
                          </button>
                          <button
                            type="button"
                            disabled={deviceBusy === d.id}
                            onClick={() =>
                              void handleDeviceAction(d.id, 'rejected')
                            }
                            className="rounded-lg border border-red-800 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-950/50 disabled:opacity-50"
                          >
                            Rechazar
                          </button>
                        </div>
                      )}
                      {d.status === 'approved' && !d.isOwner && d.id !== deviceId && (
                        <button
                          type="button"
                          disabled={deviceBusy === d.id}
                          onClick={() =>
                            void handleDeviceAction(d.id, 'rejected')
                          }
                          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-red-800 hover:text-red-300"
                        >
                          Revocar
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        )}

        {/* ——— BIBLIOTECA ——— */}
        {tab === 'library' && (
          <section className="space-y-3">
            <div className={`${cardClass} space-y-3`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <SectionHead
                  title="Biblioteca de música"
                  desc="Elimina canciones del catálogo del local (join + autoplay)"
                />
                <button
                  type="button"
                  onClick={() =>
                    void loadLibrary(password, venueSlug.trim() || 'natmusicqr')
                  }
                  disabled={libraryLoading}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
                >
                  {libraryLoading ? 'Cargando…' : 'Actualizar'}
                </button>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-3">
                <Field label="Slug del local" className="sm:col-span-1">
                  <input
                    type="text"
                    value={venueSlug}
                    onChange={(e) => setVenueSlug(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Buscar" className="sm:col-span-2">
                  <input
                    type="search"
                    value={libraryFilter}
                    onChange={(e) => setLibraryFilter(e.target.value)}
                    className={inputClass}
                    placeholder="Título, artista, categoría…"
                  />
                </Field>
              </div>
              <p className="text-[11px] text-zinc-600">
                {filteredLibrary.length} de {library.length} canciones
              </p>
            </div>

            {libraryLoading && library.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                Cargando biblioteca…
              </p>
            ) : filteredLibrary.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                No hay canciones para mostrar
              </p>
            ) : (
              <div className="space-y-2">
                {filteredLibrary.map((video) => (
                  <div
                    key={video.id}
                    className="flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3"
                  >
                    {video.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={video.thumbnail_url}
                        alt=""
                        className="h-12 w-[4.5rem] shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <div className="flex h-12 w-[4.5rem] shrink-0 items-center justify-center rounded-md bg-zinc-800 text-[10px] text-zinc-600">
                        sin img
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">
                        {video.title}
                      </p>
                      <p className="truncate text-xs text-zinc-500">
                        {video.artist || '—'}
                        {video.category ? ` · ${video.category}` : ''}
                        {!video.is_active ? ' · inactiva' : ''}
                      </p>
                      <p className="truncate font-[family-name:var(--font-geist-mono)] text-[10px] text-zinc-600">
                        yt:{video.youtube_id}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={deletingId === video.id}
                      onClick={() => void deleteVideo(video)}
                      className="shrink-0 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:border-red-600 hover:bg-red-900/50 hover:text-red-100 disabled:opacity-50"
                    >
                      {deletingId === video.id ? '…' : 'Eliminar'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <p className="mt-8 text-center text-[11px] text-zinc-600">
          NATMusicQR · Admin UI v{ADMIN_UI_VERSION}
        </p>
      </main>
    </div>
  )
}

function SectionHead({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold tracking-tight text-zinc-100">
        {title}
      </h2>
      <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">{desc}</p>
    </div>
  )
}

function RowToggle({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string
  subtitle?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        {subtitle ? (
          <p className="text-[11px] leading-snug text-zinc-500">{subtitle}</p>
        ) : null}
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  )
}

function StatusChip({ on, label }: { on?: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        on
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-zinc-800 bg-zinc-900/50 text-zinc-500'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          on ? 'bg-emerald-400' : 'bg-zinc-600'
        }`}
      />
      {label}
    </span>
  )
}
