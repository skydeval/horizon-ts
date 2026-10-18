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
import {getPrivatePostThread} from '#/horizon/private/api/reads'
import {resyncPublicThreadMute} from '#/horizon/private/api/thread-mute'
import {countsServed} from '#/horizon/private/render/controls'
import {privatePagingServed} from '#/horizon/private/server-support'
import {getPendingPost, getPendingPosts} from '#/horizon/private/store'
import {
  clearReplyContinuation,
  setReplyContinuation,
} from '#/horizon/private/thread/continuation'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {requireCurrentClients} from '#/horizon/routing/current-clients'
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
): Promise<PrivateThreadResult> {
  const clients = requireCurrentClients()
  // Every main read replaces the anchor's continuation.
  clearReplyContinuation(anchor)
  if (!isPrivateMember(clients.did)) return notFoundThread(anchor)
  const anchorUri = await resolveAnchor(clients.appviewClient, anchor)

  let raw: RawThread | undefined
  try {
    const served = await getPrivatePostThread(clients.prismClient, {
      uri: anchorUri,
      depth: Math.min(below, MAX_DEPTH),
      parentHeight: PARENT_HEIGHT,
    })
    raw = fromServed(served)
  } catch (error) {
    if (!(error instanceof XrpcResponseError) || error.error !== 'NotFound') {
      throw error
    }
  }
  raw ??= fromPending(anchorUri)
  if (!raw) return notFoundThread(anchorUri)

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
      above = notFoundItem(parentUri, aboveDepth)
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
