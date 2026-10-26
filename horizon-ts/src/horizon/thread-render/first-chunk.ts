/*
 * The thread screen's first reply chunk (2026-10-26, Prism's round 5: on
 * web, ~70 posts took 650 ms between the answer and the first paint). The
 * web list draws every item it is given, so the first render takes
 * {@link FIRST_CHILDREN_WEB} replies and, once that has painted, a
 * low-priority update brings the count to the stock chunk; scrolling adds
 * chunks as before. Native's list virtualizes, so it starts at the stock
 * chunk as before.
 */

import {startTransition, useEffect, useRef} from 'react'

import {IS_WEB} from '#/env'

/** Replies in the web thread's first render. */
export const FIRST_CHILDREN_WEB = 15

/** The reply count the thread screen starts at. */
export function firstChildrenCount(chunk: number): number {
  return IS_WEB ? Math.min(FIRST_CHILDREN_WEB, chunk) : chunk
}

/**
 * Once the thread's real answer has rendered (`ready`), raise a count still
 * under `chunk` to `chunk`, after the browser has painted and at low
 * priority. Once per screen.
 */
export function useGrowFirstChunk({
  ready,
  count,
  chunk,
  setCount,
}: {
  ready: boolean
  count: number
  chunk: number
  setCount: (update: (count: number) => number) => void
}) {
  const grown = useRef(false)
  useEffect(() => {
    if (grown.current || !ready || count >= chunk) return
    grown.current = true
    let cancelled = false
    const grow = () => {
      if (cancelled) return
      startTransition(() => setCount(n => Math.max(n, chunk)))
    }
    // After the next paint: a frame, then a task.
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => setTimeout(grow, 0))
        : undefined
    if (raf === undefined) setTimeout(grow, 0)
    return () => {
      cancelled = true
      if (raf !== undefined) cancelAnimationFrame(raf)
    }
  }, [ready, count, chunk, setCount])
}
