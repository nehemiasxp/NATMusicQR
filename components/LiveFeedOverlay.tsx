'use client'

/**
 * Overlay TV: comentarios arriba + burbujas like.
 * Polling simple: siempre pide el feed completo de la ventana y muestra no-vistos.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveFeedItem } from '@/lib/live-feed'

type Bubble = {
  key: string
  kind: 'like' | 'dislike'
  name: string
  x: number
}

type Props = {
  venueSlug: string
  pollMs?: number
  fullscreen?: boolean
}

const COMMENT_SHOW_MS = 6000
const COMMENT_GAP_MS = 1200
const BUBBLE_LIFE_MS = 3200

export default function LiveFeedOverlay({
  venueSlug,
  pollMs = 900,
  fullscreen = false,
}: Props) {
  const seenRef = useRef<Set<string>>(new Set())
  const commentQ = useRef<LiveFeedItem[]>([])
  const showingRef = useRef(false)
  const drainRef = useRef<() => void>(() => {})

  const [comment, setComment] = useState<LiveFeedItem | null>(null)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [breath, setBreath] = useState(0)
  const [ticker, setTicker] = useState<LiveFeedItem[]>([])
  const [liveOk, setLiveOk] = useState(true)

  useEffect(() => {
    drainRef.current = () => {
      if (showingRef.current) return
      const next = commentQ.current.shift()
      if (!next) return

      showingRef.current = true
      setComment(next)
      setBreath(0)
      setTicker((prev) =>
        [next, ...prev.filter((p) => p.id !== next.id)].slice(0, 4)
      )

      const timers = [
        window.setTimeout(() => setBreath(1), 300),
        window.setTimeout(() => setBreath(2), 2200),
        window.setTimeout(() => setBreath(3), 4800),
      ]

      window.setTimeout(() => {
        setComment(null)
        timers.forEach(clearTimeout)
        window.setTimeout(() => {
          showingRef.current = false
          drainRef.current()
        }, COMMENT_GAP_MS)
      }, COMMENT_SHOW_MS)
    }
  }, [])

  const onItem = useCallback((item: LiveFeedItem) => {
    if (seenRef.current.has(item.id)) return
    seenRef.current.add(item.id)
    if (seenRef.current.size > 300) {
      seenRef.current = new Set(Array.from(seenRef.current).slice(-150))
    }

    if (item.kind === 'comment') {
      commentQ.current.push(item)
      if (commentQ.current.length > 10) {
        commentQ.current = commentQ.current.slice(-10)
      }
      drainRef.current()
      return
    }

    if (item.kind !== 'like' && item.kind !== 'dislike') return
    const key = item.id
    const bubble: Bubble = {
      key,
      kind: item.kind,
      name: item.display_name,
      x: 4 + Math.random() * 42,
    }
    setBubbles((prev) => [...prev, bubble].slice(-12))
    window.setTimeout(() => {
      setBubbles((prev) => prev.filter((b) => b.key !== key))
    }, BUBBLE_LIFE_MS)
  }, [])

  useEffect(() => {
    if (!venueSlug) return
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch(
          `/api/live/feed?venueSlug=${encodeURIComponent(venueSlug)}`,
          { cache: 'no-store' }
        )
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setLiveOk(false)
          return
        }
        setLiveOk(true)
        const items = (data.items ?? []) as LiveFeedItem[]
        for (const item of items) {
          onItem(item)
        }
      } catch {
        if (!cancelled) setLiveOk(false)
      }
    }

    void poll()
    const t = setInterval(poll, pollMs)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [venueSlug, pollMs, onItem])

  const scale = breath === 1 ? 1.04 : breath === 2 ? 1.02 : breath === 3 ? 0.97 : 1
  const nameCls = fullscreen ? 'text-xl sm:text-2xl' : 'text-base sm:text-lg'
  const bodyCls = fullscreen ? 'text-2xl sm:text-3xl' : 'text-lg sm:text-xl'

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[999] overflow-hidden"
      aria-live="polite"
    >
      {/* Debug sutil si el feed falla */}
      {!liveOk && (
        <div className="absolute right-2 top-2 rounded bg-emerald-900/80 px-2 py-0.5 text-[10px] text-emerald-100">
          feed offline
        </div>
      )}

      <div className="absolute inset-x-0 top-0 z-[1000] bg-gradient-to-b from-black/75 via-black/40 to-transparent px-3 pb-20 pt-3 sm:px-5 sm:pt-5">
        {ticker.length > 0 && !comment && (
          <div className="mb-2 flex flex-wrap gap-2">
            {ticker.map((t) => (
              <div
                key={t.id}
                className="max-w-full truncate rounded-full bg-black/55 px-3 py-1 text-xs text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm sm:text-sm"
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

        {comment && (
          <div
            className="mx-auto w-full max-w-3xl transition-all duration-700 ease-in-out"
            style={{
              transform: `scale(${scale})`,
              opacity: breath === 3 ? 0 : 1,
            }}
          >
            <div className="rounded-2xl bg-black/60 px-4 py-3 shadow-2xl ring-1 ring-white/20 backdrop-blur-md sm:px-6 sm:py-4">
              <div className="mb-2 flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-violet-500 text-base font-bold text-white shadow-md">
                  {(comment.display_name || '?').slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate font-bold text-white drop-shadow ${nameCls}`}
                  >
                    {comment.display_name}
                  </p>
                  {comment.table_label &&
                    comment.table_label !== comment.display_name && (
                      <p className="truncate text-xs text-zinc-300">
                        {comment.table_label}
                      </p>
                    )}
                </div>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300 ring-1 ring-emerald-400/30">
                  en vivo
                </span>
              </div>
              <p
                className={`font-semibold leading-snug text-white drop-shadow ${bodyCls}`}
              >
                {comment.body}
              </p>
            </div>
          </div>
        )}
      </div>

      {bubbles.map((b) => (
        <div
          key={b.key}
          className="live-feed-bubble-top absolute top-[26%]"
          style={{ right: `${b.x}%` }}
        >
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-bold shadow-lg backdrop-blur-sm sm:text-base ${
              b.kind === 'like'
                ? 'bg-emerald-500 text-white ring-2 ring-emerald-200/60'
                : 'bg-emerald-600 text-white ring-2 ring-emerald-200/60'
            }`}
          >
            <span className="text-lg">
              {b.kind === 'like' ? '👍' : '👎'}
            </span>
            <span className="max-w-[9rem] truncate">{b.name}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
