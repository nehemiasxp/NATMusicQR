'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { RuntimeJukeboxConfig } from '@/config/jukebox.config'

const STORAGE_KEY = 'natmusicqr:admin-password'

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
  },
  ui: { showQueueOnJoin: true, pollIntervalMs: 3000 },
}

function qrImageUrl(data: string, size = 160) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}`
}

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [authed, setAuthed] = useState(false)
  const [config, setConfig] = useState<RuntimeJukeboxConfig>(emptyConfig)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // QR generator
  const [baseUrl, setBaseUrl] = useState('')
  const [venueSlug, setVenueSlug] = useState('natmusicqr')
  const [tableCount, setTableCount] = useState(12)
  const [tableStart, setTableStart] = useState(1)
  const [copied, setCopied] = useState<string | null>(null)

  // Cambio de contraseña
  const [currentPwd, setCurrentPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const [pwdMessage, setPwdMessage] = useState<string | null>(null)
  const [pwdError, setPwdError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin)
    }
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (saved) {
      setPassword(saved)
      void loadConfig(saved)
    }
  }, [])

  const loadConfig = useCallback(async (pwd: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/settings', {
        headers: { 'x-admin-password': pwd },
      })
      const data = await res.json()
      if (!res.ok) {
        setAuthed(false)
        setError(data.error || 'No autorizado')
        sessionStorage.removeItem(STORAGE_KEY)
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
      sessionStorage.setItem(STORAGE_KEY, pwd)
      setMessage(null)
    } catch {
      setError('No se pudo conectar')
      setAuthed(false)
    } finally {
      setLoading(false)
    }
  }, [])

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
    await loadConfig(password.trim())
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, config }),
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
      setConfig({ ...emptyConfig, ...data.config })
      setMessage('Reglas guardadas. Ya aplican a los nuevos pedidos.')
    } catch {
      setError('Error de red al guardar')
    } finally {
      setSaving(false)
    }
  }

  function logout() {
    sessionStorage.removeItem(STORAGE_KEY)
    setAuthed(false)
    setPassword('')
    setCurrentPwd('')
    setNewPwd('')
    setConfirmPwd('')
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwdSaving(true)
    setPwdError(null)
    setPwdMessage(null)
    try {
      const res = await fetch('/api/admin/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: currentPwd || password,
          newPassword: newPwd,
          confirmPassword: confirmPwd,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPwdError(
          data.hint ? `${data.error} — ${data.hint}` : data.error || 'Error'
        )
        return
      }
      // Actualizar sesión con la nueva clave
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

  if (!authed) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6"
        >
          <div>
            <p className="text-emerald-400 text-xs tracking-[2px] uppercase">
              NATMusicQR
            </p>
            <h1 className="text-2xl font-bold mt-1">Admin</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Reglas + códigos QR por mesa
            </p>
          </div>
          <label className="block">
            <span className="text-sm text-zinc-400">Contraseña</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 outline-none focus:border-emerald-500"
              placeholder="ADMIN_PASSWORD"
              autoFocus
            />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 disabled:opacity-50"
          >
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
          <p className="text-xs text-zinc-500">
            Clave actual:{' '}
            <code className="text-emerald-400">natmusicqr-admin</code>
          </p>
          <Link
            href="/"
            className="block text-center text-sm text-zinc-500 hover:text-zinc-300"
          >
            ← Inicio
          </Link>
        </form>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <p className="text-emerald-400 text-xs tracking-[2px] uppercase">
              NATMusicQR
            </p>
            <h1 className="text-3xl font-bold mt-1">Admin</h1>
            <p className="text-zinc-400 text-sm mt-1">
              Reglas del jukebox y QR por mesa
            </p>
          </div>
          <button
            type="button"
            onClick={logout}
            className="text-sm text-zinc-500 hover:text-zinc-300"
          >
            Salir
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-6 max-w-xl">
          {/* PIN + horario */}
          <section className="rounded-2xl border border-amber-900/40 bg-amber-950/20 p-5 space-y-4">
            <h2 className="font-semibold text-lg">Acceso del local</h2>
            <p className="text-xs text-zinc-400">
              Evita que usen el jukebox desde casa: PIN visible solo en el local
              + horario de atención.
            </p>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={config.access.pinEnabled}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    access: { ...c.access, pinEnabled: e.target.checked },
                  }))
                }
              />
              Exigir PIN del local
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">PIN (ej. 4 dígitos)</span>
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
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 tracking-widest disabled:opacity-40"
                maxLength={32}
                placeholder="1234"
              />
            </label>

            <label className="flex items-center gap-2 text-sm pt-2">
              <input
                type="checkbox"
                checked={config.access.hoursEnabled}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    access: { ...c.access, hoursEnabled: e.target.checked },
                  }))
                }
              />
              Limitar por horario de atención
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-zinc-400">Abre</span>
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
                  className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
                />
              </label>
              <label className="block">
                <span className="text-sm text-zinc-400">Cierra</span>
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
                  className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-sm text-zinc-400">Zona horaria</span>
              <select
                disabled={!config.access.hoursEnabled}
                value={config.access.timezone}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    access: { ...c.access, timezone: e.target.value },
                  }))
                }
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
              >
                <option value="America/Lima">America/Lima (Perú)</option>
                <option value="America/Bogota">America/Bogota (Colombia)</option>
                <option value="America/Mexico_City">America/Mexico_City</option>
                <option value="America/Santiago">America/Santiago (Chile)</option>
                <option value="America/Argentina/Buenos_Aires">
                  America/Argentina/Buenos_Aires
                </option>
                <option value="America/New_York">America/New_York</option>
                <option value="Europe/Madrid">Europe/Madrid</option>
                <option value="UTC">UTC</option>
              </select>
            </label>
            <p className="text-xs text-zinc-500">
              Si cierra después de medianoche (ej. 18:00 → 02:00), el sistema lo
              entiende bien.
            </p>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
            <h2 className="font-semibold text-lg">Duración máxima del video</h2>
            <label className="block">
              <span className="text-sm text-zinc-400">Minutos</span>
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
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3"
              />
            </label>
          </section>

          <section className="rounded-2xl border border-emerald-900/50 bg-emerald-950/20 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-lg">Por celular</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  ID único por teléfono al abrir el join (vía QR)
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm shrink-0">
                <input
                  type="checkbox"
                  checked={config.perDevice.enabled}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      perDevice: { ...c.perDevice, enabled: e.target.checked },
                    }))
                  }
                />
                Activo
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-zinc-400">Máx. canciones</span>
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
                  className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
                />
              </label>
              <label className="block">
                <span className="text-sm text-zinc-400">Cada (minutos)</span>
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
                  className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
                />
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-lg">Por mesa</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Límite compartido de la mesa
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm shrink-0">
                <input
                  type="checkbox"
                  checked={config.perTable.enabled}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      perTable: { ...c.perTable, enabled: e.target.checked },
                    }))
                  }
                />
                Activo
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-zinc-400">Máx. canciones</span>
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
                  className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
                />
              </label>
              <label className="block">
                <span className="text-sm text-zinc-400">Cada (minutos)</span>
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
                  className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
                />
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-emerald-900/40 bg-emerald-950/15 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-lg">autoplayMusica</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Si la cola está vacía, reproduce al azar canciones del catálogo
                  del local (no de pedidos de mesa).
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm shrink-0">
                <input
                  type="checkbox"
                  checked={config.autoplayMusic?.enabled ?? false}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      autoplayMusic: { enabled: e.target.checked },
                    }))
                  }
                />
                Activo
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-lg">Votos 👍 / 👎</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Cada celular vota la canción en reproducción. Si los 👎
                  llegan al % indicado, se salta a la siguiente.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm shrink-0">
                <input
                  type="checkbox"
                  checked={config.voting?.enabled ?? false}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      voting: {
                        ...(c.voting ?? emptyConfig.voting),
                        enabled: e.target.checked,
                      },
                    }))
                  }
                />
                Activo
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-zinc-400">
                  % no me gusta para saltar
                </span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  disabled={!config.voting.enabled}
                  value={config.voting?.skipThresholdPercent ?? 80}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      voting: {
                        ...(c.voting ?? emptyConfig.voting),
                        skipThresholdPercent: Number(e.target.value) || 80,
                      },
                    }))
                  }
                  className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
                />
              </label>
              <label className="block">
                <span className="text-sm text-zinc-400">
                  Mín. votos para saltar
                </span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  disabled={!config.voting.enabled}
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
                  className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 disabled:opacity-40"
                />
              </label>
            </div>
            <p className="text-xs text-zinc-500">
              Ej: 80% y mín. 2 → con 2 👎 de 2 votos (100%) salta; con 1 👎 no.
            </p>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
            <h2 className="font-semibold text-lg">Otras reglas</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={config.blockDuplicateInQueue}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    blockDuplicateInQueue: e.target.checked,
                  }))
                }
              />
              No permitir la misma canción si ya está en cola
            </label>
          </section>

          {error && (
            <div className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
          {message && (
            <div className="rounded-xl border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 font-semibold py-3.5 disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar reglas'}
          </button>
        </form>

        {/* —— Cambiar contraseña —— */}
        <section className="mt-10 max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 className="font-semibold text-xl mb-1">Cambiar contraseña admin</h2>
          <p className="text-sm text-zinc-400 mb-4">
            Se guarda en Supabase. La de <code className="text-zinc-500">.env</code>{' '}
            solo se usa si aún no has cambiado la clave aquí.
          </p>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <label className="block">
              <span className="text-sm text-zinc-400">Contraseña actual</span>
              <input
                type="password"
                value={currentPwd}
                onChange={(e) => setCurrentPwd(e.target.value)}
                placeholder="Deja vacío para usar la de esta sesión"
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 text-sm"
                autoComplete="current-password"
              />
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">Nueva contraseña</span>
              <input
                type="password"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                minLength={6}
                required
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 text-sm"
                autoComplete="new-password"
              />
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">Confirmar nueva</span>
              <input
                type="password"
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                minLength={6}
                required
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 text-sm"
                autoComplete="new-password"
              />
            </label>
            {pwdError && (
              <p className="text-sm text-red-400">{pwdError}</p>
            )}
            {pwdMessage && (
              <p className="text-sm text-emerald-400">{pwdMessage}</p>
            )}
            <button
              type="submit"
              disabled={pwdSaving}
              className="w-full rounded-xl border border-zinc-600 hover:border-emerald-600 font-medium py-3 disabled:opacity-50"
            >
              {pwdSaving ? 'Guardando…' : 'Actualizar contraseña'}
            </button>
          </form>
        </section>

        {/* —— Generador QR —— */}
        <section className="mt-10 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="font-semibold text-xl">QR por mesa</h2>
              <p className="text-sm text-zinc-400 mt-1">
                Cada QR abre el join con la mesa ya asignada. Al escanear se
                crea el ID del celular automáticamente.
              </p>
            </div>
            <button
              type="button"
              onClick={copyAllLinks}
              className="text-sm rounded-full border border-zinc-700 px-4 py-2 hover:border-emerald-600"
            >
              {copied === 'all' ? 'Copiado ✓' : 'Copiar todos los links'}
            </button>
          </div>

          <div className="grid sm:grid-cols-3 gap-3 mb-6">
            <label className="block sm:col-span-2">
              <span className="text-sm text-zinc-400">
                URL base (local o producción)
              </span>
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 text-sm"
                placeholder="http://192.168.1.142:3000 o https://tu-app.vercel.app"
              />
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">Slug del local</span>
              <input
                type="text"
                value={venueSlug}
                onChange={(e) => setVenueSlug(e.target.value)}
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">Desde mesa #</span>
              <input
                type="number"
                min={1}
                value={tableStart}
                onChange={(e) => setTableStart(Number(e.target.value) || 1)}
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-sm text-zinc-400">Cantidad de mesas</span>
              <input
                type="number"
                min={1}
                max={50}
                value={tableCount}
                onChange={(e) => setTableCount(Number(e.target.value) || 1)}
                className="mt-1 w-full rounded-xl bg-zinc-950 border border-zinc-700 px-4 py-3 text-sm"
              />
            </label>
          </div>

          <p className="text-xs text-zinc-500 mb-4">
            En el celular usa la IP de tu PC (ej.{' '}
            <code className="text-zinc-400">http://192.168.x.x:3000</code>), no{' '}
            <code className="text-zinc-400">localhost</code>.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {tableLinks.map((t) => (
              <div
                key={t.mesa}
                className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 flex flex-col items-center text-center"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrImageUrl(t.url, 160)}
                  alt={`QR ${t.label}`}
                  width={140}
                  height={140}
                  className="rounded-lg bg-white p-1"
                />
                <p className="font-semibold mt-2">{t.label}</p>
                <p className="text-[10px] text-zinc-500 break-all mt-1 leading-snug">
                  {t.url}
                </p>
                <button
                  type="button"
                  onClick={() => copyText(t.url, String(t.mesa))}
                  className="mt-2 text-xs text-emerald-400 hover:text-emerald-300"
                >
                  {copied === String(t.mesa) ? 'Copiado ✓' : 'Copiar link'}
                </button>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-8 flex flex-wrap gap-4 text-sm text-zinc-500">
          <Link href="/join/natmusicqr" className="hover:text-zinc-300">
            → Join cliente
          </Link>
          <Link href="/player/natmusicqr" className="hover:text-zinc-300">
            → Player TV
          </Link>
          <Link href="/" className="hover:text-zinc-300">
            → Inicio
          </Link>
        </div>
      </div>
    </div>
  )
}
