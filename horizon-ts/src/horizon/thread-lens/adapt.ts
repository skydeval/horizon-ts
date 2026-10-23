/*
 * The lens `select` (Phase 4 design 7.1 to 7.5): the stock
 * `getPostThreadV2` answer built from a lens snapshot, so Bluesky's
 * traversal, moderation and components render it unchanged.
 *
 * - Gaps are placeholder post items (7.3, TL-8): an empty `cid`, the epoch,
 *   replies and quotes disabled, recorded in a module `WeakMap` so the
 *   screen draws an item as a gap only when its post has an empty `cid` and
 *   the map holds that very object. Placeholders exist only in this output,
 *   never in a cache entry.
 * - Sort, branching and the depth cut at the rendered `below` are applied
 *   here (7.4): prism has neither `sort` nor `branchingFactor`, and the key
 *   carries the request depth, so a sort change or a resize makes no
 *   request.
 * - The answer's top-level threadgate carries prism's hidden flags in its
 *   record (7.5), so every stock reader of "hidden by the threadgate"
 *   agrees.
 * - Every output under a lens key carries `lensState` (4.3), the data kind
 *   and what the lens rows and notice need.
 * - Output is cached per input and settings (R2-N14): the same snapshot
 *   under the same settings gives the same thread array, the same held
 *   view objects and the same placeholders, so shadows keyed by identity
 *   apply and nothing is refilled per render. Nothing in the snapshot is
 *   changed.
 */

import {AtUri} from '@atproto/syntax'

import {LINEAR_VIEW_BF, TREE_VIEW_BF} from '#/state/queries/usePostThread/const'
import {type UsePostThreadQueryResult} from '#/state/queries/usePostThread/types'
import {getThreadgateRecord} from '#/state/queries/usePostThread/utils'
import {THREAD_LENS} from '#/horizon/switches'
import {
  type LensNode,
  lensRootUri,
  lensTree,
  viewOf,
} from '#/horizon/thread-lens/nodes'
import {
  fallbackOf,
  LENS_ROOT,
  type LensFallbackTag,
  type LensForm,
  type LensNote,
  type LensSnapshot,
  snapshotOf,
  stopKey,
} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView
type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem
type ThreadgateView = NonNullable<UsePostThreadQueryResult['threadgate']>

/** The epoch, for a placeholder's required times (7.3). */
export const LENS_EPOCH = new Date(0).toISOString()

/** The view settings `select` builds for (7.4). */
export type LensSelectSettings = {
  sort: string | undefined
  view: 'tree' | 'linear'
  /** The rendered depth bound (7.4), not the request depth. */
  below: number
  /** The entry's query hash, for the rows' queue (7.1). */
  queueId?: string
}

/** What the gap row needs about a placeholder (7.3, 8). */
export type GapInfo = {
  uri: string
  gap: string
  /** The list a `blocked-by-you` gap names (8.3). */
  listUri?: string
  /** The list view, when the public view carried it (6.3). */
  list?: app.bsky.graph.defs.ListViewBasic
  /** Whether "Retry" applies (8.1); never on a gap-only screen. */
  retryable: boolean
  form: LensForm
}

const placeholders = new WeakMap<PostView, GapInfo>()

/**
 * The gap a placeholder stands for: only when the post's `cid` is empty
 * and the map holds that very object (7.3), so a real post is never drawn
 * as a gap.
 */
export function gapInfoOf(post: PostView): GapInfo | undefined {
  return post.cid === '' ? placeholders.get(post) : undefined
}

/** The data kind on a thread answer (4.3). */
export type LensStateKind =
  'stock' | 'snapshot' | 'fallback' | 'gap-only' | 'unverified' | 'placeholder'

/** The screen's `bridging` as the notice reads it (10). */
export type LensBridging = 'full' | 'limited' | 'off'

/** A row `select` drew in place (9.2; v6: R4-L3). */
export type LensMarkerRow = {kind: 'parents' | 'replies'}

