/*
 * Lens nodes (Phase 4 design 7.2): the check of each node prism sends, the
 * field-by-field merge of a response into the held node map, and the links
 * that make the map a tree.
 *
 * - The check (step 1). A node needs a `uri` that passes prism's own
 *   `at_uri` test and either a `post` object with that `uri` or a string
 *   `gap`; anything else is dropped and logged once per response, so one
 *   odd node never fails a response or a `resolve` batch. prism's optional
 *   `hiddenByThreadgate` (P-9) and `blockingByListUri` (P-10) are read here
 *   and nowhere else, so a rename by prism changes one line each.
 * - The merge (step 2). A held post node sent again as a post keeps its held
 *   public view object (TL-31); only a URI new as a post node goes to the
 *   public-view pass. The hidden flag is or-ed. Markers merge by what the
 *   request asked (TL-32). A post is never replaced by a gap from a response
 *   that did worse; a private node is never replaced by a lens node; a node
 *   without `parentUri` keeps the held one.
 * - The links (step 3). On the merged map, never per response: the anchor's
 *   parent chain up `parentUri`, then its replies by `parentUri`. A reply
 *   whose parent the map lacks is dropped with its subtree.
 */

import {AtUri, isValidDid} from '@atproto/syntax'

import {logger} from '#/logger'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView
type ListViewBasic = app.bsky.graph.defs.ListViewBasic

/** The gap kinds prism's `defs.json` lists today. The set is open. */
export const KNOWN_GAP_KINDS = [
  'blocked-by-you',
  'blocking-you',
  'block-state-unknown',
  'blocked',
  'deleted',
  'not-found',
  'upstream-unavailable',
  'content-stripped',
  'tier-hidden',
] as const

/**
 * Horizon's own kind for a marked anchor the registry does not hold (TL-33).
 * Never a prism value.
 */
export const UNVERIFIED_GAP = 'unverified'

/** The two gap kinds that may carry markers and a list (`defs.json`). */
function isBlockKind(gap: string): boolean {
  return gap === 'blocked-by-you' || gap === 'blocking-you'
}

/** Continuation markers on a node (`defs.json`). */
export type LensMarkers = {
  moreParents?: true
  moreReplies?: {cursor?: string}
}

type CheckedBase = {
  uri: string
  parentUri?: string
  markers: LensMarkers
  hidden: boolean
}

/** A post node as prism sent it. `post` is prism's view, unchecked. */
export type CheckedPost = CheckedBase & {
  type: 'post'
  rootUri?: string
  post: Record<string, unknown>
  /**
   * prism's `embedWhole` (2026-10-26): the post's quote card is whole for
   * the reader (its labels and author state the reader's), so a member's
   * quote post can skip the public-view pass. Kept only when exactly `true`.
   */
  embedWhole?: true
}

/** A gap node as prism sent it. */
export type CheckedGap = CheckedBase & {
  type: 'gap'
  gap: string
  /** `blockingByListUri`, on a `blocked-by-you` gap only. */
  listUri?: string
}

export type CheckedNode = CheckedPost | CheckedGap

/**
 * A node in the snapshot's map (9.1).
 *
 * - `post`: a public post node with the view that renders, the public
 *   AppView's (6.2), or prism's for a post prism marks restored (6.3).
 * - `gap`: prism's gap, or one Horizon made (6.3, 5.6). `bridging` is the
 *   one of the response that set it, for the `blocked` Retry rule (8.1).
 * - `private`: a member's private reply (5.5), with its adapted view.
 * - `optimistic`: a reply the reader just posted, with the composer's view.
 */
export type LensNode =
  | {
      kind: 'post'
      uri: string
      parentUri?: string
      rootUri?: string
      view: PostView
      restored?: true
    }
  | {
      kind: 'gap'
      uri: string
      parentUri?: string
      gap: string
      listUri?: string
      /** The list view, when the public view named it (6.3). */
      list?: ListViewBasic
      bridging: string
    }
  | {kind: 'private'; uri: string; parentUri?: string; view: PostView}
  | {kind: 'optimistic'; uri: string; parentUri?: string; view: PostView}

/** What the public-view pass made of a post node (6.3). */
export type PublicOutcome =
  | {kind: 'view'; view: PostView}
  | {kind: 'restored'; view: PostView}
  | {
      kind: 'gap'
      gap: 'blocked-by-you' | 'blocking-you' | 'content-stripped'
      list?: ListViewBasic
      /** The list's URI when the view named it without its list view. */
      listUri?: string
    }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * prism's `at_uri` check (`handlers.rs`): `at://`, a valid DID authority and
 * exactly four slashes.
 */
