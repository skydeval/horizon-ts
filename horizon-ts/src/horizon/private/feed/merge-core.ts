/*
 * The two-stream merge shared by the Following merge (6.3) and the profile
 * merges (6.3.1): public items and private views, each consumed in its own
 * server order, interleaved by time.
 *
 * One step refills whichever side has an empty buffer (the caller's refills,
 * in parallel), then emits the larger head of the two sides until a side that
 * is not done runs dry, and adapts the private items it emitted. An item
 * leaves a buffer only by being emitted or, for a post's own private item
 * whose URI is in `state.exclude`, dropped; so nothing is lost, repeated or
 * reordered within a side, and a refetch from the top rebuilds the same
 * sequence from the same server pages. The sort keys only interleave the two
 * sides.
 *
 * A private item is a post's own item or a member's repost of it (2H design
 * 6), told apart by `itemKey`, so a post and its reposts in one batch all
 * come out.
 */

import {
  type AdaptInput,
  isOwnItem,
  pendingAsInput,
  repostReasonOf,
} from '#/horizon/private/adapt/feed-view'
import {PrivateDeadlineError} from '#/horizon/private/api/transient'
import {type MergeState} from '#/horizon/private/feed/cursor'
import {type PendingPost} from '#/horizon/private/store'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

export type SortKey = {time: number; uri: string}

function timeOf(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * A public item's key: a repost's time, else the post's `indexedAt`.
 */
export function publicKey(item: app.bsky.feed.defs.FeedViewPost): SortKey {
  const time = bsky.isType(app.bsky.feed.defs.reasonRepost, item.reason)
    ? item.reason.indexedAt
    : item.post.indexedAt
  return {time: timeOf(time), uri: item.post.uri}
}

function repostKey(
  postUri: string,
  reason: {uri?: string; by: {did: string}},
): string {
  return `${postUri}|repost|${reason.uri ?? reason.by.did}`
}

/**
 * A private input's identity: the post URI for the post's own item,
 * `<uri>|repost|<repost uri>` for a repost item (the reposter's DID when the
 * repost URI is absent). A `reason` that is not a repost gets its own key,
 * so it never takes the post's place; the adapter drops it.
 */
export function itemKey(input: AdaptInput): string {
  const uri = input.view.uri
  const reason = repostReasonOf(input.view)
  if (reason) return repostKey(uri, reason)
  return isOwnItem(input.view) ? uri : `${uri}|reason`
}

/**
 * An adapted feed item's identity, as {@link itemKey}.
 */
export function feedItemKey(item: app.bsky.feed.defs.FeedViewPost): string {
  return bsky.isType(app.bsky.feed.defs.reasonRepost, item.reason)
    ? repostKey(item.post.uri, item.reason)
    : item.post.uri
}

/**
 * A private item's key: a repost's `indexedAt`, else its record's
 * `createdAt` (as prism sorts), with `itemKey` breaking ties so a post and
 * its repost at the same instant still order totally.
 */
export function privateKey(input: AdaptInput): SortKey {
  const reason = repostReasonOf(input.view)
  if (reason) return {time: timeOf(reason.indexedAt), uri: itemKey(input)}
  const record = input.view.record as {createdAt?: unknown} | null
  return {time: timeOf(record?.createdAt), uri: itemKey(input)}
}

/**
 * Positive when `a` sorts above (is newer than) `b`.
 */
export function compareKeys(a: SortKey, b: SortKey): number {
  if (a.time !== b.time) return a.time - b.time
  return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0
}

/**
 * `promise`, or a rejection after `ms` with a `PrivateDeadlineError`
 * (transient, prism busy design 3). Only the page stops waiting: nothing is
 * reported, and the call goes on to its own deadline.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PrivateDeadlineError('private feed deadline passed')),
      ms,
    )
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Insert pending posts the buffer does not carry as their own items (a
 * repost item does not count), each above the first item it is newer than.
 */
export function insertPending(buf: AdaptInput[], entries: PendingPost[]) {
  const present = new Set(
    buf.filter(input => isOwnItem(input.view)).map(input => input.view.uri),
  )
  for (const entry of entries) {
    if (present.has(entry.uri)) continue
    const input = pendingAsInput(entry)
    const key = privateKey(input)
    const at = buf.findIndex(other => compareKeys(key, privateKey(other)) > 0)
    if (at === -1) buf.push(input)
    else buf.splice(at, 0, input)
    present.add(entry.uri)
  }
}

/**
 * One merge step over `state` (mutated): refill both sides in parallel, emit,
 * adapt the emitted private items with `adapt`. `drained` is true when both
 * sides are done and empty.
 */
export async function mergeStep(
  state: MergeState,
  {
    refillPublic,
    refillPrivate,
  }: {refillPublic: () => Promise<void>; refillPrivate: () => Promise<void>},
  {
    adapt,
    publicKeyOf = publicKey,
  }: {
    adapt: (inputs: AdaptInput[]) => Promise<app.bsky.feed.defs.FeedViewPost[]>
    publicKeyOf?: (item: app.bsky.feed.defs.FeedViewPost) => SortKey
  },
): Promise<{feed: app.bsky.feed.defs.FeedViewPost[]; drained: boolean}> {
  await Promise.all([refillPublic(), refillPrivate()])

  type Slot =
    | {kind: 'public'; item: app.bsky.feed.defs.FeedViewPost}
    | {kind: 'private'; key: string}
  const slots: Slot[] = []
  const emitted: AdaptInput[] = []
  const {pub, priv} = state
  const exclude = new Set(state.exclude)
  const privDone = () => priv.done || priv.failed
  while (true) {
    const privHead = priv.buf[0]
    if (
      privHead &&
      isOwnItem(privHead.view) &&
      exclude.has(privHead.view.uri)
    ) {
      priv.buf.shift()
      continue
    }
    const pubHead = pub.buf[0]
    if (!pubHead && !pub.done) break
    if (!privHead && !privDone()) break
    if (!pubHead && !privHead) break
    const takePublic =
      !!pubHead &&
      (!privHead ||
        compareKeys(publicKeyOf(pubHead), privateKey(privHead)) >= 0)
    if (takePublic) {
      slots.push({kind: 'public', item: pubHead})
      pub.buf.shift()
    } else {
      slots.push({kind: 'private', key: itemKey(privHead)})
      emitted.push(privHead)
      priv.buf.shift()
    }
  }

  const adapted = emitted.length ? await adapt(emitted) : []
  const byKey = new Map<string, app.bsky.feed.defs.FeedViewPost>(
    adapted.map(item => [feedItemKey(item), item]),
  )
  const feed: app.bsky.feed.defs.FeedViewPost[] = []
  for (const slot of slots) {
    if (slot.kind === 'public') {
      feed.push(slot.item)
    } else {
      const item = byKey.get(slot.key)
      if (item) feed.push(item)
    }
  }

  const drained =
    pub.done && pub.buf.length === 0 && privDone() && priv.buf.length === 0
  return {feed, drained}
}
