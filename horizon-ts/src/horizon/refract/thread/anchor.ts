/*
 * A thread anchored on a restored post, on the stock path (refract client
 * design 4.2 step 1, RF-B5a). `withRestoredAnchor` wraps the stock
 * `getPostThreadV2` inside the thread query; with Thread Lens active the
 * lens answers instead and this is never reached (Thread Lens 5.1).
 *
 * - An anchor whose author is noted restored asks `refract.getPostThread`
 *   together with stock; otherwise prism is asked only when stock throws
 *   `NotFound` or answers the anchor as `threadItemNotFound`.
 * - prism's v1 `threadViewPost` is flattened to v2 items with Horizon's
 *   `below`, branching factor and sort, so the cache mutator, shadows and
 *   placeholders work on it as on any thread.
 * - `getPostThread` never starts discovery, so when it answers `NotFound` for
 *   an author not yet classified, one `fill` follows (holding the loading
 *   state through the 2, 5 and 10 s re-asks); a returned post retries
 *   `getPostThread` once. An author still pending, unresolved or omitted
 *   non-definitively, or a transient failure for a noted author, throws
 *   {@link RestoredThreadUnavailableError}, which `ThreadError` titles
 *   "Error loading post" with Retry, never "Post not found". A definitive
 *   answer keeps the stock result.
 */

import {XrpcResponseError} from '@atproto/lex'
import {type AtUriString} from '@atproto/syntax'

import {postItem} from '#/horizon/private/thread/fetch'
import {authorOfUri} from '#/horizon/refract/answer'
import {
  classifyRefractError,
  refractCall,
  RefractClearedError,
} from '#/horizon/refract/api'
import {
  isDefinitelyNotRestored,
  refractRetry,
  waitOnSchedule,
} from '#/horizon/refract/fill'
import {refractActive} from '#/horizon/refract/gate'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {isNotedRestored} from '#/horizon/refract/marker'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type ThreadOutput = app.bsky.unspecced.getPostThreadV2.$OutputBody
type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem
type PostView = app.bsky.feed.defs.PostView

/** The thread options the anchor is flattened with. */
export type AnchorOptions = {
  below: number
  /** Replies kept per node below the first level (none: all). */
  branchingFactor?: number
  sort?: string
}

/** How far up prism is asked to walk (4.2). */
export const RESTORED_PARENT_HEIGHT = 80

/**
 * prism couldn't serve a restored anchor for now. Its message never starts
 * with "Post not found", so `ThreadError` shows its generic text.
 */
