/*
 * A private thread as the stock `getPostThreadV2` answer (6.6), so the stock
 * thread query, traversal and screens render it unchanged (Thread 1).
 *
 * prism serves the thread as a tree: the anchor, its private parents (up to
 * the first one it cannot serve, or a public parent) and its private replies,
 * oldest first. The client applies what the stock call asks the server to do
 * (sort, branching), flattens the tree into thread items, and resolves the
 * top of the chain. A thread prism does not serve is the stand-in, unless it
 * is the current account's just-written (pending) post.
 *
 * Replies past what the thread request serves (2H design 9.1): a node whose
 * served `replyCount` exceeds the replies it came with gets a read-more row,
 * and when prism pages replies (`private.paging`) and the anchor's direct
 * replies may go on, the rest is a continuation (`thread/replies.ts`) that
 * the stock "Show more replies" loads.
 */

import {type Client, XrpcResponseError} from '@atproto/lex'
import {AtUri, type AtUriString, type HandleString} from '@atproto/syntax'
import {type QueryClient, type QueryKey} from '@tanstack/react-query'

import {logger} from '#/logger'
import {
  type PrivatePostView,
  privatePostView,
  type PrivateThreadView,
} from '#/horizon/lexicons/nearhorizon'
import {
  type AdaptInput,
  adaptPosts,
  fetchPublicPosts,
  pendingAsInput,
  readReplyRefs,
} from '#/horizon/private/adapt/feed-view'
import {
  gatesServedForRoot,
  threadGateEvaluation,
} from '#/horizon/private/api/gates'
import {
  type AnswerContext,
  answerOfError,
  getPrivatePostThreadAnswered,
} from '#/horizon/private/api/reads'
import {resyncPublicThreadMute} from '#/horizon/private/api/thread-mute'
import {
  isPrismUnavailable,
  leadErrorOf,
  PrivateSuspectMissError,
  retryAfterMs,
} from '#/horizon/private/api/transient'
import {
  findCachedPrivatePostView,
  hold,
  isOwnPrivateUri,
  noteMiss,
} from '#/horizon/private/known'
import {countsServed} from '#/horizon/private/render/controls'
import {privatePagingServed} from '#/horizon/private/server-support'
import {getPendingPost, getPendingPosts} from '#/horizon/private/store'
import {
  clearReplyContinuation,
  setReplyContinuation,
} from '#/horizon/private/thread/continuation'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {requireCurrentClients} from '#/horizon/routing/current-clients'
import {getPrismHealth} from '#/horizon/routing/health'
import {isPrivateMember} from '#/horizon/routing/membership'
import {type app, com} from '#/lexicons'

type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem

/**
 * The stock thread answer, as the thread query reads it.
 */
export type PrivateThreadResult = {
  thread: ThreadItem[]
  /**
   * The root's threadgate view, when prism served it on the root among the
   * thread's items (2H design 5.4), for the stock hidden-reply merge.
   */
  threadgate?: app.bsky.feed.defs.ThreadgateView
  hasOtherReplies: boolean
}

/**
 * prism's deepest reply level and the parent chain asked for.
 */
const MAX_DEPTH = 10
const PARENT_HEIGHT = 20

/**
 * The most replies prism's thread request serves for one node.
 */
export const PRISM_NODE_REPLY_CAP = 50

/**
 * The deepest `getReplies` expands below each reply.
 */
export const MAX_REPLIES_DEPTH = 6

/**
 * A post in the tree, before adapting.
 */
export type TreeNode = {input: AdaptInput; replies: TreeNode[]}

/**
 * The thread before adapting: parents top first, the anchor with its
 * replies, and what sits above the topmost parent.
 */
