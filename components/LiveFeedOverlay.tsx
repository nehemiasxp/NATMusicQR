'use client'

/**
 * Overlay TV estilo TikTok:
 * - Comentarios: uno a la vez, "respiración", no invasivo
 * - Likes/dislikes: burbujas flotantes temporales
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
}

const COMMENT_SHOW_MS = 5200
const COMMENT_GAP_MS = 1600
const BUBBLE_LIFE_MS = 2800

export default function LiveFeedOverlay({ venueSlug, pollMs = 1200 }: Props) {
  const seenRef = useRef<Set<string>>(new Set())
  const sinceRef = useRef<string>(new Date(Date.now() - 15_000).toISOString())
  const commentQueueRef = useRef<LiveFeedItem[]>([])
  const showingCommentRef = useRef(false)
  const drainRef = useRef<() => void>(() => {})

  const [comment, setComment] = useState<LiveFeedItem | null>(null)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [breathPhase, setBreathPhase] = useState(0)

  useEffect(() => {
    drainRef.current = () => {
      if (showingCommentRef.current) return
      const next = commentQueueRef.current.shift()
      if (!next) return

      showingCommentRef.current = true
      setComment(next)
      setBreathPhase(0)

      const breathTimers = [
        window.setTimeout(() => setBreathPhase(1), 400),
        window.setTimeout(() => setBreathPhase(2), 2200),
        window.setTimeout(() => setBreathPhase(3), 4000),
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
    // Máx. 6 en cola para no saturar la TV
    if (commentQueueRef.current.length > 6) {
      commentQueueRef.current = commentQueueRef.current.slice(-6)
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
      x: 8 + Math.random() * 34,
      delay: Math.random() * 120,
    }
    setBubbles((prev) => [...prev, bubble].slice(-8))
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
          if (seenRef.current.size > 200) {
            const arr = Array.from(seenRef.current)
            seenRef.current = new Set(arr.slice(-100))
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
      ? 1.035
      : breathPhase === 2
        ? 1.02
        : breathPhase === 3
          ? 0.98
          : 1

  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
      aria-live="polite"
    >
      {comment && (
        <div
          className="absolute bottom-[12%] left-[4%] right-[28%] max-w-xl transition-all duration-[900ms] ease-in-out"
          style={{
            transform: `scale(${breathScale}) translateY(${breathPhase === 3 ? 8 : 0}px)`,
            opacity: breathPhase === 3 ? 0 : 1,
          }}
        >
          <div className="rounded-2xl bg-black/45 px-5 py-4 shadow-2xl shadow-black/40 backdrop-blur-md ring-1 ring-white/10">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-violet-500 text-sm font-bold text-white shadow-md">
                {(comment.display_name || '?').slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-base font-bold tracking-tight text-white drop-shadow">
                  {comment.display_name}
                </p>
                {comment.table_label &&
                  comment.table_label !== comment.display_name && (
                    <p className="truncate text-[11px] text-zinc-300/80">
                      {comment.table_label}
                    </p>
                  )}
              </div>
            </div>
            <p className="text-lg font-medium leading-snug text-zinc-50 drop-shadow-md sm:text-xl">
              {comment.body}
            </p>
          </div>
        </div>
      )}

      {bubbles.map((b) => (
        <div
          key={b.key}
          className="live-feed-bubble absolute bottom-[8%]"
          style={{
            right: `${b.x}%`,
            animationDelay: `${b.delay}ms`,
          }}
        >
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold shadow-lg backdrop-blur-sm ${
              b.kind === 'like'
                ? 'bg-emerald-500/85 text-white ring-1 ring-emerald-300/40'
                : 'bg-red-600/85 text-white ring-1 ring-red-300/40'
            }`}
          >
            <span className="text-base leading-none">
              {b.kind === 'like' ? '👍' : '👎'}
            </span>
            <span className="max-w-[7rem] truncate">{b.name}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