export function isLensAtUri(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('at://')) return false
  if (value.split('/').length - 1 !== 4) return false
  const authority = value.slice('at://'.length).split('/')[0]
  return isValidDid(authority)
}

/** An `app.bsky.graph.list` AT-URI that passes the `at_uri` check. */
function isListUri(value: unknown): value is string {
  if (!isLensAtUri(value)) return false
  try {
    return new AtUri(value).collection === 'app.bsky.graph.list'
  } catch {
    return false
  }
}

function markersOf(raw: Record<string, unknown>): LensMarkers {
  const markers: LensMarkers = {}
  if (raw.moreParents === true) markers.moreParents = true
  if (isObject(raw.moreReplies)) {
    const cursor = raw.moreReplies.cursor
    markers.moreReplies = typeof cursor === 'string' ? {cursor} : {}
  }
  return markers
}

/**
 * One node, checked (step 1), or `undefined` to drop it. A post node with a
 * private URI is a `tier-hidden` gap (5.6), never sent anywhere.
 */
export function checkLensNode(raw: unknown): CheckedNode | undefined {
  if (!isObject(raw) || !isLensAtUri(raw.uri)) return undefined
  const uri = raw.uri
  const parentUri = isLensAtUri(raw.parentUri) ? raw.parentUri : undefined
  const hidden = raw.hiddenByThreadgate === true
  const base = {uri, ...(parentUri ? {parentUri} : {}), hidden}
  if (isObject(raw.post) && raw.post.uri === uri) {
    if (isPrivatePostUri(uri)) {
      logger.warn('thread lens: a post node with a private URI', {uri})
      return {...base, type: 'gap', gap: 'tier-hidden', markers: {}}
    }
    return {
      ...base,
      type: 'post',
      ...(isLensAtUri(raw.rootUri) ? {rootUri: raw.rootUri} : {}),
      post: raw.post,
      markers: markersOf(raw),
      ...(raw.embedWhole === true ? {embedWhole: true as const} : {}),
    }
  }
  if (typeof raw.gap === 'string') {
    const gap = raw.gap
    const listUri =
      gap === 'blocked-by-you' && isListUri(raw.blockingByListUri)
        ? raw.blockingByListUri
        : undefined
    return {
      ...base,
      type: 'gap',
      gap,
      ...(listUri ? {listUri} : {}),
      markers: isBlockKind(gap) ? markersOf(raw) : {},
    }
  }
  return undefined
}

/** Every node of a response, checked; the dropped ones logged once. */
export function checkLensNodes(raw: readonly unknown[]): CheckedNode[] {
  const checked: CheckedNode[] = []
  let dropped = 0
  for (const node of raw) {
    const ok = checkLensNode(node)
    if (ok) checked.push(ok)
    else dropped++
  }
  if (dropped > 0) {
    logger.warn('thread lens: malformed nodes dropped', {dropped})
  }
  return checked
}

/** The held state a response merges into (9.1). */
export type MergeBase = {
  nodes: ReadonlyMap<string, LensNode>
  markers: ReadonlyMap<string, LensMarkers>
  hidden: ReadonlySet<string>
}

/** An empty base, for a first response. */
export const EMPTY_BASE: MergeBase = {
  nodes: new Map(),
  markers: new Map(),
  hidden: new Set(),
}

/**
 * What the response's request asked (TL-32), which decides the markers it
 * is authoritative for.
 *
 * - `first`: a screen's first read; every marker as sent.
 * - `replies`: "Load more replies" on `anchor` (`parentHeight: 0`).
 *   `subtree` false under the dev small-page setting, where the request's
 *   depth is not the rendered bound (v5: R3-N2).
 * - `parents`: "Load earlier posts" on `anchor` (`depth: 0`).
 * - `resolve`: a retry; items carry no markers.
 */
export type MergeRequest =
  | {kind: 'first'}
  | {kind: 'replies'; anchor: string; subtree: boolean}
  | {kind: 'parents'; anchor: string}
  | {kind: 'resolve'}

/** A merged response. */
export type MergeResult = MergeBase & {
  /** URIs the map lacked before (the stop rule, 9.2). */
  added: ReadonlySet<string>
  /** Every gap the response leaves drawn, for the registry (step 5). */
  gaps: readonly (readonly [uri: string, kind: string])[]
  /** Views new to the map, for the private quote resolution (5.5). */
  newViews: readonly PostView[]
}

/**
 * The post node URIs of `checked` that need the public-view pass (TL-31): a
 * URI new as a post node (absent, or held as a gap or an optimistic reply).
 * A held post or private node is never read again, and nor is a private URI.
 */