type RawThread = {
  parents: AdaptInput[]
  anchor: TreeNode
  publicParent: app.bsky.feed.defs.PostView | undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPublicParent(
  value: unknown,
): value is {post: app.bsky.feed.defs.PostView} {
  return (
    isObject(value) &&
    value.$type === 'app.nearhorizon.private.defs#publicParent' &&
    isObject(value.post) &&
    typeof value.post.uri === 'string'
  )
}

function asPrivateView(value: unknown): PrivatePostView | undefined {
  if (!isObject(value) || !privatePostView.matches(value)) return undefined
  return value
}

/**
 * One served node and its replies, each checked: the thread comes back
 * untyped beyond an object (the type is recursive). A node that is not a
 * private post view is dropped with its replies.
 */
export function toTreeNode(node: unknown): TreeNode | undefined {
  if (!isObject(node)) return undefined
  const view = asPrivateView(node.post)
  if (!view) {
    logger.warn('private thread node dropped: not a private post view')
    return undefined
  }
  const replies = Array.isArray(node.replies)
    ? node.replies.map(toTreeNode).filter((reply): reply is TreeNode => !!reply)
    : []
  return {input: {view}, replies}
}

function fromServed(thread: PrivateThreadView): RawThread | undefined {
  const anchor = toTreeNode(thread)
  if (!anchor) return undefined
  const parents: AdaptInput[] = []
  let publicParent: app.bsky.feed.defs.PostView | undefined
  let parent: unknown = (thread as {parent?: unknown}).parent
  while (parent !== undefined) {
    if (isPublicParent(parent)) {
      publicParent = parent.post
      break
    }
    if (!isObject(parent)) break
    const view = asPrivateView(parent.post)
    if (!view) break
    parents.unshift({view})
    parent = parent.parent
  }
  return {parents, anchor, publicParent}
}

function parentUriOf(input: AdaptInput): string | undefined {
  return readReplyRefs(input.view.record)?.parent.uri
}

/**
 * The thread built from the current account's pending posts: the anchor,
 * its pending parents up the reply chain, and the pending replies to it.
 */
function fromPending(anchorUri: string): RawThread | undefined {
  const anchorEntry = getPendingPost(anchorUri)
  if (!anchorEntry) return undefined
  const all = getPendingPosts().map(pendingAsInput)
  const parents: AdaptInput[] = []
  let parentUri = parentUriOf(pendingAsInput(anchorEntry))
  while (parentUri) {
    const entry = getPendingPost(parentUri)
    if (!entry) break
    const input = pendingAsInput(entry)
    parents.unshift(input)
    parentUri = parentUriOf(input)
  }
  const build = (input: AdaptInput, seen: Set<string>): TreeNode => {
    seen.add(input.view.uri)
    const replies = all
      .filter(
        reply =>
          parentUriOf(reply) === input.view.uri && !seen.has(reply.view.uri),
      )
      .map(reply => build(reply, seen))
    return {input, replies}
  }
  return {
    parents,
    anchor: build(pendingAsInput(anchorEntry), new Set()),
    publicParent: undefined,
  }
}

function createdAtOf(input: AdaptInput): number {
  const createdAt = (input.view.record as {createdAt?: unknown} | null)
    ?.createdAt
  const parsed = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Siblings in the order `sort` asks for: newest first for `newest`, oldest
 * first otherwise (`top` until counts exist, P-2); ties by URI.
 */
export function sortSiblings(nodes: TreeNode[], sort: string | undefined) {
  const newest = sort === 'newest'
  return [...nodes].sort((a, b) => {
    const diff = createdAtOf(a.input) - createdAtOf(b.input)
    if (diff !== 0) return newest ? -diff : diff
    return a.input.view.uri < b.input.view.uri ? -1 : 1
  })
}

function notFoundItem(uri: string, depth: number): ThreadItem {
  return {
    uri: uri as AtUriString,
    depth,
    value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'},
  }
}

/**
 * A not-found item's value as Horizon marks it (prism busy design 6.2): the
 * quiet look ("Couldn't load right now") rather than the audience stand-in,
 * and, while `horizonPending`, the thread skeleton. The marks ride on the
 * stock value, which the traversal passes through as it is.
 */
export type UnavailableItemValue = {
  $type: 'app.bsky.unspecced.defs#threadItemNotFound'
  horizonUnavailable: true
  horizonPending?: boolean
}

/** Whether a not-found item's value carries Horizon's quiet mark. */
export function isUnavailableValue(
  value: unknown,
): value is UnavailableItemValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as {horizonUnavailable?: unknown}).horizonUnavailable === true
  )
}

/**
 * The quiet item in a post's place (6.1, 6.2): another author's post prism
 * could not answer for now, or one a gated load hides.
 */
export function unavailableItem(
  uri: string,
  depth: number,
  {pending = false}: {pending?: boolean} = {},
): ThreadItem {
  const value: UnavailableItemValue = {
    $type: 'app.bsky.unspecced.defs#threadItemNotFound',
    horizonUnavailable: true,
    ...(pending ? {horizonPending: true} : {}),
  }
  return {uri: uri as AtUriString, depth, value}
}

