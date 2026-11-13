/**
 * Kryphocron labelers: labelers whose labels apply only to kryphocron posts
 * and whose existence is shown only to readers prism lets see them.
 *
 * Horizon never likes or subscribes to one. A like is a public record naming
 * the labeler, and a subscription puts its DID into the
 * `atproto-accept-labelers` header every AppView request carries. Either
 * would make it public. So:
 * - the labeler header hides its like and subscribe buttons,
 * - `useLikeMutation` and `useLabelerSubscriptionMutation` refuse it,
 * - `applyLabelersToClient` drops its DID from the header, in case an older
 *   client or another app subscribed the account to it.
 *
 * prism names them in a ready member's `getMembership` answer
 * (`kryphocronLabelers`). Each account's list is kept in Horizon's device
 * keys, `horizon:kryphocronLabelers:<did>`, so the header leaves them out
 * from the first request after a restart. A member's answer replaces the
 * list (`[]` clears it); an answer without one (any other status) keeps
 * the last, so a labeler once named stays hidden. A DID named for any
 * account on the device counts.
 */

import {useSyncExternalStore} from 'react'

import {
  listLocalKeys,
  readLocal,
  subscribeLocalPrefix,
  writeLocal,
} from '#/horizon/session/local-store'

const PREFIX = 'horizon:kryphocronLabelers:'

let known: Set<string> | undefined
const listeners = new Set<() => void>()
let watching = false

function load(): Set<string> {
  const all = new Set<string>()
  for (const key of listLocalKeys(PREFIX)) {
    for (const did of parse(readLocal(key))) all.add(did)
  }
  return all
}

function parse(value: string | undefined): string[] {
  if (!value) return []
  try {
    const list: unknown = JSON.parse(value)
    return Array.isArray(list) ? list.filter(isDid) : []
  } catch {
    return []
  }
}

function isDid(value: unknown): value is string {
  return typeof value === 'string' && /^did:[a-z]+:\S+$/.test(value)
}

function current(): Set<string> {
  if (!watching) {
    watching = true
    // Another account's answer, or another tab on web
    subscribeLocalPrefix(PREFIX, () => {
      known = load()
      listeners.forEach(listener => listener())
    })
  }
  if (!known) known = load()
  return known
}

/** Whether `did` is a kryphocron labeler. */
export function isKryphocronLabeler(did: string): boolean {
  return current().has(did)
}

/** `dids` without any kryphocron labeler, in order. */
export function withoutKryphocronLabelers<T extends string>(dids: T[]): T[] {
  const set = current()
  return dids.filter(did => !set.has(did))
}

/**
 * Record `account`'s list from one `getMembership` answer. Anything but an
 * array keeps the last list; entries that are not DIDs are dropped.
 */
export function answerKryphocronLabelers(account: string, value: unknown) {
  if (!Array.isArray(value)) return
  const list = value.filter(isDid)
  const key = PREFIX + account
  const next = list.length ? JSON.stringify(list) : undefined
  if (readLocal(key) === next) return
  current()
  writeLocal(key, next)
}

/** Call `listener` whenever the known kryphocron labelers change. */
export function subscribeKryphocronLabelers(listener: () => void) {
  current()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** {@link isKryphocronLabeler}, re-rendering when the list changes. */
export function useIsKryphocronLabeler(did: string): boolean {
  return useSyncExternalStore(subscribeKryphocronLabelers, () =>
    isKryphocronLabeler(did),
  )
}

/** The labeler record a like of `uri` would name, or `undefined`. */
export function likedLabelerDid(uri: string): string | undefined {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.labeler\.service\//.exec(uri)
  return match?.[1]
}

/** Thrown when something tries to like or subscribe to a kryphocron labeler. */
export class KryphocronLabelerError extends Error {
  constructor() {
    super('KRYPHOCRON_LABELER')
    this.name = 'KryphocronLabelerError'
  }
}
