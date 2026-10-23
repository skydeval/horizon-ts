/*
 * Private replies a thread read does not serve on its own (2H design 9.2,
 * 9.3, P-6, P-14, P-22).
 *
 * - Branches under a public anchor (Thread 1): for a member while prism pages
 *   replies (`private.paging`), the anchor's private replies are read with
 *   `getReplies` beside the stock thread read, and spliced in after the
 *   anchor. Only the anchor's branches are read: those under the anchor's
 *   public replies show when that reply is opened. The read waits at most
 *   {@link BRANCH_DEADLINE_MS}; a failure or the deadline gives the stock
 *   thread alone.
 * - "Other replies" (Thread 4): where the main read stopped in the private
 *   replies of its anchor (a continuation, `continuation.ts`), the stock
 *   "Show more replies" reads on through `getReplies`, beside the stock
 *   other-replies call when that has something too.
 */

import {type QueryClient, type QueryKey} from '@tanstack/react-query'

import {logger} from '#/logger'
import {readReplyRefs} from '#/horizon/private/adapt/feed-view'
import {getPrivateReplies} from '#/horizon/private/api/reads'
import {resyncPublicThreadMute} from '#/horizon/private/api/thread-mute'
import {
  hasDataForPage,
  isTransientPrismError,
  keepError,
} from '#/horizon/private/api/transient'
import {withDeadline} from '#/horizon/private/feed/merge-core'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {hold} from '#/horizon/private/known'
import {privatePagingServed} from '#/horizon/private/server-support'
import {
  clearReplyContinuation,
  getReplyContinuation,
  setReplyContinuation,
} from '#/horizon/private/thread/continuation'
import {
  adaptTree,
  emitPrivateReplies,
  MAX_REPLIES_DEPTH,
  resolveAnchor,
  sortSiblings,
  toTreeNode,
  type TreeNode,
} from '#/horizon/private/thread/fetch'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {healthEnvironment} from '#/horizon/routing/health'
import {isPrivateMember} from '#/horizon/routing/membership'
import {PRIVATE_READING} from '#/horizon/switches'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

/**
 * The query a read runs in (prism busy design 5, 6.1): a transient failure of
 * the private half is rethrown over data the query has, which keeps it, and
 * with none the read goes on without it, held for the lift and the catch-up.
 */
export type RepliesQueryContext = {client: QueryClient; queryKey: QueryKey}

/**
 * The private half's transient failure (`error`) in the query `context`:
 * rethrown, marked kept and held, when the query has data; else held, and
 * the read goes on. A permanent failure, or one outside a query, is left out,
 * as before.
 */
function keepOrHold(context: RepliesQueryContext | undefined, error: unknown) {
  if (!context || !isTransientPrismError(error)) return
  hold(context.queryKey, undefined, context.client)
  if (hasDataForPage(context.client, context)) {
    keepError(error)
    throw error
  }
}

type ThreadOutput = app.bsky.unspecced.getPostThreadV2.$OutputBody
type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem
type OtherOutput = app.bsky.unspecced.getPostThreadOtherV2.$OutputBody
type PostView = app.bsky.feed.defs.PostView

/**
 * How long a public thread waits for its private branches.
 */
export const BRANCH_DEADLINE_MS = 2_000

/**
 * How many `getReplies` pages "Show more replies" reads at most.
 */
export const MAX_OTHER_REPLY_PAGES = 20

const BRANCH_PAGE_LIMIT = 30
const OTHER_PAGE_LIMIT = 50

function timeOf(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(parsed) ? undefined : parsed
}

function itemPost(item: ThreadItem): PostView | undefined {
  return bsky.isType(app.bsky.unspecced.defs.threadItemPost, item.value)
    ? item.value.post
    : undefined
}

/**
 * A stock reply subtree's head time: its record's `createdAt`, else its
 * `indexedAt`; `undefined` for an item that is not a post.
 */
function stockHeadTime(item: ThreadItem): number | undefined {
  const post = itemPost(item)
  if (!post) return undefined
  return (
    timeOf((post.record as {createdAt?: unknown}).createdAt) ??
    timeOf(post.indexedAt)
  )
}

function privateHeadTime(node: TreeNode): number {
  return (
    timeOf((node.input.view.record as {createdAt?: unknown}).createdAt) ?? 0
  )
}

/**
 * The stock replies after the anchor split into top-level subtrees.
 */
function stockSubtrees(replies: ThreadItem[]): ThreadItem[][] {
  const subtrees: ThreadItem[][] = []
  for (const item of replies) {
    if (item.depth <= 1 || subtrees.length === 0) subtrees.push([item])
    else subtrees[subtrees.length - 1].push(item)
  }
  return subtrees
}