/** The lens part of a thread answer (4.3). */
export type LensState = {
  kind: LensStateKind
  /** The note to show: a failure, a fallback reason, a gap-only case. */
  note?: LensNote
  bridging?: LensBridging
  /** Every gap URI drawn, for the marked read-more rows (8.4). */
  gapUris: ReadonlySet<string>
  /** The rows drawn in place, by URI. Empty outside a snapshot. */
  markers: ReadonlyMap<string, LensMarkerRow>
  /** A fallback read for another `sort` or `below` (TL-36). */
  fallbackStale: boolean
  /** The entry's query hash, on a snapshot only. */
  queueId?: string
}

const NO_URIS: ReadonlySet<string> = new Set()
const NO_MARKERS: ReadonlyMap<string, LensMarkerRow> = new Map()

/** The state under a stock key, or with the switch off. */
export const STOCK_LENS_STATE: LensState = {
  kind: 'stock',
  gapUris: NO_URIS,
  markers: NO_MARKERS,
  fallbackStale: false,
}

/** The state while placeholder data shows under a lens key. */
export const PLACEHOLDER_LENS_STATE: LensState = {
  ...STOCK_LENS_STATE,
  kind: 'placeholder',
}

/** A `select` output under a lens key. */
export type LensSelected = UsePostThreadQueryResult & {lensState: LensState}

function didOf(uri: string | undefined): string | undefined {
  if (!uri) return undefined
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

const TID = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/
const S32 = '234567abcdefghijklmnopqrstuvwxyz'

/**
 * The creation time of a record key that is a TID, in ms (a gap has no
 * time, 7.4); `undefined` for any other key.
 */
export function tidTimeMs(uri: string): number | undefined {
  const rkey = uri.split('/').pop() ?? ''
  if (!TID.test(rkey)) return undefined
  /*
   * 13 characters carry 65 bits: a pad bit, the TID's zero bit, the 53-bit
   * microsecond timestamp and the 10-bit clock id. The first 11 characters
   * (55 bits) are the two zero bits and the timestamp.
   */
  let value = 0
  for (let i = 0; i < 11; i++) value = value * 32 + S32.indexOf(rkey[i])
  return Math.floor(value / 1000)
}

function timeOfView(view: PostView): number | undefined {
  const createdAt = (view.record as {createdAt?: unknown}).createdAt
  const created =
    typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN
  if (!Number.isNaN(created)) return created
  const indexed = Date.parse(view.indexedAt)
  return Number.isNaN(indexed) ? undefined : indexed
}

function timeOf(node: LensNode): number | undefined {
  const view = viewOf(node)
  return view ? timeOfView(view) : tidTimeMs(node.uri)
}

function byUri(a: LensNode, b: LensNode): number {
  return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0
}

/** Oldest first (or newest), nodes with no time last, ties by URI. */
function byTime(newest: boolean) {
  return (a: LensNode, b: LensNode) => {
    const ta = timeOf(a)
    const tb = timeOf(b)
    if (ta === undefined || tb === undefined) {
      if (ta !== tb) return ta === undefined ? 1 : -1
      return byUri(a, b)
    }
    if (ta !== tb) return newest ? tb - ta : ta - tb
    return byUri(a, b)
  }
}

/**
 * Siblings in `sort` order (7.4). The reader's optimistic replies come
 * first, where stock inserts them. `newest` and `oldest` by time, gaps by
 * their record key's TID. `top` by likes, then oldest first, gaps after
 * posts, and under the anchor private subtrees first (H-3).
 */
function sortSiblings(
  nodes: readonly LensNode[],
  sort: string | undefined,
  underAnchor: boolean,
): LensNode[] {
  const optimistic = nodes.filter(node => node.kind === 'optimistic')
  const rest = nodes.filter(node => node.kind !== 'optimistic')
  if (sort === 'newest' || sort !== 'top') {
    return [...optimistic, ...rest.sort(byTime(sort === 'newest'))]
  }
  const oldest = byTime(false)
  const privateFirst = underAnchor
    ? rest.filter(node => node.kind === 'private').sort(oldest)
    : []
  const posts = rest
    .filter(
      node => node.kind === 'post' || (!underAnchor && node.kind === 'private'),
    )
    .sort((a, b) => {
      const likes = (viewOf(b)?.likeCount ?? 0) - (viewOf(a)?.likeCount ?? 0)
      return likes !== 0 ? likes : oldest(a, b)
    })
  const gaps = rest.filter(node => node.kind === 'gap').sort(oldest)
  return [...optimistic, ...privateFirst, ...posts, ...gaps]
}

/** A placeholder post view for a gap node (7.3, R1-L11). */
function placeholderView(
  node: Extract<LensNode, {kind: 'gap'}>,
  rootUri: string | undefined,
  replyCount: number,
): PostView {
  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text: '',
    createdAt: LENS_EPOCH,
  }
  if (node.parentUri) {
    record.reply = {
      parent: {uri: node.parentUri, cid: ''},
      root: {uri: rootUri ?? node.parentUri, cid: ''},
    }
  }
  return {
    uri: node.uri,
    cid: '',
    author: {did: didOf(node.uri) ?? '', handle: 'handle.invalid'},
    record,
    indexedAt: LENS_EPOCH,
    replyCount,
    repostCount: 0,
    likeCount: 0,
    quoteCount: 0,
    labels: [],
    viewer: {replyDisabled: true, embeddingDisabled: true},
  } as unknown as PostView
}