export function postUrisToRead(
  base: MergeBase,
  checked: readonly CheckedNode[],
): string[] {
  const uris: string[] = []
  for (const node of checked) {
    if (node.type !== 'post' || isPrivatePostUri(node.uri)) continue
    const held = base.nodes.get(node.uri)
    if (held?.kind === 'post' || held?.kind === 'private') continue
    uris.push(node.uri)
  }
  return Array.from(new Set(uris))
}

/**
 * Whether a gap from a response that did worse than a held post: it never
 * replaces the post (7.2 step 2, R1-L12). A new block does.
 */
function isWorseGap(gap: string, bridging: string): boolean {
  if (gap === 'blocked') return bridging !== 'full'
  if (gap === 'upstream-unavailable' || gap === 'block-state-unknown') {
    return true
  }
  return !(KNOWN_GAP_KINDS as readonly string[]).includes(gap)
}

/**
 * The URIs a "Load more replies" response places under its anchor (v5:
 * R3-N2), by the response's own `parentUri` links.
 */
function subtreeOf(anchor: string, checked: readonly CheckedNode[]) {
  const under = new Set<string>([anchor])
  let grew = true
  while (grew) {
    grew = false
    for (const node of checked) {
      if (under.has(node.uri)) continue
      if (node.parentUri && under.has(node.parentUri)) {
        under.add(node.uri)
        grew = true
      }
    }
  }
  under.delete(anchor)
  return under
}

function markersEmpty(markers: LensMarkers | undefined): boolean {
  return !markers || (!markers.moreParents && !markers.moreReplies)
}

/** TL-32: the markers a node keeps after `request`. */
function nextMarkers(
  node: CheckedNode,
  held: LensMarkers | undefined,
  wasHeld: boolean,
  request: MergeRequest,
  context: {subtree: ReadonlySet<string>; top: string | undefined},
): LensMarkers | undefined {
  const sent = node.markers
  if (!wasHeld || request.kind === 'first') return sent
  switch (request.kind) {
    case 'replies':
      if (
        node.uri === request.anchor ||
        (request.subtree && context.subtree.has(node.uri))
      ) {
        return {
          ...(held?.moreParents ? {moreParents: true as const} : {}),
          ...(sent.moreReplies ? {moreReplies: sent.moreReplies} : {}),
        }
      }
      return held
    case 'parents':
      if (node.uri === request.anchor || node.uri === context.top) {
        return {
          ...(sent.moreParents ? {moreParents: true as const} : {}),
          ...(held?.moreReplies ? {moreReplies: held.moreReplies} : {}),
        }
      }
      return held
    case 'resolve':
      return held
  }
}

/**
 * The node `checked` becomes, given the held node and the public-view
 * outcome; `undefined` when the held node stays as it is.
 */
function effectiveNode(
  node: CheckedNode,
  held: LensNode | undefined,
  outcome: PublicOutcome | undefined,
  bridging: string,
): LensNode | undefined {
  const parentUri = node.parentUri ?? held?.parentUri
  const parent = parentUri ? {parentUri} : {}
  // A private node is never replaced by a lens node (5.5).
  if (held?.kind === 'private') return undefined
  if (node.type === 'post') {
    if (held?.kind === 'post') {
      // TL-31: the held view object stays; only the place may change.
      return node.parentUri && node.parentUri !== held.parentUri
        ? {...held, parentUri: node.parentUri}
        : undefined
    }
    const rootUri = node.rootUri ? {rootUri: node.rootUri} : {}
    switch (outcome?.kind) {
      case 'view':
        return {
          kind: 'post',
          uri: node.uri,
          ...parent,
          ...rootUri,
          view: outcome.view,
        }
      case 'restored':
        return {
          kind: 'post',
          uri: node.uri,
          ...parent,
          ...rootUri,
          view: outcome.view,
          restored: true,
        }
      case 'gap':
        return {
          kind: 'gap',
          uri: node.uri,
          ...parent,
          gap: outcome.gap,
          ...(outcome.list
            ? {list: outcome.list, listUri: outcome.list.uri}
            : outcome.listUri
              ? {listUri: outcome.listUri}
              : {}),
          bridging,
        }
      default:
        /*
         * Not read: a node held since the read started (an optimistic
         * reply) stays; anything else fails closed.
         */
        if (held) return undefined
        return {
          kind: 'gap',
          uri: node.uri,
          ...parent,
          gap: 'content-stripped',
          bridging,
        }
    }
  }
  if (held?.kind === 'post' && isWorseGap(node.gap, bridging)) {
    return node.parentUri && node.parentUri !== held.parentUri
      ? {...held, parentUri: node.parentUri}
      : undefined
  }
  return {
    kind: 'gap',
    uri: node.uri,
    ...parent,
    gap: node.gap,
    ...(node.listUri ? {listUri: node.listUri} : {}),
    bridging,
  }
}

