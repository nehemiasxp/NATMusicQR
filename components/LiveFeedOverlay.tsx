'use client'

/**
 * Overlay TV estilo TikTok — parte SUPERIOR, visible también en fullscreen del stage.
 * - Comentarios: arriba, uno a la vez, respiración suave
 * - Likes: burbujas arriba-derecha, temporales
 * pointer-events: none (no tapa controles del stage)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveFeedItem } from '@/lib/live-feed'

type Bubble = {
  key: string
  kind: 'like' | 'dislike'
  name: string
  x: number
  delay: number
}

type Props = {
  venueSlug: string
  pollMs?: number
  /** true = stage a pantalla completa (tipografía más grande) */
  fullscreen?: boolean
}

const COMMENT_SHOW_MS = 5500
const COMMENT_GAP_MS = 1400
const BUBBLE_LIFE_MS = 3000

export default function LiveFeedOverlay({
  venueSlug,
  pollMs = 1000,
  fullscreen = false,
}: Props) {
  const seenRef = useRef<Set<string>>(new Set())
  const sinceRef = useRef<string>(new Date(Date.now() - 20_000).toISOString())
  const commentQueueRef = useRef<LiveFeedItem[]>([])
  const showingCommentRef = useRef(false)
  const drainRef = useRef<() => void>(() => {})

  const [comment, setComment] = useState<LiveFeedItem | null>(null)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [breathPhase, setBreathPhase] = useState(0)
  /** Historial corto arriba (últimos 3) para que la sala siempre vea algo */
  const [ticker, setTicker] = useState<LiveFeedItem[]>([])

  useEffect(() => {
    drainRef.current = () => {
      if (showingCommentRef.current) return
      const next = commentQueueRef.current.shift()
      if (!next) return

      showingCommentRef.current = true
      setComment(next)
      setBreathPhase(0)
      setTicker((prev) => [next, ...prev.filter((p) => p.id !== next.id)].slice(0, 3))

      const breathTimers = [
        window.setTimeout(() => setBreathPhase(1), 350),
        window.setTimeout(() => setBreathPhase(2), 2000),
        window.setTimeout(() => setBreathPhase(3), 4200),
      ]

      window.setTimeout(() => {
        setComment(null)
        breathTimers.forEach(clearTimeout)
        window.setTimeout(() => {
          showingCommentRef.current = false
          drainRef.current()
        }, COMMENT_GAP_MS)
      }, COMMENT_SHOW_MS)
    }
  }, [])

  const enqueueComment = useCallback((item: LiveFeedItem) => {
    commentQueueRef.current.push(item)
    if (commentQueueRef.current.length > 8) {
      commentQueueRef.current = commentQueueRef.current.slice(-8)
    }
    drainRef.current()
  }, [])

  const spawnBubble = useCallback((item: LiveFeedItem) => {
    if (item.kind !== 'like' && item.kind !== 'dislike') return
    const key = item.id
    const bubble: Bubble = {
      key,
      kind: item.kind,
      name: item.display_name,
      x: 6 + Math.random() * 40,
      delay: Math.random() * 100,
    }
    setBubbles((prev) => [...prev, bubble].slice(-10))
    window.setTimeout(() => {
      setBubbles((prev) => prev.filter((b) => b.key !== key))
    }, BUBBLE_LIFE_MS + bubble.delay)
  }, [])

  useEffect(() => {
    if (!venueSlug) return
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch(
          `/api/live/feed?venueSlug=${encodeURIComponent(venueSlug)}&since=${encodeURIComponent(sinceRef.current)}`,
          { cache: 'no-store' }
        )
        const data = await res.json()
        if (cancelled || !res.ok) return

        const items = (data.items ?? []) as LiveFeedItem[]
        if (data.serverTime) {
          const t = Date.parse(data.serverTime) - 2000
          if (!Number.isNaN(t)) {
            sinceRef.current = new Date(t).toISOString()
          }
        }

        for (const item of items) {
          if (seenRef.current.has(item.id)) continue
          seenRef.current.add(item.id)
          if (seenRef.current.size > 250) {
            seenRef.current = new Set(Array.from(seenRef.current).slice(-120))
          }

          if (item.kind === 'comment') {
            enqueueComment(item)
          } else {
            spawnBubble(item)
          }
        }
      } catch {
        /* ignore */
      }
    }

    void poll()
    const t = setInterval(poll, pollMs)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [venueSlug, pollMs, enqueueComment, spawnBubble])

  const breathScale =
    breathPhase === 1
      ? 1.04
      : breathPhase === 2
        ? 1.02
        : breathPhase === 3
          ? 0.97
          : 1

  const nameSize = fullscreen ? 'text-xl sm:text-2xl' : 'text-base sm:text-lg'
  const bodySize = fullscreen
    ? 'text-2xl sm:text-3xl'
    : 'text-lg sm:text-xl'
  const avatarSize = fullscreen ? 'h-12 w-12 text-lg' : 'h-10 w-10 text-base'

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[40] overflow-hidden"
      aria-live="polite"
    >
      {/* Franja superior: ticker + comentario principal */}
      <div className="absolute inset-x-0 top-0 z-[41] bg-gradient-to-b from-black/70 via-black/35 to-transparent px-3 pb-16 pt-3 sm:px-5 sm:pt-4">
        {/* Ticker de últimos comentarios (siempre visible si hay) */}
        {ticker.length > 0 && !comment && (
          <div className="mb-2 flex flex-wrap gap-2">
            {ticker.map((t) => (
              <div
                key={t.id}
                className="max-w-full truncate rounded-full bg-black/50 px-3 py-1 text-xs text-zinc-200 ring-1 ring-white/10 backdrop-blur-sm sm:text-sm"
              >
                <span className="font-bold text-emerald-300">
                  {t.display_name}
                </span>
                <span className="text-zinc-400"> · </span>
                <span>{t.body}</span>
              </div>
            ))}
          </div>
        )}

        {/* Comentario destacado (respiración) — PARTE SUPERIOR */}
        {comment && (
          <div
            className="mx-auto w-full max-w-3xl transition-all duration-[850ms] ease-in-out"
            style={{
              transform: `scale(${breathScale}) translateY(${breathPhase === 3 ? -6 : 0}px)`,
              opacity: breathPhase === 3 ? 0 : 1,
            }}
          >
            <div className="rounded-2xl bg-black/55 px-4 py-3 shadow-2xl shadow-black/50 backdrop-blur-md ring-1 ring-white/15 sm:px-6 sm:py-4">
              <div className="mb-2 flex items-center gap-3">
                <span
                  className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-violet-500 font-bold text-white shadow-md ${avatarSize}`}
                >
                  {(comment.display_name || '?').slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p
                    className={`truncate font-bold tracking-tight text-white drop-shadow ${nameSize}`}
                  >
                    {comment.display_name}
                  </p>
                  {comment.table_label &&
                    comment.table_label !== comment.display_name && (
                      <p className="truncate text-xs text-zinc-300/90 sm:text-sm">
                        {comment.table_label}
                      </p>
                    )}
                </div>
                <span className="ml-auto shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300">
                  en vivo
                </span>
              </div>
              <p
                className={`font-semibold leading-snug text-zinc-50 drop-shadow-md ${bodySize}`}
              >
                {comment.body}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Burbujas like — suben desde mitad superior derecha */}
      {bubbles.map((b) => (
        <div
          key={b.key}
          className="live-feed-bubble-top absolute top-[28%]"
          style={{
            right: `${b.x}%`,
            animationDelay: `${b.delay}ms`,
          }}
        >
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-bold shadow-lg backdrop-blur-sm sm:text-base ${
              b.kind === 'like'
                ? 'bg-emerald-500/90 text-white ring-1 ring-emerald-200/50'
                : 'bg-red-600/90 text-white ring-1 ring-red-200/50'
            }`}
          >
            <span className="text-lg leading-none">
              {b.kind === 'like' ? '👍' : '👎'}
            </span>
            <span className="max-w-[8rem] truncate">{b.name}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