export class RestoredThreadUnavailableError extends Error {
  readonly author: string
  constructor(author: string) {
    super('Restored thread unavailable for now')
    this.name = 'RestoredThreadUnavailableError'
    this.author = author
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const THREAD_VIEW = 'app.bsky.feed.defs#threadViewPost'
const BLOCKED = 'app.bsky.feed.defs#blockedPost'

function isThreadView(
  node: unknown,
): node is {post: PostView; parent?: unknown; replies?: unknown[]} {
  return (
    isObject(node) &&
    (node.$type === THREAD_VIEW || node.$type === undefined) &&
    isObject(node.post) &&
    typeof node.post.uri === 'string'
  )
}

function createdAt(post: PostView): number {
  const value = (post.record as {createdAt?: unknown} | undefined)?.createdAt
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Siblings in the order `sort` asks for: newest or oldest first by time;
 * any ranked sort by like count, then time (4.2, "Siblings").
 */
export function orderSiblings<T>(
  nodes: T[],
  postOf: (node: T) => PostView,
  sort: string | undefined,
): T[] {
  return [...nodes].sort((a, b) => {
    const pa = postOf(a)
    const pb = postOf(b)
    if (sort === 'newest') return createdAt(pb) - createdAt(pa)
    if (sort === 'oldest') return createdAt(pa) - createdAt(pb)
    const likes = (pb.likeCount ?? 0) - (pa.likeCount ?? 0)
    return likes !== 0 ? likes : createdAt(pa) - createdAt(pb)
  })
}

function nodeItem(node: unknown, uri: string, depth: number): ThreadItem {
  if (isObject(node) && node.$type === BLOCKED) {
    return {
      uri: uri as AtUriString,
      depth,
      value: {
        $type: 'app.bsky.unspecced.defs#threadItemBlocked',
        author: (node.author ?? {did: ''}) as never,
      },
    }
  }
  return {
    uri: uri as AtUriString,
    depth,
    value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'},
  }
}

/**
 * Flatten prism's v1 thread to v2 items: parents top first at negative
 * depths, the anchor at 0, replies depth first under it. Past `below`, or
 * past the branching factor below the first level, replies are counted into
 * their parent's `moreReplies`, as stock does.
 */
export function flattenRestoredThread(
  thread: unknown,
  {below, branchingFactor, sort}: AnchorOptions,
): ThreadItem[] {
  if (!isThreadView(thread)) return []
  const parents: ThreadItem[] = []
  let parent: unknown = thread.parent
  let depth = -1
  while (parent !== undefined && depth >= -RESTORED_PARENT_HEIGHT) {
    if (isThreadView(parent)) {
      parents.unshift(postItem(parent.post, depth, {}))
      parent = parent.parent
    } else {
      const uri = isObject(parent) ? (parent.uri as string | undefined) : ''
      if (uri) parents.unshift(nodeItem(parent, uri, depth))
      break
    }
    depth--
  }
  if (parents.length > 0 && parents[0].value.$type.endsWith('threadItemPost')) {
    const top = parents[0].value as {moreParents?: boolean}
    top.moreParents = !!(
      isThreadView(thread) &&
      (thread.post.record as {reply?: unknown})?.reply &&
      parents.length >= RESTORED_PARENT_HEIGHT
    )
  }
  const items: ThreadItem[] = [...parents]
  const walk = (node: {post: PostView; replies?: unknown[]}, at: number) => {
    const replies = (node.replies ?? []).filter(
      reply => isThreadView(reply) || isObject(reply),
    )
    const views = orderSiblings(
      replies.filter(isThreadView),
      reply => reply.post,
      sort,
    )
    const limit = at === 0 ? Infinity : (branchingFactor ?? Infinity)
    const shown = at + 1 > below ? [] : views.slice(0, limit)
    const more = views.length - shown.length
    items.push(postItem(node.post, at, {moreReplies: more}))
    for (const reply of shown) walk(reply, at + 1)
  }
  walk(thread, 0)
  return items
}

function anchorItemIsPost(data: ThreadOutput, anchor: string): boolean {
  const item = data.thread.find(entry => entry.uri === anchor)
  return item?.value.$type === 'app.bsky.unspecced.defs#threadItemPost'
}

function isStockNotFound(error: unknown): boolean {
  return (
    error instanceof XrpcResponseError &&
    (error.error === 'NotFound' || error.status === 404)
  )
}

/** Ask prism for the restored anchor; `undefined` when it isn't served. */
async function restoredThread(
  anchor: string,
  options: AnchorOptions,
): Promise<ThreadOutput | undefined> {
  const answer = await refractCall<{thread?: unknown}>(
    REFRACT_METHODS.getPostThread,
    {uri: anchor, depth: options.below, parentHeight: RESTORED_PARENT_HEIGHT},
    {foreground: true},
  )
  // A `notFoundPost` or `blockedPost` anchor isn't served: stock stays.
  if (!isThreadView(answer.body.thread)) return undefined
  const items = flattenRestoredThread(answer.body.thread, options)
  if (items.length === 0) return undefined
  return {thread: items, hasOtherReplies: false}
}

function threadMounted(anchor: string): () => boolean {
  return () =>
    !!getCurrentClients()
      ?.queryClient?.getQueryCache()
      .findAll({queryKey: ['post-thread-v2']})
      .some(
        query =>
          (query.queryKey[1] as {anchor?: string} | undefined)?.anchor ===
            anchor && query.getObserversCount() > 0,
      )
}

/**
 * The cold anchor: one `fill` (through the author's schedule, holding the
 * loading state), then one more `getPostThread` for a returned post.
 */
async function coldAnchor(
  anchor: string,
  author: string,
  options: AnchorOptions,
  stock: ThreadOutput | undefined,
  stockError: unknown,
): Promise<ThreadOutput> {
  const keep = () => {
    if (stock) return stock
    throw stockError
  }
  let result
  try {
    result = await waitOnSchedule(author, {
      kind: 'anchor',
      uris: [anchor],
      // The run waits through its hold; later re-asks only while on screen.
      live: () => true,
      late: {
        live: threadMounted(anchor),
        onAnswer: verdict => {
          if (verdict.kind === 'positive') {
            void getCurrentClients()?.queryClient?.invalidateQueries({
              predicate: query =>
                query.queryKey[0] === 'post-thread-v2' &&
                (query.queryKey[1] as {anchor?: string} | undefined)?.anchor ===
                  anchor,
            })
          }
        },
      },
    })
  } catch (error) {
    if (error instanceof RefractClearedError && !refractActive()) return keep()
    throw new RestoredThreadUnavailableError(author)
  }
  if (result.kind === 'definitive') return keep()
  if (result.kind === 'unavailable') {
    throw new RestoredThreadUnavailableError(author)
  }
  try {
    const restored = await restoredThread(anchor, options)
    if (restored) return restored
  } catch (error) {
    if (classifyRefractError(error) !== 'not-found') {
      throw new RestoredThreadUnavailableError(author)
    }
  }
  return keep()
}

/**
 * The stock thread, or a restored anchor's thread from prism (4.2 step 1).
 */
export async function withRestoredAnchor(
  anchor: string,
  options: AnchorOptions,
  stock: () => Promise<ThreadOutput>,
): Promise<ThreadOutput> {
  const author = authorOfUri(anchor)
  if (!author || !refractActive()) return stock()

  if (isNotedRestored(author)) {
    const prism = restoredThread(anchor, options).then(
      data => ({data}),
      (error: unknown) => ({error}),
    )
    let stockData: ThreadOutput | undefined
    let stockError: unknown
    try {
      stockData = await stock()
      if (anchorItemIsPost(stockData, anchor)) return stockData
    } catch (error) {
      stockError = error
    }
    const answer = await prism
    if ('data' in answer && answer.data) return answer.data
    if ('error' in answer) {
      const kind = classifyRefractError(answer.error)
      if (kind !== 'not-found' && kind !== 'cleared') {
        throw new RestoredThreadUnavailableError(author)
      }
    }
    if (stockData) return stockData
    throw stockError
  }

  let stockData: ThreadOutput | undefined
  let stockError: unknown
  try {
    stockData = await stock()
    if (anchorItemIsPost(stockData, anchor)) return stockData
  } catch (error) {
    if (!isStockNotFound(error)) throw error
    stockError = error
  }
  if (isDefinitelyNotRestored(author)) {
    if (stockData) return stockData
    throw stockError
  }
  try {
    const restored = await restoredThread(anchor, options)
    if (restored) return restored
  } catch (error) {
    if (classifyRefractError(error) !== 'not-found') {
      // A transient failure of a fallback already started.
      throw new RestoredThreadUnavailableError(author)
    }
  }
  // `getPostThread` starts no discovery: the author's fill decides.
  return coldAnchor(anchor, author, options, stockData, stockError)
}

/**
 * `ThreadError`'s Try again: a restored anchor's author gets a new ask
 * (`refractRetry`) before the refetch (4.2).
 */
export function refractThreadRetry(
  error: unknown,
  refetch: () => unknown,
): () => void {
  return () => {
    if (error instanceof RestoredThreadUnavailableError) {
      refractRetry(error.author)
    }
    void refetch()
  }
}