function isRetryable(
  node: Extract<LensNode, {kind: 'gap'}>,
  form: LensForm,
): boolean {
  if (form !== 'snapshot') return false
  if (node.gap === 'block-state-unknown') return true
  if (node.gap === 'upstream-unavailable') return true
  return node.gap === 'blocked' && node.bridging !== 'full'
}

function postItem(
  view: PostView,
  depth: number,
  {
    moreParents,
    moreReplies,
    opThread,
    hidden,
  }: {
    moreParents: boolean
    moreReplies: number
    opThread: boolean
    hidden: boolean
  },
): ThreadItem {
  return {
    uri: view.uri,
    depth,
    value: {
      $type: 'app.bsky.unspecced.defs#threadItemPost',
      post: view,
      moreParents,
      moreReplies,
      opThread,
      hiddenByThreadgate: hidden,
      mutedByViewer: !!view.author.viewer?.muted,
    },
  }
}

/** The `bridging` of a snapshot as the notice reads it (10). */
function bridgingOf(list: readonly string[]): LensBridging | undefined {
  if (list.length === 0) return undefined
  // Only the main response's `off` is the "as it normally appears" case.
  if (list[0] === 'off') return 'off'
  return list.every(value => value === 'full') ? 'full' : 'limited'
}

/**
 * The answer's top-level threadgate (7.5): the root post node's real gate
 * with the flags joined into its `hiddenReplies`, or a record of the flags
 * alone (no `allow`, so no reply restriction), or none.
 */
function emittedThreadgate(
  snapshot: LensSnapshot,
  rootUri: string | undefined,
): ThreadgateView | undefined {
  const root = rootUri ? snapshot.nodes.get(rootUri) : undefined
  const gate = root?.kind === 'post' ? root.view.threadgate : undefined
  const record = gate ? getThreadgateRecord(gate) : undefined
  const flags = Array.from(snapshot.hidden)
  if (gate && record) {
    if (flags.length === 0) return gate as ThreadgateView
    const union = Array.from(
      new Set([...(record.hiddenReplies ?? []), ...flags]),
    )
    return {
      ...gate,
      record: {...record, hiddenReplies: union},
    } as ThreadgateView
  }
  if (flags.length === 0 || !rootUri) return undefined
  return {
    record: {
      $type: 'app.bsky.feed.threadgate',
      post: rootUri,
      createdAt: LENS_EPOCH,
      hiddenReplies: flags,
    },
  } as unknown as ThreadgateView
}