/**
 * Merge one checked response into `base` (7.2 step 2). `outcomes` holds the
 * public-view pass for {@link postUrisToRead}'s URIs. Returns new maps;
 * `base` is not changed, and every held view object is carried by
 * reference.
 */
export function mergeLensNodes(
  base: MergeBase,
  checked: readonly CheckedNode[],
  {
    request,
    bridging,
    outcomes,
  }: {
    request: MergeRequest
    bridging: string
    outcomes: ReadonlyMap<string, PublicOutcome>
  },
): MergeResult {
  const nodes = new Map(base.nodes)
  const markers = new Map(base.markers)
  const hidden = new Set(base.hidden)
  const added = new Set<string>()
  const gaps = new Map<string, string>()
  const newViews: PostView[] = []
  const context = {
    subtree:
      request.kind === 'replies'
        ? subtreeOf(request.anchor, checked)
        : new Set<string>(),
    top: request.kind === 'parents' ? checked[0]?.uri : undefined,
  }
  for (const node of checked) {
    const held = nodes.get(node.uri)
    const wasHeld = base.nodes.has(node.uri) || held !== undefined
    if (!held) added.add(node.uri)
    const next = effectiveNode(node, held, outcomes.get(node.uri), bridging)
    if (next) {
      nodes.set(node.uri, next)
      if (
        next.kind === 'post' &&
        next.view !== (held as {view?: unknown})?.view
      ) {
        newViews.push(next.view)
      }
    }
    const current = nodes.get(node.uri)
    if (current?.kind === 'gap') gaps.set(node.uri, current.gap)
    else gaps.delete(node.uri)
    if (node.hidden) hidden.add(node.uri)
    const nextMarks = nextMarkers(
      node,
      markers.get(node.uri),
      wasHeld,
      request,
      context,
    )
    if (markersEmpty(nextMarks)) markers.delete(node.uri)
    else markers.set(node.uri, nextMarks!)
  }
  return {
    nodes,
    markers,
    hidden,
    added,
    gaps: Array.from(gaps.entries()),
    newViews,
  }
}

/** The lens tree on a merged map (step 3). */
export type LensTree = {
  /** The parent chain, the top first, without the anchor. */
  chain: LensNode[]
  anchor: LensNode | undefined
  /** The children of every node, by its URI, in map order. */
  children: ReadonlyMap<string, LensNode[]>
}

/**
 * Link the map into a tree around `anchorUri`. The chain goes up
 * `parentUri` while the parent is held, so a node whose parent is absent is
 * the top. Replies attach by `parentUri`; one whose parent is not reachable
 * from the anchor is never walked, which drops it with its subtree.
 */
export function lensTree(
  nodes: ReadonlyMap<string, LensNode>,
  anchorUri: string,
): LensTree {
  const anchor = nodes.get(anchorUri)
  const chain: LensNode[] = []
  const onChain = new Set<string>([anchorUri])
  let parentUri = anchor?.parentUri
  while (parentUri && !onChain.has(parentUri)) {
    const parent = nodes.get(parentUri)
    if (!parent) break
    chain.unshift(parent)
    onChain.add(parentUri)
    parentUri = parent.parentUri
  }
  const children = new Map<string, LensNode[]>()
  for (const node of nodes.values()) {
    if (onChain.has(node.uri) || !node.parentUri) continue
    const list = children.get(node.parentUri)
    if (list) list.push(node)
    else children.set(node.parentUri, [node])
  }
  return {chain, anchor, children}
}

/** The view a node renders, when it has one. */
export function viewOf(node: LensNode | undefined): PostView | undefined {
  return node && node.kind !== 'gap' ? node.view : undefined
}

/**
 * The thread's root URI as 7.3 finds it: the first `rootUri` any post node
 * carries, else the `reply.root.uri` of any held view's record, else the
 * chain's top when it is a post with no reply.
 */
export function lensRootUri(
  nodes: ReadonlyMap<string, LensNode>,
  top?: LensNode,
): string | undefined {
  for (const node of nodes.values()) {
    if (node.kind === 'post' && node.rootUri) return node.rootUri
  }
  for (const node of nodes.values()) {
    const record = viewOf(node)?.record as
      {reply?: {root?: {uri?: unknown}}} | undefined
    const uri = record?.reply?.root?.uri
    if (typeof uri === 'string') return uri
  }
  const topView = viewOf(top)
  if (topView && !(topView.record as {reply?: unknown}).reply) {
    return topView.uri
  }
  return undefined
}