export function postItem(
  post: app.bsky.feed.defs.PostView,
  depth: number,
  {
    moreParents = false,
    moreReplies = 0,
    opThread = false,
  }: {moreParents?: boolean; moreReplies?: number; opThread?: boolean},
): ThreadItem {
  return {
    uri: post.uri,
    depth,
    value: {
      $type: 'app.bsky.unspecced.defs#threadItemPost',
      post,
      moreParents,
      moreReplies,
      opThread,
      hiddenByThreadgate: false,
      mutedByViewer: !!post.author.viewer?.muted,
    },
  }
}

/**
 * The answer for a thread prism does not serve: the anchor as not found,
 * which the thread screen renders as the stand-in.
 */
export function notFoundThread(anchor: string): PrivateThreadResult {
  return {thread: [notFoundItem(anchor, 0)], hasOtherReplies: false}
}

/**
 * The answer for another author's thread prism cannot answer for now
 * (6.1): the anchor as the quiet item, never the audience stand-in.
 */
export function unavailableThread(anchor: string): PrivateThreadResult {
  return {thread: [unavailableItem(anchor, 0)], hasOtherReplies: false}
}

/** What the thread query hands the fetch to keep the reader's own posts. */
export type ThreadQueryContext = {client: QueryClient; queryKey: QueryKey}

function itemPostOf(item: ThreadItem): app.bsky.feed.defs.PostView | undefined {
  return item.value.$type === 'app.bsky.unspecced.defs#threadItemPost'
    ? (item.value as {post: app.bsky.feed.defs.PostView}).post
    : undefined
}

/**
 * The thread's previous data with another author's private posts left out
 * (BR-5: another author's post an answer leaves out is never kept), or
 * `undefined` when it does not hold the anchor.
 */
function previousOwnThread(
  context: ThreadQueryContext | undefined,
  anchorUri: string,
  did: string,
): PrivateThreadResult | undefined {
  const previous = context?.client.getQueryData<PrivateThreadResult>(
    context.queryKey,
  )
  if (!previous?.thread?.some(item => itemPostOf(item)?.uri === anchorUri)) {
    return undefined
  }
  const thread: ThreadItem[] = []
  let dropBelow: number | undefined
  for (const item of previous.thread) {
    if (dropBelow !== undefined && item.depth > dropBelow) continue
    dropBelow = undefined
    const uri = itemPostOf(item)?.uri
    if (uri && isPrivatePostUri(uri) && !isOwnPrivateUri(uri, did)) {
      if (item.depth > 0) dropBelow = item.depth
      continue
    }
    thread.push(item)
  }
  return {
    thread,
    threadgate: previous.threadgate,
    hasOtherReplies: previous.hasOtherReplies,
  }
}

/**
 * The anchor prism left out (6.1): a `NotFound`, or the named `Unavailable`
 * (`signalled`), with no pending version of it. The reader's own anchor is
 * kept (its previous data, or its cached view, labelled "Syncing" by the
 * registry) and held, until its PDS says it is gone; with neither it fails as
 * a suspect miss, retried on the suspect clock. Another author's is never
 * kept: the quiet item when it is a suspect or the account is not healthy,
 * else the audience stand-in.
 */
function missedAnchor(
  anchorUri: string,
  did: string,
  miss: {answer: Pick<AnswerContext, 'did' | 'seq'>; signalled: boolean; retryAfterMs?: number},
  context: ThreadQueryContext | undefined,
): PrivateThreadResult {
  const own = isOwnPrivateUri(anchorUri, did)
  const verdict = noteMiss(miss.answer, anchorUri, {
    signalled: miss.signalled,
    retryAfterMs: miss.retryAfterMs,
    skipPdsCheck: own && miss.signalled,
  })
  const keep = () => {
    if (context) hold(context.queryKey, anchorUri, context.client, did)
  }
  if (own) {
    if (verdict === 'real') return notFoundThread(anchorUri)
    const previous = previousOwnThread(context, anchorUri, did)
    if (previous) {
      keep()
      return previous
    }
    const cached = context
      ? findCachedPrivatePostView(context.client, anchorUri)
      : undefined
    if (cached) {
      keep()
      return {thread: [postItem(cached, 0, {})], hasOtherReplies: false}
    }
    throw new PrivateSuspectMissError(undefined, {did, uri: anchorUri})
  }
  if (verdict === 'suspect') {
    keep()
    return unavailableThread(anchorUri)
  }
  return getPrismHealth(did).causes.size > 0
    ? unavailableThread(anchorUri)
    : notFoundThread(anchorUri)
}