/**
 * The top-level subtrees in display order (H-3): for `top` (or no sort)
 * every private subtree first, directly under the anchor, then the stock
 * ones; for `newest` and `oldest` interleaved by their head post's time,
 * ties putting the stock subtree first. A stock subtree whose head is not a
 * post keeps its place among the stock ones.
 */
export function spliceSubtrees(
  stock: ThreadItem[][],
  priv: {time: number; items: ThreadItem[]}[],
  sort: string | undefined,
): ThreadItem[] {
  if (sort !== 'newest' && sort !== 'oldest') {
    return [...priv.flatMap(p => p.items), ...stock.flat()]
  }
  const newest = sort === 'newest'
  const out: ThreadItem[] = []
  let i = 0
  let j = 0
  while (i < stock.length || j < priv.length) {
    if (j >= priv.length) {
      out.push(...stock[i++])
      continue
    }
    if (i >= stock.length) {
      out.push(...priv[j++].items)
      continue
    }
    const stockTime = stockHeadTime(stock[i][0])
    const privTime = priv[j].time
    const privateFirst =
      stockTime !== undefined &&
      (newest ? privTime > stockTime : privTime < stockTime)
    if (privateFirst) out.push(...priv[j++].items)
    else out.push(...stock[i++])
  }
  return out
}

/**
 * The stock answer for a public anchor with the anchor's private branches
 * spliced in after it (Thread 1). `fetchStock` is the stock call; it alone
 * runs, with no prism request, for a signed-out reader, a non-member, while
 * `PRIVATE_READING` is off, or while prism does not page replies. Throws as
 * `fetchStock` does, and, in a query that has data, on the private half's
 * transient failure, so the query keeps its data, its branches included
 * (prism busy design 5, 6.1); with none, that failure gives the stock thread
 * alone, held. A permanent failure leaves the branches out, as before.
 */
export async function withPrivateBranches(
  anchor: string,
  {
    below,
    branchingFactor,
    sort,
  }: {below: number; branchingFactor?: number; sort?: string},
  fetchStock: () => Promise<ThreadOutput>,
  context?: RepliesQueryContext,
): Promise<ThreadOutput> {
  const clients = PRIVATE_READING ? getCurrentClients() : undefined
  if (!clients || !isPrivateMember(clients.did) || !privatePagingServed()) {
    return fetchStock()
  }
  const depth = Math.max(0, Math.min(below - 1, MAX_REPLIES_DEPTH))
  const privatePart = withDeadline(
    (async () => {
      const anchorUri = await resolveAnchor(clients.appviewClient, anchor)
      const loaded = await fetchUntilItems<unknown>(async cursor => {
        const page = await getPrivateReplies(clients.prismClient, {
          uri: anchorUri,
          limit: BRANCH_PAGE_LIMIT,
          depth,
          cursor,
        })
        return {items: page.replies, cursor: page.cursor}
      }, undefined)
      return {anchorUri, ...loaded}
    })(),
    BRANCH_DEADLINE_MS,
  ).catch((error: unknown) => {
    logger.warn('private branches unavailable', {safeMessage: error})
    return {failed: error}
  })
  const [stock, part] = await Promise.all([fetchStock(), privatePart])
  if ('failed' in part) keepOrHold(context, part.failed)
  const found = 'failed' in part ? undefined : part

  const nodes = (found?.items ?? [])
    .map(toTreeNode)
    .filter((node): node is TreeNode => !!node)
  if (!found || nodes.length === 0) {
    clearReplyContinuation(anchor)
    return stock
  }

  const anchorAt = stock.thread.findIndex(item => item.depth === 0)
  const head = stock.thread.slice(0, anchorAt + 1)
  const replies = stock.thread.slice(anchorAt + 1)
  const cids = new Map<string, string>()
  for (const item of stock.thread) {
    const post = itemPost(item)
    if (post) cids.set(post.uri, post.cid)
  }
  const views = await adaptTree(nodes, clients.appviewClient, uri =>
    cids.get(uri),
  )

  const priv = sortSiblings(nodes, sort).map(node => ({
    time: privateHeadTime(node),
    items: emitPrivateReplies([node], 1, {sort, branchingFactor, views}),
  }))
  const thread = [
    ...head,
    ...spliceSubtrees(stockSubtrees(replies), priv, sort),
  ]

  /*
   * Bluesky's mute state of the root, on the stock anchor, against prism's,
   * on a private reply under that root: prism follows Bluesky (H-5).
   */
  const anchorPost =
    anchorAt >= 0 ? itemPost(stock.thread[anchorAt]) : undefined
  if (anchorPost) {
    const rootUri =
      (anchorPost.record as {reply?: {root?: {uri?: unknown}}}).reply?.root
        ?.uri ?? anchorPost.uri
    const underRoot = nodes.find(
      node => readReplyRefs(node.input.view.record)?.root.uri === rootUri,
    )
    const prismMuted = underRoot
      ? views.get(underRoot.input.view.uri)?.viewer?.threadMuted
      : undefined
    if (typeof rootUri === 'string') {
      resyncPublicThreadMute(
        rootUri,
        anchorPost.viewer?.threadMuted,
        prismMuted,
      )
    }
  }

  if (found.cursor) {
    setReplyContinuation(anchor, {
      kind: 'public',
      anchorUri: found.anchorUri,
      cursor: found.cursor,
      depth,
      sort,
      branchingFactor,
      seen: new Set(nodes.map(node => node.input.view.uri)),
      cids,
      stockHasOther: !!stock.hasOtherReplies,
    })
  } else {
    clearReplyContinuation(anchor)
  }
  return {
    ...stock,
    thread,
    hasOtherReplies: !!found.cursor || !!stock.hasOtherReplies,
  }
}

