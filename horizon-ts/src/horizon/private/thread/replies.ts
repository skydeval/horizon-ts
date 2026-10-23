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
 * - Hidden replies (hidden replies design 4.3, 5.3, 6.3): the gate's private
 *   URIs the thread did not serve, read from the background prefetch
 *   (`thread/hidden.ts`) and shown after the paged ones. On a public anchor
 *   they need only a member, not `private.paging`.
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
import {fetchStamp} from '#/horizon/private/load-gate'
import {privatePagingServed} from '#/horizon/private/server-support'
import {
  clearReplyContinuation,
  continuationKey,
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
import {type Stamped} from '#/horizon/private/thread/gate'
import {
  answerHasHidden,
  cachedHiddenAnswer,
  type ContinuationKeyed,
  ensureHidden,
  hiddenCandidates,
  hiddenPrefetchAllowed,
  prefetchHiddenReplies,
  threadgateHiddenReplies,
} from '#/horizon/private/thread/hidden'
import {isPrivateRead} from '#/horizon/private/uri'
import {
  type CurrentClients,
  getCurrentClients,
} from '#/horizon/routing/current-clients'
import {healthEnvironment, isPrismConfirmed} from '#/horizon/routing/health'
import {isPrivateMember} from '#/horizon/routing/membership'
import {PRIVATE_READING} from '#/horizon/switches'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

/**
 * The query a read runs in (prism busy design 5, 6.1): a transient failure of
 * the private half is rethrown over data the query has, which keeps it, and
 * with none the read goes on without it, held for the lift and the catch-up.
 */
export type RepliesQueryContext = {
  client: QueryClient
  queryKey: QueryKey
  /** The query's signal: a paging read stops once it aborts (HR4-L2). */
  signal?: AbortSignal
}

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

/** The `getReplies` depth for a thread read `below` levels deep. */
function branchDepth(below: number): number {
  return Math.max(0, Math.min(below - 1, MAX_REPLIES_DEPTH))
}

/** The branch page read: its anchor, items and cursor, or its failure. */
type BranchPage =
  {anchorUri: string; items: unknown[]; cursor?: string} | {failed: unknown}

/**
 * The anchor's private replies, paged until some come, within
 * {@link BRANCH_DEADLINE_MS}. Never rejects: a failure or the deadline is
 * `{failed}`.
 */
function readBranchPage(
  clients: CurrentClients,
  anchor: string,
  depth: number,
): Promise<BranchPage> {
  return withDeadline(
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
}

/**
 * Bluesky's mute state of the root, on the public anchor, against prism's,
 * on a private reply under that root: prism follows Bluesky (H-5).
 */
function resyncBranchMute(
  anchorPost: PostView,
  nodes: TreeNode[],
  views: Map<string, PostView>,
) {
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
    resyncPublicThreadMute(rootUri, anchorPost.viewer?.threadMuted, prismMuted)
  }
}

/** The private branches of a public anchor, adapted (Thread Lens 5.5). */
export type PrivateBranches = {
  /** The anchor with a DID authority, as `getReplies` was asked. */
  anchorUri: string
  nodes: TreeNode[]
  views: Map<string, PostView>
  /** Where the branch read stopped, for the continuation. */
  cursor?: string
  /** The `getReplies` depth the read used. */
  depth: number
}

/**
 * Where a lens read's public views come from (Thread Lens 5.5): each held
 * view's `cid`, for reply refs without one, and the anchor's public view,
 * for the thread-mute re-sync. `undefined` when the public-view pass failed
 * or turned the anchor into a gap, which discards the branches.
 */
export type BranchPublicViews =
  | {cidOf: (uri: string) => string | undefined; anchorPost?: PostView}
  | undefined

/**
 * The private half of {@link withPrivateBranches} for a caller that reads
 * the public thread elsewhere (Thread Lens 5.5): for a member, while
 * `PRIVATE_READING` is on and prism pages replies, the anchor's private
 * replies are read at once with the stock deadline; once both they and
 * `cidOf` have answered, the replies are adapted with its cids and the
 * thread mute is re-synced when `resyncMute()` says so, asked just before.
 * `undefined` when there is nothing to read, or when `cidOf` gives
 * nothing; `{failed}` on the page read's failure. Never rejects for the
 * page read; rejects only if `cidOf` does.
 */
export async function readPrivateBranches(
  anchor: string,
  {
    below,
    cidOf,
    resyncMute,
  }: {
    below: number
    cidOf: () => Promise<BranchPublicViews>
    resyncMute: () => boolean
  },
): Promise<PrivateBranches | {failed: unknown} | undefined> {
  const clients = PRIVATE_READING ? getCurrentClients() : undefined
  if (!clients || !isPrivateMember(clients.did) || !privatePagingServed()) {
    return undefined
  }
  const depth = branchDepth(below)
  const page = readBranchPage(clients, anchor, depth)
  const [part, held] = await Promise.all([page, cidOf()])
  if ('failed' in part) return part
  if (!held) return undefined
  const nodes = part.items
    .map(toTreeNode)
    .filter((node): node is TreeNode => !!node)
  const views =
    nodes.length > 0
      ? await adaptTree(nodes, clients.appviewClient, held.cidOf)
      : new Map<string, PostView>()
  if (nodes.length > 0 && held.anchorPost && resyncMute()) {
    resyncBranchMute(held.anchorPost, nodes, views)
  }
  return {anchorUri: part.anchorUri, nodes, views, cursor: part.cursor, depth}
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
): Promise<ThreadOutput & ContinuationKeyed> {
  const clients = PRIVATE_READING ? getCurrentClients() : undefined
  if (!clients || !isPrivateMember(clients.did)) return fetchStock()
  // The hidden prefetch's start test, taken when the read starts (6.2).
  const prefetchAllowed = hiddenPrefetchAllowed(clients.did, anchor)
  const depth = branchDepth(below)
  /*
   * The branch read only while prism pages replies; the hidden part (hidden
   * replies design 5.3) needs only a member and `PRIVATE_READING`.
   */
  const privatePart = privatePagingServed()
    ? readBranchPage(clients, anchor, depth)
    : Promise.resolve(undefined)
  const [stock, part] = await Promise.all([fetchStock(), privatePart])
  if (part && 'failed' in part) keepOrHold(context, part.failed)
  const found = part && !('failed' in part) ? part : undefined

  const nodes = (found?.items ?? [])
    .map(toTreeNode)
    .filter((node): node is TreeNode => !!node)

  const anchorAt = stock.thread.findIndex(item => item.depth === 0)
  const anchorPost =
    anchorAt >= 0 ? itemPost(stock.thread[anchorAt]) : undefined
  const cids = new Map<string, string>()
  for (const item of stock.thread) {
    const post = itemPost(item)
    if (post) cids.set(post.uri, post.cid)
  }

  let thread = stock.thread
  if (nodes.length > 0) {
    const head = stock.thread.slice(0, anchorAt + 1)
    const replies = stock.thread.slice(anchorAt + 1)
    const views = await adaptTree(nodes, clients.appviewClient, uri =>
      cids.get(uri),
    )

    const priv = sortSiblings(nodes, sort).map(node => ({
      time: privateHeadTime(node),
      items: emitPrivateReplies([node], 1, {sort, branchingFactor, views}),
    }))
    thread = [...head, ...spliceSubtrees(stockSubtrees(replies), priv, sort)]

    if (anchorPost) resyncBranchMute(anchorPost, nodes, views)
  }

  /*
   * Hidden private replies (5.3): the private URIs Bluesky's gate of the
   * thread lists that the merged thread (branches included) does not hold.
   * While prism serves one in the branch read it is in the thread, and the
   * stock blur moves it under the row; once prism leaves it out it is a
   * candidate, prefetched, and added by the tap. A branch claiming another
   * root escapes this root's hide on prism (its `getReplies` judges each
   * reply by the root it claims), so it is served, and the stock blur hides
   * it here from this root's gate.
   */
  const anchorUri = found?.anchorUri ?? anchorPost?.uri
  const candidates = anchorUri
    ? hiddenCandidates(
        threadgateHiddenReplies(stock.threadgate),
        thread,
        clients.did,
      )
    : []
  const pages = !!found?.cursor
  const cached = cachedHiddenAnswer(
    context?.client,
    clients.did,
    anchor,
    candidates,
  )
  const hasHidden =
    candidates.length > 0 && (cached ? answerHasHidden(cached) : true)

  let key = ''
  if (anchorUri && (pages || candidates.length > 0)) {
    key = continuationKey({kind: 'public', pages, hidden: candidates})
    setReplyContinuation(anchor, {
      kind: 'public',
      anchorUri,
      cursor: found?.cursor,
      depth,
      sort,
      branchingFactor,
      seen: new Set(nodes.map(node => node.input.view.uri)),
      cids,
      stockHasOther: !!stock.hasOtherReplies,
      key,
      hidden: candidates,
      pages,
      readAt: fetchStamp(),
    })
  } else {
    clearReplyContinuation(anchor)
  }

  // The prefetch, on a confirmed read only (6.2), not awaited.
  if (
    context &&
    anchorUri &&
    candidates.length > 0 &&
    prefetchAllowed &&
    isPrismConfirmed(clients.did)
  ) {
    prefetchHiddenReplies({
      client: context.client,
      threadKey: context.queryKey,
      clients,
      did: clients.did,
      anchor,
      anchorUri,
      candidates,
      cidOf: uri => cids.get(uri),
      unserved: undefined,
    })
  }

  // Nothing private to add: the stock answer as it came.
  if (nodes.length === 0 && !key) return stock
  return {
    ...stock,
    thread,
    hasOtherReplies: pages || !!stock.hasOtherReplies || hasHidden,
    horizonContinuation: key,
  }
}

/**
 * The other-replies answer for `anchor` (Thread 4): `fetchStockOther` alone
 * without a continuation (a private anchor never asks it: the query's data,
 * else nothing); else the stock part (only when it has something, a failure
 * giving none), the private replies past the continuation's cursor while it
 * pages, page after page up to {@link MAX_OTHER_REPLY_PAGES} or until the
 * query's signal aborts, then the hidden replies (hidden replies design 4.3,
 * 6.3), each reply once and the direct replies already shown left out. It
 * carries the key of the continuation it read from (`horizonContinuation`).
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
): Promise<OtherOutput & {horizonFetchedAt?: number} & ContinuationKeyed> {
  // Taken at the start, as the continuation itself is (hidden replies 4.2).
  const continuation = PRIVATE_READING
    ? getReplyContinuation(anchor)
    : undefined
  const clients = getCurrentClients()
  if (!continuation || !clients) {
    /*
     * A private anchor with no continuation (4.3): never Bluesky's AppView,
     * which would be asked for a private URI. The query's data stays when it
     * has some, so the replies on screen are not replaced with nothing.
     */
    if (isPrivateRead(anchor)) {
      const data = context?.client.getQueryData<OtherOutput & Stamped>(
        context.queryKey,
      )
      return (
        data ?? {
          thread: [],
          horizonFetchedAt: healthEnvironment().now(),
          horizonContinuation: '',
        }
      )
    }
    // The stock path carries no key, read as `''`.
    return fetchStockOther()
  }

  const stockPart: Promise<OtherOutput> = continuation.stockHasOther
    ? fetchStockOther().catch((error: unknown) => {
        logger.warn('other replies unavailable', {safeMessage: error})
        return {thread: []}
      })
    : Promise.resolve({thread: []})

  const readPrivate = async (): Promise<{
    nodes: TreeNode[]
    items: ThreadItem[]
  }> => {
    const nodes: TreeNode[] = []
    // Only while the continuation pages (4.3); a hidden-only one reads none.
    if (!continuation.pages) return {nodes, items: []}
    const seen = new Set(continuation.seen)
    let cursor = continuation.cursor
    let pages = 0
    try {
      do {
        // A read the tap's reset cancelled pages no further (HR4-L2).
        if (context?.signal?.aborted) break
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
      if (cursor && pages >= MAX_OTHER_REPLY_PAGES) {
        logger.warn('other replies: page cap reached', {pages})
      }
    } catch (error) {
      logger.warn('other private replies unavailable', {safeMessage: error})
      keepOrHold(context, error)
    }
    if (nodes.length === 0) return {nodes, items: []}
    const views = await adaptTree(nodes, clients.appviewClient, uri =>
      continuation.cids.get(uri),
    )
    return {
      nodes,
      items: emitPrivateReplies(nodes, 1, {
        sort: continuation.sort,
        branchingFactor: continuation.branchingFactor,
        views,
      }),
    }
  }

  /*
   * The hidden replies (6.3): the prefetched answer when it is fresh, so no
   * call is made; leaves only, each with a read-more row from its
   * `replyCount` for its subtree. Its views carry their read's stamp, which
   * the load gate judges each by.
   */
  const readHidden = async (): Promise<{
    nodes: TreeNode[]
    views: Map<string, PostView>
  }> => {
    if (continuation.hidden.length === 0 || !context) {
      return {nodes: [], views: new Map()}
    }
    try {
      return await ensureHidden(
        context.client,
        clients,
        clients.did,
        anchor,
        continuation,
      )
    } catch (error) {
      logger.warn('hidden replies unavailable', {safeMessage: error})
      keepOrHold(context, error)
      return {nodes: [], views: new Map()}
    }
  }

  const [stock, paged, hidden] = await Promise.all([
    stockPart,
    readPrivate(),
    readHidden(),
  ])
  // Stock part, paged items, then hidden items, de-duplicated by URI.
  const shown = new Set<string>([
    ...continuation.seen,
    ...stock.thread.map(item => item.uri),
    ...paged.items.map(item => item.uri),
  ])
  const hiddenItems = emitPrivateReplies(
    hidden.nodes.filter(node => !shown.has(node.input.view.uri)),
    1,
    {
      sort: continuation.sort,
      branchingFactor: continuation.branchingFactor,
      views: hidden.views,
    },
  )
  /*
   * The two outputs' items differ only in their optional `$type` name; the
   * private items carry none.
   */
  const asOther = [
    ...paged.items,
    ...hiddenItems,
  ] as unknown as OtherOutput['thread']
  return {
    thread: [...stock.thread, ...asOther],
    horizonFetchedAt: healthEnvironment().now(),
    horizonContinuation: continuation.key,
  }
}