/** The stock answer for `snapshot` under `settings` (7.2 to 7.5). */
function buildFromSnapshot(
  snapshot: LensSnapshot,
  settings: LensSelectSettings,
): LensSelected {
  const {sort, view, below} = settings
  const form = snapshot.form
  const inPlace = form === 'snapshot'
  // prism's anchor: the node map is keyed by DID-form URIs (5.2).
  const {chain, anchor, children} = lensTree(
    snapshot.nodes,
    snapshot.anchor.prismAnchor,
  )
  const thread: ThreadItem[] = []
  const markers = new Map<string, LensMarkerRow>()
  const gapUris = new Set<string>()
  const top = chain[0] ?? anchor
  const rootUri = lensRootUri(snapshot.nodes, top)
  const rootAuthor = didOf(rootUri)
  const branchingFactor = view === 'linear' ? LINEAR_VIEW_BF : TREE_VIEW_BF

  const markerOf = (uri: string) =>
    inPlace ? snapshot.markers.get(uri) : undefined

  /** "Load earlier posts" on the top only, its parent absent (R2-L1). */
  const asksUp = (node: LensNode) => {
    if (node !== top || !markerOf(node.uri)?.moreParents) return false
    if (snapshot.stopped.has(stopKey('parents', node.uri))) return false
    if (node.parentUri && snapshot.nodes.has(node.parentUri)) return false
    markers.set(node.uri, {kind: 'parents'})
    return true
  }

  const isOp = (node: LensNode) => {
    const nodeView = viewOf(node)
    return !!nodeView && !!rootAuthor && nodeView.author.did === rootAuthor
  }

  const emit = (
    node: LensNode,
    depth: number,
    options: {moreParents: boolean; moreReplies: number; opThread: boolean},
    attached: number,
  ) => {
    const hidden = snapshot.hidden.has(node.uri)
    if (node.kind === 'gap') {
      gapUris.add(node.uri)
      const replyCount = attached + (markerOf(node.uri)?.moreReplies ? 1 : 0)
      const placeholder = placeholderView(node, rootUri, replyCount)
      placeholders.set(placeholder, {
        uri: node.uri,
        gap: node.gap,
        ...(node.listUri ? {listUri: node.listUri} : {}),
        ...(node.list ? {list: node.list} : {}),
        retryable: isRetryable(node, form),
        form,
      })
      thread.push(postItem(placeholder, depth, {...options, hidden}))
      return
    }
    thread.push(postItem(node.view, depth, {...options, hidden}))
  }

  /** The replies of `parent`, at `depth`, depth-first (7.4). */
  const emitReplies = (
    level: readonly LensNode[],
    depth: number,
    parentOp: boolean,
  ) => {
    for (const node of sortSiblings(level, sort, depth === 1)) {
      const own = children.get(node.uri) ?? []
      const marker =
        markerOf(node.uri)?.moreReplies &&
        !snapshot.stopped.has(stopKey('replies', node.uri))
      const op = parentOp && isOp(node)
      if (depth < below) {
        const sorted = sortSiblings(own, sort, false)
        const kept =
          branchingFactor === undefined
            ? sorted
            : sorted.slice(0, branchingFactor)
        let moreReplies = own.length - kept.length
        if (marker) {
          moreReplies++
          markers.set(node.uri, {kind: 'replies'})
        }
        emit(
          node,
          depth,
          {moreParents: false, moreReplies, opThread: op},
          own.length,
        )
        emitReplies(kept, depth + 1, op)
      } else {
        // Too deep (TL-21): the stock read-more row, which opens the post.
        const moreReplies = own.length + (marker ? 1 : 0)
        emit(
          node,
          depth,
          {moreParents: false, moreReplies, opThread: op},
          own.length,
        )
      }
    }
  }

  if (anchor) {
    let opSoFar = !!top && top.uri === rootUri
    chain.forEach((node, i) => {
      opSoFar = opSoFar && isOp(node)
      emit(
        node,
        i - chain.length,
        {moreParents: asksUp(node), moreReplies: 0, opThread: opSoFar},
        0,
      )
    })
    opSoFar = opSoFar && isOp(anchor)
    const direct = children.get(anchor.uri) ?? []
    const anchorMarker =
      markerOf(anchor.uri)?.moreReplies &&
      !snapshot.stopped.has(stopKey('replies', anchor.uri))
    if (anchorMarker) markers.set(anchor.uri, {kind: 'replies'})
    emit(
      anchor,
      0,
      {
        moreParents: asksUp(anchor),
        moreReplies: anchorMarker ? 1 : 0,
        opThread: opSoFar,
      },
      direct.length,
    )
    // Every direct reply of the anchor is kept; branching applies below.
    if (below > 0) emitReplies(direct, 1, opSoFar)
  }

  const threadgate = inPlace ? emittedThreadgate(snapshot, rootUri) : undefined
  return {
    thread,
    ...(threadgate ? {threadgate} : {}),
    hasOtherReplies: !!snapshot.privateCursor,
    lensState: {
      kind: form,
      ...(snapshot.failure
        ? {note: snapshot.failure}
        : snapshot.note
          ? {note: snapshot.note}
          : {}),
      ...(inPlace ? {bridging: bridgingOf(snapshot.bridging)} : {}),
      gapUris,
      markers: inPlace ? markers : NO_MARKERS,
      fallbackStale: false,
      ...(inPlace && settings.queueId ? {queueId: settings.queueId} : {}),
    },
  }
}

