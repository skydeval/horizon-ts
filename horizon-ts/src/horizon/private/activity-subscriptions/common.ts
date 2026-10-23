/*
 * Shared pieces of activity subscriptions for private posts (activity
 * subscriptions design, "the design"): the feature, the flags and the put's
 * timeout. Imports nothing.
 *
 * Two independent stores hold a member's choices (D-2): Bluesky the public
 * "Posts" and "Replies", prism the private ones. Nothing is copied between
 * them, and nothing is kept on the device.
 */

/** The feature prism lists for this work. */
export const ACTIVITY_FEATURE = 'private.activitySubscriptions' as const

/** A pair of flags, as stock `#activitySubscription`. */
export type Flags = {post: boolean; reply: boolean}

export const OFF: Flags = {post: false, reply: false}

/** How long a saver waits for a store's answer to a put (2.3). */
export const PUT_TIMEOUT_MS = 15_000

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
 * A store's `activitySubscription` as flags: an absent field is off, as the
 * stock dialog reads it.
 */
export function readFlags(value: unknown): Flags {
  if (!value || typeof value !== 'object') return OFF
  const {post, reply} = value as {post?: unknown; reply?: unknown}
  return {post: post === true, reply: reply === true}
}
