/*
 * Shared pieces of activity subscriptions for private posts (activity
 * subscriptions design, "the design"): the flags, the times and the device
 * keys. Imports nothing, so the device store stays light; the membership
 * checks are in `checks.ts`.
 *
 * Bluesky is the only record of the member's choice; prism is a mirror that
 * Horizon levels to Bluesky (1.2). The device keeps no choice, only the
 * subjects whose prism copy may still need levelling (the dirty set, 2.2).
 */

/** The feature prism lists for this work. */
export const ACTIVITY_FEATURE = 'private.activitySubscriptions' as const

/** A bell's flags, as stock `#activitySubscription`. */
export type Flags = {post: boolean; reply: boolean}

export const OFF: Flags = {post: false, reply: false}

/**
 * G, the grace window (2.2, 2.3): how long a put this tab sent is trusted
 * without reading Bluesky back, and the reconcile's cut-off behind prism's
 * clock.
 */
export const GRACE_MS = 5 * 60_000

/**
 * How long after the host mounts a key present at mount may be levelled
 * (2.2). L-22 measures Bluesky's read-back lag; raise this if it is longer.
 */
export const MOUNT_DELAY_MS = 20_000

/** How long the saver waits for Bluesky's answer to a put (2.1). */
export const PUT_TIMEOUT_MS = 15_000

/** The mirror's retry sequence after a transient failure, once per press. */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
]

/** A reconcile is due when the last complete one is older than this. */
export const RECONCILE_INTERVAL_MS = 60 * 60_000

export const DIRTY_PREFIX = 'horizon-activity-subs-dirty:'
export const RECONCILED_PREFIX = 'horizon-activity-subs-reconciled:'

export function dirtyKey(did: string, subject: string): string {
  return `${DIRTY_PREFIX}${did}:${subject}`
}

export function reconciledKey(did: string): string {
  return `${RECONCILED_PREFIX}${did}`
}

/**
 * The account and subject of a dirty key, or `undefined`. Both are DIDs
 * (`did:<method>:<id>`, the id never holding `:did:`), so the subject starts
 * at the second `did:`.
 */
export function parseDirtyKey(
  key: string,
): {did: string; subject: string} | undefined {
  if (!key.startsWith(DIRTY_PREFIX)) return undefined
  const rest = key.slice(DIRTY_PREFIX.length)
  const split = rest.indexOf(':did:', 4)
  if (!rest.startsWith('did:') || split < 0) return undefined
  return {did: rest.slice(0, split), subject: rest.slice(split + 1)}
}

/** The account of a reconciled key, or `undefined`. */
export function parseReconciledKey(key: string): string | undefined {
  if (!key.startsWith(RECONCILED_PREFIX)) return undefined
  const did = key.slice(RECONCILED_PREFIX.length)
  return did.startsWith('did:') ? did : undefined
}

/** One in-memory key per (account, subject). */
export function pairKey(did: string, subject: string): string {
  return `${did} ${subject}`
}

export function sameFlags(a: Flags, b: Flags): boolean {
  return a.post === b.post && a.reply === b.reply
}

export function isOn(flags: Flags): boolean {
  return flags.post || flags.reply
}

/**
 * Bluesky's `viewer.activitySubscription` as flags: an absent field is off,
 * as the stock dialog reads it.
 */
export function readFlags(value: unknown): Flags {
  if (!value || typeof value !== 'object') return OFF
  const {post, reply} = value as {post?: unknown; reply?: unknown}
  return {post: post === true, reply: reply === true}
}

/** Milliseconds from a clock that never goes back (G and the delays). */
export function monotonicNow(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now()
  }
  return Date.now()
}

/** An opaque random token: the dirty key's whole value. */
export function newToken(): string {
  let out = ''
  for (let i = 0; i < 4; i++) {
    out += Math.floor(Math.random() * 0x100000000)
      .toString(36)
      .padStart(7, '0')
  }
  return out
}