function fallbackNote(tag: LensFallbackTag): LensNote | undefined {
  if (tag.fallback === 'refused') return undefined
  return {
    reason: tag.fallback,
    ...(tag.retryAt !== undefined ? {retryAt: tag.retryAt} : {}),
    autoRetry: tag.autoRetry,
  }
}

function settingsKey(settings: LensSelectSettings): string {
  return `${settings.sort ?? ''}|${settings.view}|${settings.below}|${settings.queueId ?? ''}`
}

const outputs = new WeakMap<object, Map<string, LensSelected>>()

function cached(
  input: object,
  key: string,
  build: () => LensSelected,
): LensSelected {
  let byKey = outputs.get(input)
  if (!byKey) {
    byKey = new Map()
    outputs.set(input, byKey)
  }
  let output = byKey.get(key)
  if (!output) {
    output = build()
    byKey.set(key, output)
  }
  return output
}

/**
 * The lens `select` (TH-14): a snapshot of any form becomes the stock
 * answer with `lensState`; a fallback gains `lensState` (a shallow copy,
 * its `thread` and `threadgate` the stored ones); anything else, the
 * placeholder data included, passes through.
 */
export function selectLensAnswer<T>(data: T, settings: LensSelectSettings): T {
  const snapshot = snapshotOf(data)
  if (snapshot) {
    return cached(snapshot, settingsKey(settings), () =>
      buildFromSnapshot(snapshot, settings),
    ) as unknown as T
  }
  const tag = fallbackOf(data)
  if (tag && typeof data === 'object' && data !== null) {
    const key = `${settings.sort ?? ''}|${settings.below}`
    return cached(data, key, () => {
      const note = fallbackNote(tag)
      return {
        ...(data as unknown as UsePostThreadQueryResult),
        lensState: {
          kind: 'fallback',
          ...(note ? {note} : {}),
          gapUris: NO_URIS,
          markers: NO_MARKERS,
          fallbackStale:
            tag.readWith.sort !== settings.sort ||
            tag.readWith.below !== settings.below,
        },
      }
    }) as unknown as T
  }
  return data
}

/**
 * The data kind and lens notes on the thread answer (TH-22, 4.3): `stock`
 * under a stock key or with the switch off, `placeholder` while placeholder
 * data shows under a lens key, else the `lensState` `select` attached.
 */
export function threadLensState(
  data: unknown,
  isPlaceholderData: boolean,
  queryKey: readonly unknown[],
): LensState {
  if (!THREAD_LENS || queryKey[0] !== LENS_ROOT) return STOCK_LENS_STATE
  if (isPlaceholderData) return PLACEHOLDER_LENS_STATE
  const state =
    typeof data === 'object' && data !== null
      ? (data as {lensState?: LensState}).lensState
      : undefined
  return state ?? STOCK_LENS_STATE
}
