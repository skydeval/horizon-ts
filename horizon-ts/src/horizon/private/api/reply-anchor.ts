/*
 * Where a private reply sits, and whose audience it names (4.7, against
 * aurora A-12 and A-13 as live).
 *
 * Every private reply hangs off an *anchor*, whose current `audienceList` it
 * names and whose author decides the procedure:
 *
 * - **Thread.** The parent is private and so is its `reply.root` (or the
 *   parent is a top-level private post): the anchor is the thread root.
 * - **Branch.** The parent is private and its `reply.root` is public: the
 *   anchor is the *branch root*, the first private post up the
 *   `reply.parent` chain whose own parent is public. It is found by walking
 *   up through private posts, at most {@link MAX_ANCHOR_WALK} of them, as
 *   aurora's walk is bounded.
 *
 * A private reply to a public post is itself a branch root; it has no anchor
 * here and is written under the composer's audience (`writes.ts`).
 *
 * The anchor's audience is read at publish time, never taken from the
 * parent, so a reply after the anchor moved (7.8.1) names the audience it has
 * now. The writer's own anchor is read from the writer's own PDS, which is
 * current the moment a move is saved; another account's from prism.
 *
 * Logs name URIs only, never private text.
 */

import {type Client, XrpcResponseError} from '@atproto/lex'
import {AtUri, type DidString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {privatePostView} from '#/horizon/lexicons/nearhorizon'
import {toPostView} from '#/horizon/private/adapt/post-view'
import {
  getPrivatePosts,
  getPrivatePostThread,
} from '#/horizon/private/api/reads'
import {findCachedPrivatePostView} from '#/horizon/private/known'
import {
  getPendingPost,
  getPrivatePostFacts,
  pendingPhase,
  pinPrivatePostAudience,
} from '#/horizon/private/store'
import {isPrivatePostUri, PP_COLLECTION} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {type app, com} from '#/lexicons'

/**
 * How many private posts a branch walk reads before giving up: aurora's
 * bound for threads and branches (A-13), and prism's on prism.nearhorizon.app
 * (P-23).
 */
export const MAX_ANCHOR_WALK = 100

/**
 * The private post being replied to is missing or not readable by the
 * replier.
 */
export class PrivateParentUnavailableError extends Error {
  constructor() {
    super(
      t`You can’t reply to this post. It may have been deleted, or it is no longer visible to you.`,
    )
    this.name = 'PrivateParentUnavailableError'
  }
}

/**
 * The reply cannot be written in this conversation: aurora refused it, or
 * the conversation's anchor could not be found or read.
 */
export class PrivateReplyRefusedError extends Error {
  constructor() {
    super(
      t`You can’t reply in this conversation. You may not be among the people who can see it.`,
    )
    this.name = 'PrivateReplyRefusedError'
  }
}

/**
 * prism did not serve a post placing the reply needs (another author's
 * parent, anchor or branch hop, or an own post whose PDS read failed), or a
 * planning read failed transiently (prism busy design 9). Horizon never
 * decides another author's post is gone (BR-5), so this says only that the
 * post could not be reached; Retry places it once prism serves it. It carries
 * the outbox's `parent-busy` text as its message, which the locus route's
 * composer shows.
 */
export class PrivateParentBusyError extends Error {
  constructor() {
    super(
      t`Couldn’t reach the post you’re replying to. Try again in a moment.`,
    )
    this.name = 'PrivateParentBusyError'
  }
}

/**
 * A strong ref as Horizon handles it before validation types it.
 */
export type StrongRef = {uri: string; cid: string}

/**
 * The fields of a private record that placing a reply reads, checked: prism's
 * record is `unknown` in its lexicon.
 */
export type PlacementFields = {
  audienceList?: string
  /** `reply.root`, when both its fields are strings. */
  root?: StrongRef
  /** `reply.parent`, when both its fields are strings. */
  parent?: StrongRef
  /** The record has a `reply` at all. */
  isReply: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRef(value: unknown): StrongRef | undefined {
  if (!isObject(value)) return undefined
  return typeof value.uri === 'string' && typeof value.cid === 'string'
    ? {uri: value.uri, cid: value.cid}
    : undefined
}

/**
 * The placement fields of a private record.
 */
export function placementFields(record: unknown): PlacementFields {
  if (!isObject(record)) return {isReply: false}
  const reply = isObject(record.reply) ? record.reply : undefined
  return {
    audienceList:
      typeof record.audienceList === 'string' ? record.audienceList : undefined,
    root: reply ? readRef(reply.root) : undefined,
    parent: reply ? readRef(reply.parent) : undefined,
    isReply: !!reply,
  }
}

/**
 * One private post as read for placing a reply.
 */
type PlacedPost = {
  ref: StrongRef
  fields: PlacementFields
  view: app.bsky.feed.defs.PostView | undefined
  /** Read from the writer's own PDS just now. */
  fromPds?: true
}

/**
 * One private post read for placing a reply (prism busy design 9): found;
 * a `miss` (prism left it out, which never says it is gone); or `absent`
 * (the writer's own post, and their PDS says `RecordNotFound`).
 */
type PostRead =
  | {kind: 'found'; post: PlacedPost}
  | {kind: 'miss'}
  | {kind: 'absent'}

/**
 * The writer's own record as a placed post, its view from the cache when one
 * is there (only the pending feed item reads it, so a failed lookup never
 * fails the placement).
 */
function ownPlaced(
  uri: string,
  own: {cid: string; fields: PlacementFields},
  queryClient: QueryClient | undefined,
): PlacedPost {
  let view: PlacedPost['view']
  try {
    view = queryClient
      ? findCachedPrivatePostView(queryClient, uri)
      : undefined
  } catch (error) {
    logger.warn('own parent view lookup failed', {uri, safeMessage: error})
  }
  return {ref: {uri, cid: own.cid}, fields: own.fields, view, fromPds: true}
}

/**
 * A private post: the writer's own pending post when it is one and is
 * written (prism does not serve it yet, and its record is exactly what was
 * written, moves included); the writer's own record from their PDS (design 9:
 * own posts place from the PDS, a failed read falling back to prism); else
 * prism's view. A pending post still being sent, or failed, is never placed
 * from (2K design PA-28 steps 2 and 3): the outbox decides on it first. A
 * miss adds nothing to the suspect registry (design 9).
 */
async function readPrivatePost(
  clients: PlacementClients,
  uri: string,
  {skipPds = false}: {skipPds?: boolean} = {},
): Promise<PostRead> {
  const pending = getPendingPost(uri, clients.did)
  if (pending && pendingPhase(pending) === 'written') {
    return {
      kind: 'found',
      post: {
        ref: {uri: pending.uri, cid: pending.cid},
        fields: placementFields(pending.record),
        view: pending.postView,
      },
    }
  }
  if (!skipPds && authorOf(uri) === clients.did) {
    const own = await readOwnPrivateRecord(
      clients.pdsClient,
      clients.did,
      new AtUri(uri).rkey,
    )
    if (own === 'absent') return {kind: 'absent'}
    if (own) {
      return {
        kind: 'found',
        post: ownPlaced(
          uri,
          own,
          clients.queryClient ?? getCurrentClients()?.queryClient,
        ),
      }
    }
  }
  const found = (await getPrivatePosts(clients.prismClient, [uri])).find(
    post => post.uri === uri,
  )
  if (!found || !isObject(found.record)) return {kind: 'miss'}
  return {
    kind: 'found',
    post: {
      ref: {uri: found.uri, cid: found.cid},
      fields: placementFields(found.record),
      view: toPostView(found),
    },
  }
}

/**
 * The placed post of a read, or the failure it stands for: a miss is
 * `PrivateParentBusyError`, an own `absent` `PrivateParentUnavailableError`
 * (BQ-9).
 */
function placedOrThrow(read: PostRead): PlacedPost {
  if (read.kind === 'found') return read.post
  if (read.kind === 'absent') throw new PrivateParentUnavailableError()
  throw new PrivateParentBusyError()
}

/**
 * The writer's own private record from their PDS: its CID and placement
 * fields, `'absent'` when the PDS has no such record, `undefined` when the
 * read failed otherwise.
 */
export async function readOwnPrivateRecord(
  pdsClient: Client,
  did: string,
  rkey: string,
): Promise<{cid: string; fields: PlacementFields} | 'absent' | undefined> {
  try {
    const res = await pdsClient.call(com.atproto.repo.getRecord, {
      repo: did as DidString,
      collection: PP_COLLECTION,
      rkey,
    })
    if (!res.cid) return undefined
    return {cid: res.cid, fields: placementFields(res.value)}
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return 'absent'
    }
    return undefined
  }
}

function authorOf(uri: string): string | undefined {
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

/**
 * The clients placing a reply needs.
 */
export type PlacementClients = {
  did: string
  pdsClient: Client
  prismClient: Client
  /** For an own parent's cached view; default the published account's. */
  queryClient?: QueryClient
}

/**
 * A private reply's anchor.
 */
export type ReplyAnchor = {
  kind: 'thread' | 'branch'
  uri: string
  /** The anchor's author, who writes with `createPostPrivate`. */
  authorDid: string
  /** The anchor's current audience, which the reply names. */
  audienceUri: string
}

/**
 * Where a reply to a private post goes: its reply refs, the parent's view
 * (for the pending feed item) and its anchor.
 */
export type PrivateReplyPlace = {
  reply: {root: StrongRef; parent: StrongRef}
  parentView: app.bsky.feed.defs.PostView | undefined
  anchor: ReplyAnchor
}

/**
 * The anchor's current audience. The writer's own anchor is read from the
 * writer's PDS (falling back to `known`, then prism, when that read fails);
 * another account's is `known` (already read in this placement) or prism's.
 * Throws {@link PrivateParentUnavailableError} when the writer's own PDS says
 * their anchor is gone (BQ-9, BR17-N2), {@link PrivateParentBusyError} when
 * prism leaves the anchor out (design 9), and
 * {@link PrivateReplyRefusedError} when it names no audience (a reply must
 * name one, and must name the anchor's).
 */
async function anchorAudience(
  clients: PlacementClients,
  uri: string,
  known: PlacedPost | undefined,
): Promise<string> {
  let audienceUri: string | undefined
  let read = false
  if (authorOf(uri) === clients.did) {
    const own = known?.fromPds
      ? {cid: known.ref.cid, fields: known.fields}
      : await readOwnPrivateRecord(
          clients.pdsClient,
          clients.did,
          new AtUri(uri).rkey,
        )
    if (own === 'absent') throw new PrivateParentUnavailableError()
    if (own) {
      read = true
      audienceUri = own.fields.audienceList
      /*
       * prism may still serve the anchor's old audience just after a move;
       * the facts follow the record, pinned so a stale served audience does
       * not win over it (2H design 5.6), and the composer's label follows.
       */
      const facts = getPrivatePostFacts(uri)
      if (
        audienceUri &&
        facts &&
        (facts.audienceUri !== audienceUri ||
          (facts.servedAudience !== undefined &&
            facts.servedAudience.uri !== audienceUri))
      ) {
        pinPrivatePostAudience(uri, audienceUri)
      }
    }
  }
  if (!read) {
    // An own anchor's PDS read just failed: prism's view is the fallback.
    const post =
      known ??
      placedOrThrow(await readPrivatePost(clients, uri, {skipPds: true}))
    audienceUri = post.fields.audienceList
  }
  if (!audienceUri) throw new PrivateReplyRefusedError()
  return audienceUri
}

/**
 * The parent chain one thread request serves.
 */
const BRANCH_WALK_PARENT_HEIGHT = 30

/**
 * The branch walk through prism's thread view (2H design 12.2): one
 * `getPostThread` of `start` with its parent chain, walked up to the topmost
 * private post, whose parent prism serves as a public parent; a chain of
 * {@link BRANCH_WALK_PARENT_HEIGHT} private parents goes on with the same
 * call from its top. `undefined` (the caller walks post by post) when the
 * chain stops at a missing parent, prism answers `NotFound` or fails, or any
 * node disagrees: on the public root, on the chain's links, or by a cycle.
 * Refused past {@link MAX_ANCHOR_WALK} posts, as the per-post walk.
 */
async function findBranchRootByThread(
  prism: Client,
  start: PlacedPost,
  rootUri: string,
): Promise<PlacedPost | undefined> {
  let current = start
  const seen = new Set<string>([start.ref.uri])
  while (true) {
    let thread: unknown
    try {
      thread = await getPrivatePostThread(prism, {
        uri: current.ref.uri,
        depth: 0,
        parentHeight: BRANCH_WALK_PARENT_HEIGHT,
      })
    } catch (error) {
      logger.info('branch walk: thread view unavailable', {
        uri: current.ref.uri,
        safeMessage: error,
      })
      return undefined
    }
    if (!isObject(thread) || !isObject(thread.post)) return undefined
    if (thread.post.uri !== current.ref.uri) return undefined
    let node: unknown = thread.parent
    let read = 0
    while (isObject(node)) {
      const up = current.fields.parent?.uri
      if (!up) return undefined
      if (node.$type === 'app.nearhorizon.private.defs#publicParent') {
        const post = isObject(node.post) ? node.post : undefined
        return post?.uri === up && !isPrivatePostUri(up) ? current : undefined
      }
      const view = node.post
      if (!isObject(view) || !privatePostView.matches(view)) return undefined
      if (view.uri !== up || seen.has(view.uri)) return undefined
      const fields = placementFields(view.record)
      if (fields.root?.uri !== rootUri) return undefined
      if (seen.size >= MAX_ANCHOR_WALK) throw new PrivateReplyRefusedError()
      seen.add(view.uri)
      read++
      current = {
        ref: {uri: view.uri, cid: view.cid},
        fields,
        view: toPostView(view),
      }
      node = node.parent
    }
    const up = current.fields.parent?.uri
    if (up && !isPrivatePostUri(up)) return current
    // A full chain goes on from its top; a shorter one stopped at a gap.
    if (read < BRANCH_WALK_PARENT_HEIGHT) return undefined
  }
}

/**
 * Walk up from `start` (a private post under a public root) through private
 * parents to the branch root: the first post whose `reply.parent` is not a
 * private post. Each post walked must agree on the public root. At most
 * {@link MAX_ANCHOR_WALK} posts are read, `start` included. The thread view
 * is asked first (`findBranchRootByThread`); the post-by-post walk is the
 * fallback, which reads the writer's own hops from their PDS (BR15-N8). A
 * hop prism leaves out is {@link PrivateParentBusyError}, an own hop the PDS
 * says is gone {@link PrivateParentUnavailableError} (BR18-N3); the walk's
 * own refusals (no parent, the bound, a cycle, a hop on another root) stay
 * {@link PrivateReplyRefusedError}.
 */
async function findBranchRoot(
  clients: PlacementClients,
  start: PlacedPost,
  rootUri: string,
): Promise<PlacedPost> {
  const firstUp = start.fields.parent?.uri
  if (firstUp && !isPrivatePostUri(firstUp)) return start
  const byThread = await findBranchRootByThread(
    clients.prismClient,
    start,
    rootUri,
  )
  if (byThread) return byThread
  let current = start
  const seen = new Set<string>([start.ref.uri])
  while (true) {
    const up = current.fields.parent?.uri
    if (!up) throw new PrivateReplyRefusedError()
    if (!isPrivatePostUri(up)) return current
    if (seen.size >= MAX_ANCHOR_WALK || seen.has(up)) {
      throw new PrivateReplyRefusedError()
    }
    seen.add(up)
    const next = placedOrThrow(await readPrivatePost(clients, up))
    if (next.fields.root?.uri !== rootUri) {
      throw new PrivateReplyRefusedError()
    }
    current = next
  }
}

/**
 * Place a reply to the private post `parentUri`: its reply refs (the root
 * copied from the parent, as stock), the parent's view and the anchor with
 * its current audience. Throws {@link PrivateParentBusyError} when prism
 * leaves out the parent, the anchor or a branch hop (prism busy design 9),
 * {@link PrivateParentUnavailableError} when the writer's own PDS says their
 * own parent, anchor or hop is gone (BQ-9), and
 * {@link PrivateReplyRefusedError} for prism's and the walk's refusals. A
 * planning read's own failure is rethrown as it came (the outbox classes
 * it).
 */
export async function placePrivateReply(
  clients: PlacementClients,
  parentUri: string,
): Promise<PrivateReplyPlace> {
  const parent = placedOrThrow(await readPrivatePost(clients, parentUri))
  const {fields} = parent
  if (fields.isReply && !fields.root) throw new PrivateReplyRefusedError()
  const root = fields.root ?? parent.ref
  const reply = {root, parent: parent.ref}

  let anchor: PlacedPost | undefined
  let anchorUri: string
  let kind: ReplyAnchor['kind']
  if (isPrivatePostUri(root.uri)) {
    kind = 'thread'
    anchorUri = root.uri
    anchor = root.uri === parent.ref.uri ? parent : undefined
  } else {
    kind = 'branch'
    anchor = await findBranchRoot(clients, parent, root.uri)
    anchorUri = anchor.ref.uri
  }
  const authorDid = authorOf(anchorUri)
  if (!authorDid) throw new PrivateReplyRefusedError()
  const audienceUri = await anchorAudience(clients, anchorUri, anchor)
  return {
    reply,
    parentView: parent.view,
    anchor: {kind, uri: anchorUri, authorDid, audienceUri},
  }
}
