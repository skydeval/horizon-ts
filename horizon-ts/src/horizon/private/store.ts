/*
 * Side stores for private posts, keyed by URI, so Horizon facts never widen a
 * Bluesky type and cached views are never mutated.
 *
 * - Post facts: the audience a private post names and whether it is the
 *   author's own just-written (pending) post; whether prism served its
 *   counts, the audience prism serves for it, and a short pin after an
 *   audience change in this client (2H design 5.1, 5.6, 5.7). Written by the
 *   adapter for every private view it builds and by the write path for
 *   pending posts.
 * - Pending posts: the author's own just-written posts, built from the record
 *   as sent, until prism serves them (or for ten minutes).
 *
 * Both live in memory only and are cleared when the account changes.
 */

import {useSyncExternalStore} from 'react'
import {type AtUriString} from '@atproto/syntax'

import {logger} from '#/logger'
import {type PostPrivate} from '#/horizon/lexicons/kryphocron'
import {
  getCurrentDid,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

/**
 * The governing audience prism serves on a private post view (P-3): the
 * thread root's current audience, the branch root's in a branch, the post's
 * own when top-level.
 */
export type ServedAudience = {uri: string; mode?: string; name?: string}

/**
 * Horizon facts about one private post. Every optional field is written
 * only when present.
 */
export type PrivatePostFacts = {
  /** The at-uri of the audience the record names; absent for self-only. */
  audienceUri?: string
  /** The author's own post, written but not yet served by prism. */
  isPending: boolean
  /** prism served the four counts on the post's view (P-2). */
  countsServed?: true
  /** The audience prism serves for the post (P-3). */
  servedAudience?: ServedAudience
  /**
   * The audience this client just moved the post to, until `until` (epoch
   * ms): a served view naming another audience does not undo it (5.7).
   */
  audiencePin?: {uri: string; until: number}
}

/**
 * How long an audience change in this client holds against stale served
 * views (5.7).
 */
export const AUDIENCE_PIN_MS = 60_000

/**
 * The author's own just-written private post.
 */
export type PendingPost = {
  uri: string
  /** The stored record's CID, from `getRecord`. */
  cid: string
  /** The author. Pending posts are served only to this account. */
  did: string
  /** The record exactly as sent. */
  record: PostPrivate
  audienceUri: string
  /** The post as the stock renderers take it. */
  postView: app.bsky.feed.defs.PostView
  /** A feed item with the reply context known at write time, if any. */
  feedItem: app.bsky.feed.defs.FeedViewPost
  createdAt: string
  /** Epoch milliseconds after which the entry is dropped. */
  expiresAt: number
}

/**
 * How long a pending post is kept when prism never confirms it.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000

const facts = new Map<string, PrivatePostFacts>()
const pending = new Map<string, PendingPost>()
const batches = new Map<string, string[]>()
const listeners = new Set<() => void>()

let watchedDid: string | undefined
let watching = false

function notify() {
  listeners.forEach(listener => listener())
}

/*
 * Subscribed on first write rather than at import, so importing this module
 * has no side effect.
 */
function watchAccount() {
  if (watching) return
  watching = true
  watchedDid = getCurrentDid()
  subscribeCurrentClients(() => {
    const next = getCurrentDid()
    if (next !== watchedDid) {
      watchedDid = next
      clearPrivateStores()
    }
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function sameFacts(a: PrivatePostFacts, b: PrivatePostFacts) {
  return (
    a.audienceUri === b.audienceUri &&
    a.isPending === b.isPending &&
    a.countsServed === b.countsServed &&
    a.servedAudience?.uri === b.servedAudience?.uri &&
    a.servedAudience?.mode === b.servedAudience?.mode &&
    a.servedAudience?.name === b.servedAudience?.name &&
    a.audiencePin?.uri === b.audiencePin?.uri &&
    a.audiencePin?.until === b.audiencePin?.until
  )
}

/**
 * `next` with only its present optional fields, so facts without them equal
 * the plain ones.
 */
function compact(next: PrivatePostFacts): PrivatePostFacts {
  const out: PrivatePostFacts = {isPending: next.isPending}
  if (next.audienceUri !== undefined) out.audienceUri = next.audienceUri
  if (next.countsServed) out.countsServed = true
  if (next.servedAudience) out.servedAudience = next.servedAudience
  if (next.audiencePin) out.audiencePin = next.audiencePin
  return out
}

/**
 * Record the facts for a private post (the adapter's facts of a view). While
 * an audience pin is live, the pinned audience stays and the served audience
 * is dropped, unless the view's record names the pinned audience, which
 * clears the pin; an expired pin is dropped.
 */
export function setPrivatePostFacts(uri: string, next: PrivatePostFacts) {
  watchAccount()
  const previous = facts.get(uri)
  let merged = next
  const pin = next.audiencePin ?? previous?.audiencePin
  if (pin && pin.until > Date.now() && next.audienceUri !== pin.uri) {
    merged = {
      ...next,
      audienceUri: pin.uri,
      servedAudience: undefined,
      audiencePin: pin,
    }
  } else {
    merged = {...next, audiencePin: undefined}
  }
  merged = compact(merged)
  if (previous && sameFacts(previous, merged)) return
  facts.set(uri, merged)
  notify()
}

/**
 * Pin `uri`'s audience to `audienceUri` for {@link AUDIENCE_PIN_MS}: the
 * audience the author's own record names, after a move in this client or
 * when the composer finds the record ahead of what prism serves (5.6, 5.7).
 */
export function pinPrivatePostAudience(uri: string, audienceUri: string) {
  watchAccount()
  const previous = facts.get(uri)
  facts.set(
    uri,
    compact({
      ...previous,
      isPending: previous?.isPending ?? false,
      audienceUri,
      servedAudience: undefined,
      audiencePin: {uri: audienceUri, until: Date.now() + AUDIENCE_PIN_MS},
    }),
  )
  notify()
}

export function getPrivatePostFacts(uri: string): PrivatePostFacts | undefined {
  return facts.get(uri)
}

/**
 * The facts for a private post, kept current.
 */
export function usePrivatePostFacts(
  uri: string | undefined,
): PrivatePostFacts | undefined {
  return useSyncExternalStore(subscribe, () =>
    uri ? facts.get(uri) : undefined,
  )
}

function isLive(entry: PendingPost, now: number) {
  if (entry.expiresAt > now) return true
  logger.warn('private post never confirmed by prism; dropping pending entry', {
    uri: entry.uri,
  })
  pending.delete(entry.uri)
  facts.delete(entry.uri)
  return false
}

/**
 * Keep a just-written post until prism serves it.
 */
export function addPendingPost(entry: PendingPost) {
  watchAccount()
  pending.set(entry.uri, entry)
  facts.set(
    entry.uri,
    compact({
      ...facts.get(entry.uri),
      audienceUri: entry.audienceUri,
      isPending: true,
    }),
  )
  notify()
}

/**
 * Record the URIs one `postPrivate` call wrote, keyed by the first.
 */
export function setPendingBatch(uris: string[]) {
  if (uris.length === 0) return
  batches.set(uris[0], uris)
}

/**
 * The current account's pending post at `uri`, if it has not expired.
 */
export function getPendingPost(uri: string): PendingPost | undefined {
  const entry = pending.get(uri)
  if (!entry || entry.did !== getCurrentDid()) return undefined
  return isLive(entry, Date.now()) ? entry : undefined
}

/**
 * The current account's pending posts, newest first.
 */
export function getPendingPosts(): PendingPost[] {
  const did = getCurrentDid()
  const now = Date.now()
  return Array.from(pending.values())
    .filter(entry => entry.did === did && isLive(entry, now))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/**
 * The pending posts written by the `postPrivate` call whose first URI is
 * `firstUri`, in the order written. Entries already confirmed are left out.
 */
export function getPendingBatch(firstUri: string): PendingPost[] {
  const uris = batches.get(firstUri) ?? []
  return uris
    .map(uri => getPendingPost(uri))
    .filter((entry): entry is PendingPost => !!entry)
}

/**
 * Remove a pending post once prism serves it. Its facts stay, no longer
 * pending.
 */
export function confirmPendingPost(uri: string) {
  const entry = pending.get(uri)
  if (!entry) return
  pending.delete(uri)
  facts.set(
    uri,
    compact({
      ...facts.get(uri),
      audienceUri: entry.audienceUri,
      isPending: false,
    }),
  )
  notify()
}

/**
 * A private post's audience changed in place (7.8.1): its facts name the new
 * audience, pinned for {@link AUDIENCE_PIN_MS} against stale served views
 * (2H design 5.7), so every label changes at once and does not flip back,
 * and a pending entry carries the new audience and record CID, so a reply to
 * it names the current version.
 */
export function applyPrivatePostAudience(
  uri: string,
  audienceUri: string,
  cid: string,
) {
  watchAccount()
  const entry = pending.get(uri)
  if (entry) {
    const postView = {...entry.postView, cid}
    pending.set(uri, {
      ...entry,
      cid,
      audienceUri,
      record: {...entry.record, audienceList: audienceUri as AtUriString},
      postView,
      feedItem: {...entry.feedItem, post: postView},
    })
  }
  const previous = facts.get(uri)
  facts.set(
    uri,
    compact({
      ...previous,
      audienceUri,
      isPending: previous?.isPending ?? !!entry,
      servedAudience: undefined,
      audiencePin: {uri: audienceUri, until: Date.now() + AUDIENCE_PIN_MS},
    }),
  )
  notify()
}

/**
 * Forget a private post entirely (after a delete).
 */
export function forgetPrivatePost(uri: string) {
  const hadPending = pending.delete(uri)
  const hadFacts = facts.delete(uri)
  if (hadPending || hadFacts) notify()
}

/**
 * Clear every side store (account change, tests).
 */
export function clearPrivateStores() {
  facts.clear()
  pending.clear()
  batches.clear()
  notify()
}