function didOf(uri: string): string | undefined {
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

/**
 * `anchor` with a DID authority, resolving a handle on the public AppView.
 */
export async function resolveAnchor(appview: Client, anchor: string) {
  const urip = new AtUri(anchor)
  if (!urip.host.startsWith('did:')) {
    const data = await appview.call(com.atproto.identity.resolveHandle, {
      handle: urip.host as HandleString,
    })
    urip.host = data.did
  }
  return urip.toString()
}

/**
 * Every post of `nodes` and their replies, in one list.
 */
export function treeInputs(nodes: TreeNode[]): AdaptInput[] {
  const inputs: AdaptInput[] = []
  const walk = (node: TreeNode) => {
    inputs.push(node.input)
    node.replies.forEach(walk)
  }
  nodes.forEach(walk)
  return inputs
}

/**
 * Every node of `nodes` (and `extra`) adapted in one batch, with one author
 * merge. A reply ref without a `cid` is filled from `cidOf`.
 */
export async function adaptTree(
  nodes: TreeNode[],
  appview: Client,
  cidOf: (uri: string) => string | undefined,
  extra: AdaptInput[] = [],
): Promise<Map<string, app.bsky.feed.defs.PostView>> {
  const inputs = [...extra, ...treeInputs(nodes)]
  const cids = new Map(inputs.map(input => [input.view.uri, input.view.cid]))
  const {views} = await adaptPosts(
    inputs,
    appview,
    uri => cids.get(uri) ?? cidOf(uri),
  )
  return views
}

/**
 * Replies the item for `post` leaves for a read-more row: children cut by
 * branching, and, once prism serves the post's counts, replies it has that
 * the request did not serve (below the served depth, or beyond a node's
 * cap). `replyCount` counts replies a threadgate hides, so the row can open
 * nothing new where those are the rest.
 */
function moreRepliesOf(
  post: app.bsky.feed.defs.PostView,
  served: number,
  kept: number,
): number {
  const unserved = countsServed(post.uri)
    ? Math.max(0, (post.replyCount ?? 0) - served)
    : 0
  return served - kept + unserved
}

/**
 * Thread items for private reply `nodes` at `depth`, depth-first: siblings
 * in `sort` order, `branchingFactor` applied below the first level, read-more
 * counts as {@link moreRepliesOf}. `isOp` says whether a post continues the
 * thread author's self-thread under a parent that does (`parentIsOp`).
 */
export function emitPrivateReplies(
  nodes: TreeNode[],
  depth: number,
  {
    sort,
    branchingFactor,
    views,
    isOp = () => false,
    parentIsOp = false,
  }: {
    sort: string | undefined
    branchingFactor: number | undefined
    views: Map<string, app.bsky.feed.defs.PostView>
    isOp?: (post: app.bsky.feed.defs.PostView) => boolean
    parentIsOp?: boolean
  },
): ThreadItem[] {
  const items: ThreadItem[] = []
  const emit = (level: TreeNode[], at: number, parentOp: boolean) => {
    for (const node of sortSiblings(level, sort)) {
      const post = views.get(node.input.view.uri)
      if (!post) continue
      const op = parentOp && isOp(post)
      const children = sortSiblings(node.replies, sort)
      const limit =
        branchingFactor === undefined ? children.length : branchingFactor
      const kept = children.slice(0, limit)
      items.push(
        postItem(post, at, {
          opThread: op,
          moreReplies: moreRepliesOf(post, children.length, kept.length),
        }),
      )
      emit(kept, at + 1, op)
    }
  }
  emit(nodes, depth, parentIsOp)
  return items
}

/**
 * The private parent the thread's chain stopped at (6.1, `:438-441`): prism
 * leaves parents it cannot serve out, unchanged while degraded (DM-C10), so a
 * degraded answer makes it `signalled`. The reader's own suspect parent is its
 * cached view, tagged as from cache and labelled "Syncing", its `moreParents`
 * from its record; another author's suspect is the quiet item; else the
 * stock not-found item.
 */
function cutOffParent(
  parentUri: string,
  depth: number,
  did: string,
  answer: AnswerContext | undefined,
  context: ThreadQueryContext | undefined,
): ThreadItem {
  if (!answer) return notFoundItem(parentUri, depth)
  const verdict = noteMiss(answer, parentUri, {
    signalled: answer.degraded,
    retryAfterMs: answer.retryAfterMs,
  })
  if (verdict !== 'suspect') return notFoundItem(parentUri, depth)
  if (context) hold(context.queryKey, parentUri, context.client, did)
  if (!isOwnPrivateUri(parentUri, did)) return unavailableItem(parentUri, depth)
  const cached = context
    ? findCachedPrivatePostView(context.client, parentUri)
    : undefined
  // An own post never seen here: there is nothing to keep (design 15).
  if (!cached) return unavailableItem(parentUri, depth)
  const tagged = {
    ...cached,
    horizonFromCache: Date.now(),
  } as app.bsky.feed.defs.PostView
  return postItem(tagged, depth, {
    moreParents: !!(cached.record as {reply?: unknown}).reply,
  })
}

/**
 * The private thread at `anchor` as `getPostThreadV2` items: parents first
 * with negative depths, the anchor at 0, then replies depth-first.
 */
export async function fetchPrivateThreadV2(
  anchor: string,
  {
    below,
    branchingFactor,
    sort,
  }: {below: number; branchingFactor?: number; sort?: string},
  context?: ThreadQueryContext,
): Promise<PrivateThreadResult> {
  const clients = requireCurrentClients()
  // Every main read replaces the anchor's continuation.
  clearReplyContinuation(anchor)
  if (!isPrivateMember(clients.did)) return notFoundThread(anchor)
  const anchorUri = await resolveAnchor(clients.appviewClient, anchor)

  let raw: RawThread | undefined
  /** The answer that served the thread, which judges its cut-off parent. */
  let answer: AnswerContext | undefined
  let miss:
    | {answer: Pick<AnswerContext, 'did' | 'seq'>; signalled: boolean; retryAfterMs?: number}
    | undefined
  try {
    const served = await getPrivatePostThreadAnswered(clients.prismClient, {
      uri: anchorUri,
      depth: Math.min(below, MAX_DEPTH),
      parentHeight: PARENT_HEIGHT,
    })
    answer = served.answer
    raw = fromServed(served.thread)
  } catch (error) {
    /*
     * A `NotFound`, or prism's named `Unavailable` (DMR-5), falls through to
     * the pending version; anything else is rethrown for the retry rule (5).
     * A waiter's error is read through its lead's.
     */
    const lead = leadErrorOf(error)
    const named = isPrismUnavailable(error)
    if (
      !named &&
      !(lead instanceof XrpcResponseError && lead.error === 'NotFound')
    ) {
      throw error
    }
    miss = {
      answer: answerOfError(lead) ?? {did: clients.did, seq: 0},
      signalled: named,
      retryAfterMs: named ? retryAfterMs(error) : undefined,
    }
  }
  raw ??= fromPending(anchorUri)
  if (!raw) {
    return missedAnchor(
      anchorUri,
      clients.did,
      miss ?? {answer: answer ?? {did: clients.did, seq: 0}, signalled: false},
      context,
    )
  }

  // Every private post in the thread, for one author merge.
  const publicParent = raw.publicParent
  const views = await adaptTree(
    [raw.anchor],
    clients.appviewClient,
    uri => (uri === publicParent?.uri ? publicParent.cid : undefined),
    raw.parents,
  )

  const anchorView = views.get(raw.anchor.input.view.uri)
  if (!anchorView) return notFoundThread(anchorUri)

  /*
   * The top of the chain: a public parent prism served; else what the
   * topmost record names, read from the public AppView when public and the
   * stand-in when private.
   */
  const chain = raw.parents
    .map(input => views.get(input.view.uri))
    .filter((post): post is app.bsky.feed.defs.PostView => !!post)
  const topmost = raw.parents[0] ?? raw.anchor.input
  const topRefs = readReplyRefs(topmost.view.record)
  let above: ThreadItem | undefined
  /** The public parent as Bluesky's AppView serves it, when read. */
  let stockParent: app.bsky.feed.defs.PostView | undefined
  const aboveDepth = -(chain.length + 1)
  if (raw.publicParent) {
    above = postItem(raw.publicParent, aboveDepth, {
      moreParents: !!(raw.publicParent.record as {reply?: unknown}).reply,
    })
  } else if (topRefs) {
    const parentUri = topRefs.parent.uri
    if (isPrivatePostUri(parentUri)) {
      above = cutOffParent(parentUri, aboveDepth, clients.did, answer, context)
    } else {
      const found = (
        await fetchPublicPosts(clients.appviewClient, [parentUri])
      ).get(parentUri)
      stockParent = found
      above = found
        ? postItem(found, aboveDepth, {
            moreParents: !!(found.record as {reply?: unknown}).reply,
          })
        : notFoundItem(parentUri, aboveDepth)
    }
  }

  /*
   * A self-thread: every post from the thread's root down to the item has
   * the root's author. The root's author is the authority of the root ref
   * (or of the topmost post when it is the root); a chain that does not
   * reach the root marks nothing.
   */
  const rootUri = topRefs ? topRefs.root.uri : topmost.view.uri
  /*
   * A private branch under a public root: Bluesky's mute state of the root
   * (on its public parent's view) and prism's (on the anchor's) are both
   * known here; prism follows Bluesky's when they differ (H-5).
   */
  if (stockParent && !isPrivatePostUri(rootUri)) {
    resyncPublicThreadMute(
      rootUri,
      stockParent.viewer?.threadMuted,
      anchorView.viewer?.threadMuted,
    )
  }
  /*
   * Read alongside the rest of the thread (6.6 step 7, applied below), unless
   * prism applies the root's gates itself.
   */
  const servedGates = gatesServedForRoot(rootUri)
  const gatesPromise = servedGates
    ? Promise.resolve(undefined)
    : threadGateEvaluation(rootUri, anchorView.uri)
  const rootAuthor = didOf(rootUri)
  const chainReachesRoot = !topRefs
  const byOp = (post: app.bsky.feed.defs.PostView) =>
    chainReachesRoot && post.author.did === rootAuthor

  const thread: ThreadItem[] = []
  if (above) thread.push(above)
  let opSoFar = true
  chain.forEach((post, i) => {
    opSoFar = opSoFar && byOp(post)
    thread.push(postItem(post, i - chain.length, {opThread: opSoFar}))
  })
  opSoFar = opSoFar && byOp(anchorView)
  thread.push(postItem(anchorView, 0, {opThread: opSoFar}))

  // Every direct reply of the anchor is kept; branching applies below.
  thread.push(
    ...emitPrivateReplies(raw.anchor.replies, 1, {
      sort,
      branchingFactor,
      views,
      isOp: byOp,
      parentIsOp: opSoFar,
    }),
  )

  /*
   * The anchor's direct replies may go on past what was served: prism cut
   * the node at its cap (hidden replies and failed reads can leave fewer),
   * or its served count says so. The rest pages through `getReplies`.
   */
  const directReplies = raw.anchor.replies.length
  const hasOtherReplies =
    privatePagingServed() &&
    (directReplies >= PRISM_NODE_REPLY_CAP ||
      (countsServed(anchorView.uri) &&
        (anchorView.replyCount ?? 0) > directReplies))
  if (hasOtherReplies) {
    setReplyContinuation(anchor, {
      kind: 'private',
      anchorUri: anchorView.uri,
      cursor: undefined,
      depth: Math.max(0, Math.min(below - 1, MAX_REPLIES_DEPTH)),
      sort,
      branchingFactor,
      seen: new Set(raw.anchor.replies.map(node => node.input.view.uri)),
      cids: new Map([[anchorView.uri, anchorView.cid]]),
      stockHasOther: false,
    })
  }

  /*
   * Gates. Where prism applies them (`private.gates`, a private root), the
   * thread request read the root, so a private post's `replyDisabled` absent
   * means allowed. Otherwise the interim gates (7.4.2): the root's threadgate
   * governs every private post of the thread, the anchor's postgate its
   * quotes. The stock thread screen dims reply and quote from these viewer
   * fields. On a failure or after the deadline nothing is set.
   */
  const gates = await gatesPromise
  if (gates || servedGates) {
    for (const item of thread) {
      if (item.value.$type !== 'app.bsky.unspecced.defs#threadItemPost') {
        continue
      }
      // Built above by `postItem`; the union's open member hides `post`.
      const post = (item.value as {post: app.bsky.feed.defs.PostView}).post
      if (!isPrivatePostUri(post.uri)) continue
      if (!gates) {
        post.viewer = {
          ...post.viewer,
          replyDisabled: post.viewer?.replyDisabled === true,
        }
        continue
      }
      post.viewer = {
        ...post.viewer,
        replyDisabled: gates.replyDisabled,
        ...(post.uri === anchorView.uri
          ? {embeddingDisabled: gates.embeddingDisabled}
          : {}),
      }
    }
  }

  return {
    thread,
    threadgate: views.get(rootUri)?.threadgate,
    hasOtherReplies,
  }
}