/**
 * The other-replies answer for `anchor` (Thread 4): `fetchStockOther` alone
 * without a continuation; else the stock part (only when it has something,
 * a failure giving none) and the private replies past the continuation's
 * cursor, page after page up to {@link MAX_OTHER_REPLY_PAGES}, the direct
 * replies already shown left out.
 *
 * The answer carries its own completion stamp, `horizonFetchedAt`, which the
 * load gate judges apart from the thread's (prism busy design 6.1, BR13-L3).
 * In a query that has data, the private half's transient failure is rethrown,
 * so the query keeps its data, the reader's own replies included; with none
 * (a first tap in an outage) the stock part and the private pages read before
 * the failure are returned, and the query is held for the lift and the
 * catch-up (BR14-L3).
 */
export async function fetchOtherReplies(
  anchor: string,
  fetchStockOther: () => Promise<OtherOutput>,
  context?: RepliesQueryContext,
): Promise<OtherOutput & {horizonFetchedAt?: number}> {
  const continuation = PRIVATE_READING
    ? getReplyContinuation(anchor)
    : undefined
  const clients = getCurrentClients()
  if (!continuation || !clients) return fetchStockOther()

  const stockPart: Promise<OtherOutput> = continuation.stockHasOther
    ? fetchStockOther().catch((error: unknown) => {
        logger.warn('other replies unavailable', {safeMessage: error})
        return {thread: []}
      })
    : Promise.resolve({thread: []})

  const readPrivate = async () => {
    const nodes: TreeNode[] = []
    const seen = new Set(continuation.seen)
    let cursor = continuation.cursor
    let pages = 0
    try {
      do {
        const asked: string | undefined = cursor
        const page = await getPrivateReplies(clients.prismClient, {
          uri: continuation.anchorUri,
          limit: OTHER_PAGE_LIMIT,
          depth: continuation.depth,
          cursor: asked,
        })
        pages++
        for (const raw of page.replies) {
          const node = toTreeNode(raw)
          if (!node || seen.has(node.input.view.uri)) continue
          seen.add(node.input.view.uri)
          nodes.push(node)
        }
        cursor = page.cursor && page.cursor !== asked ? page.cursor : undefined
      } while (cursor && pages < MAX_OTHER_REPLY_PAGES)
      if (cursor) {
        logger.warn('other replies: page cap reached', {pages})
      }
    } catch (error) {
      logger.warn('other private replies unavailable', {safeMessage: error})
      keepOrHold(context, error)
    }
    if (nodes.length === 0) return []
    const views = await adaptTree(nodes, clients.appviewClient, uri =>
      continuation.cids.get(uri),
    )
    return emitPrivateReplies(nodes, 1, {
      sort: continuation.sort,
      branchingFactor: continuation.branchingFactor,
      views,
    })
  }

  const [stock, privateItems] = await Promise.all([stockPart, readPrivate()])
  /*
   * The two outputs' items differ only in their optional `$type` name; the
   * private items carry none.
   */
  const asOther = privateItems as unknown as OtherOutput['thread']
  return {
    thread: [...stock.thread, ...asOther],
    horizonFetchedAt: healthEnvironment().now(),
  }
}
