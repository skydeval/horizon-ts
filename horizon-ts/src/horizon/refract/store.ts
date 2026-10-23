/*
 * The restored-post store (refract client design 5.6): one per account, in
 * memory, never persisted. It holds the restored `postView`s the batcher
 * returned, keyed by URI, and a separate set of the reader's own replies
 * under restored posts. Every surface renders these objects (the feed
 * overlay, the thread merge, the quote slot), so they keep a stable identity
 * and shadows and placeholders reach them through the finders.
 *
 * - Up to 2,000 posts; only entries not read in the last 10 minutes are
 *   evicted, and every read touches its entry. The own-replies set is never
 *   evicted.
 * - A second answer keeps the existing object unless its counts, viewer,
 *   record, CID or stamp changed; then the new object replaces it.
 * - Visitor form ending marks every `'visitor'` entry stale; a read of a
 *   stale entry returns it and asks the batcher again once (the flag clears
 *   when the ask is queued). A late visitor answer is written stale.
 */

import {stampOf} from '#/horizon/refract/marker'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

export const STORE_MAX = 2_000
export const STORE_KEEP_MS = 10 * 60_000

type Entry = {post: PostView; readAt: number; stale: boolean}

let did: string | undefined
const posts = new Map<string, Entry>()
const ownReplies = new Map<string, PostView>()
const versions = new Map<string, number>()
let globalVersion = 0
const listeners = new Set<() => void>()
let staleReader: ((uri: string) => void) | undefined

function sync() {
  const current = getCurrentDid()
  if (current !== did) {
    did = current
    posts.clear()
    ownReplies.clear()
    versions.clear()
    globalVersion++
  }
}

function bump(uri: string) {
  versions.set(uri, (versions.get(uri) ?? 0) + 1)
  globalVersion++
}

function notify() {
  listeners.forEach(listener => listener())
}

function sameView(a: PostView, b: PostView): boolean {
  return (
    a.cid === b.cid &&
    a.likeCount === b.likeCount &&
    a.repostCount === b.repostCount &&
    a.replyCount === b.replyCount &&
    a.quoteCount === b.quoteCount &&
    stampOf(a) === stampOf(b) &&
    JSON.stringify(a.viewer ?? null) === JSON.stringify(b.viewer ?? null) &&
    JSON.stringify(a.record) === JSON.stringify(b.record)
  )
}

function evict(now: number) {
  if (posts.size <= STORE_MAX) return
  for (const [uri, entry] of posts) {
    if (posts.size <= STORE_MAX) break
    if (now - entry.readAt > STORE_KEEP_MS) {
      posts.delete(uri)
      bump(uri)
    }
  }
}

/**
 * Write a returned post. Returns the object the store holds for its URI
 * (the existing one when nothing that matters changed).
 */
export function putRestoredPost(
  post: PostView,
  {stale = false}: {stale?: boolean} = {},
): PostView {
  sync()
  const now = Date.now()
  const existing = posts.get(post.uri)
  if (existing && sameView(existing.post, post)) {
    if (stale) existing.stale = true
    return existing.post
  }
  posts.set(post.uri, {post, readAt: now, stale})
  bump(post.uri)
  evict(now)
  notify()
  return post
}

/**
 * The stored post for `uri`, touching its entry. A stale entry is returned
 * and asked again once.
 */
export function readRestoredPost(uri: string): PostView | undefined {
  sync()
  const entry = posts.get(uri)
  if (!entry) return undefined
  entry.readAt = Date.now()
  if (entry.stale) {
    entry.stale = false
    staleReader?.(uri)
  }
  return entry.post
}

/** The stored post for `uri` without touching it (the finders). */
export function peekRestoredPost(uri: string): PostView | undefined {
  sync()
  return posts.get(uri)?.post
}

/** Drop a URI (its restore ended, or a definitive "missing"). */
export function dropRestoredPost(uri: string) {
  sync()
  if (posts.delete(uri)) {
    bump(uri)
    notify()
  }
}

/** Drop every post by `author` (its restore ended). */
export function dropRestoredPostsBy(author: string) {
  sync()
  let changed = false
  for (const [uri, entry] of posts) {
    if (entry.post.author.did === author) {
      posts.delete(uri)
      bump(uri)
      changed = true
    }
  }
  if (changed) notify()
}

/** Visitor form ended (9.2): every `'visitor'` entry is stale. */
export function markVisitorEntriesStale() {
  sync()
  for (const entry of posts.values()) {
    if (stampOf(entry.post) === 'visitor') entry.stale = true
  }
}

/** Every entry is stale (the reader's mutes or blocks finished loading). */
export function markAllEntriesStale() {
  sync()
  for (const entry of posts.values()) entry.stale = true
}

/** Record the reader's own reply under a restored post (4.2). */
export function addOwnRestoredReply(post: PostView) {
  sync()
  ownReplies.set(post.uri, post)
  bump(post.uri)
  notify()
}

/** The reader's own replies under restored posts, this session. */
export function ownRestoredReplies(): PostView[] {
  sync()
  return Array.from(ownReplies.values())
}

/**
 * Every stored post, own replies included, whose URI is `uri` or which
 * quotes it (the shadow and placeholder finders, 5.6).
 */
export function* findStoredPosts(uri: string): Generator<PostView, void> {
  sync()
  const entry = posts.get(uri)
  if (entry) yield entry.post
  const own = ownReplies.get(uri)
  if (own) yield own
}

/** Called when the store changes. Returns the unsubscribe function. */
export function subscribeRestoredStore(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A version for a set of URIs, for `useSyncExternalStore`. */
export function restoredStoreVersion(uris: readonly string[]): string {
  sync()
  return uris.map(uri => versions.get(uri) ?? 0).join(',')
}

/** The store's global version. */
export function restoredStoreGlobalVersion(): number {
  sync()
  return globalVersion
}

/** The batcher asks again for a stale entry's URI through this. */
export function setStaleReader(reader: ((uri: string) => void) | undefined) {
  staleReader = reader
}

/** Clear the store (an account switch, a cache clear, tests). */
export function clearRestoredStore() {
  posts.clear()
  ownReplies.clear()
  versions.clear()
  globalVersion++
  did = getCurrentDid()
  notify()
}
