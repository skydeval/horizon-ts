/*
 * The lens timing log (speed pass, 2026-10-23), for measuring: the time
 * from a tap (the press-in, else the screen's mount) to the thread's first
 * paint and to the lens answer, and each step of the read. Written to the
 * console, in development builds or with the device key
 * `horizon:lensTiming` set to `1` (on web:
 * `localStorage.setItem('horizon:lensTiming', '1')`, then reload). Off, it
 * keeps nothing and writes nothing. Lines carry the post's record key only,
 * never a DID or a handle.
 */

import {readLocal} from '#/horizon/session/local-store'

/** The device key that turns the log on outside development builds. */
export const LENS_TIMING_KEY = 'horizon:lensTiming'

/** Whether the log is on. */
export function lensTimingOn(): boolean {
  // Quiet under Jest, which runs as a development build.
  const dev = __DEV__ && process.env.NODE_ENV !== 'test'
  return dev || readLocal(LENS_TIMING_KEY) === '1'
}

/** Milliseconds, monotonic where the platform has it. */
export function lensTimingNow(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** The record key of a post URI, handle or DID form alike. */
function rkeyOf(uri: string): string {
  return uri.split('/').pop() ?? uri
}

/** Taps by record key, kept a short while. */
const taps = new Map<string, number>()
const TAP_KEEP_MS = 30_000

/** Note a press on the post `uri` (the pre-warm's caller). */
export function markLensTap(uri: string) {
  if (!lensTimingOn()) return
  const now = lensTimingNow()
  for (const [key, at] of taps) if (now - at > TAP_KEEP_MS) taps.delete(key)
  taps.set(rkeyOf(uri), now)
}

/**
 * Where a screen on `uri` times from: the press held for it, else `now` (its
 * mount, for a screen opened without a press: a link, a notification).
 */
export function lensTimingStart(uri: string | undefined): {
  at: number
  from: 'tap' | 'screen mount'
} {
  const now = lensTimingNow()
  const tap = uri && lensTimingOn() ? taps.get(rkeyOf(uri)) : undefined
  return tap !== undefined && now - tap < TAP_KEEP_MS
    ? {at: tap, from: 'tap'}
    : {at: now, from: 'screen mount'}
}

/*
 * Through `globalThis` so production builds keep it: their
 * `transform-remove-console` strips only calls on the bare `console`, and
 * this log is for measuring the preview and production builds.
 */
function write(line: string) {
  // eslint-disable-next-line no-console
  globalThis.console.info(`[thread lens timing] ${line}`)
}

/** One step of a read of `anchor`, timed from `since`. */
export function noteLensStep(anchor: string, step: string, since: number) {
  if (!lensTimingOn()) return
  write(`${rkeyOf(anchor)} ${step}: ${Math.round(lensTimingNow() - since)} ms`)
}

/** A screen milestone of `anchor`, timed from its tap or its mount. */
export function noteLensMilestone(
  anchor: string,
  milestone: string,
  start: {at: number; from: 'tap' | 'screen mount'},
) {
  if (!lensTimingOn()) return
  const ms = Math.round(lensTimingNow() - start.at)
  write(`${rkeyOf(anchor)} ${milestone}: ${ms} ms from ${start.from}`)
}
