/*
 * The public-view pass (Phase 4 design 6, TL-5, TL-6): every public post
 * node is read again from the reader's public AppView with `getPosts`, and
 * that view is what renders, so labels, mutes, like state and warnings work
 * as on the stock thread. prism's view only places the post in the tree.
 *
 * - Post nodes only: never a gap URI, never a private URI, never an
 *   embedded record. The caller passes the URIs `postUrisToRead` gives.
 * - Strict: a failed batch fails the read (6.4), through
 *   `fetchPublicPosts(..., {strict: true})`.
 * - Disagreements (6.3): a block flag on the public view gives that block's
 *   gap; a post the AppView leaves out is `content-stripped`.
 * - The restored exception (6.3, S-15): a post node whose prism view carries
 *   a readable `restored` marker renders from prism's view where the AppView
 *   leaves it out or returns it with Bluesky's `!takedown` or `!hide`. The
 *   block rows still come first. One reader of the marker, `readRestored`.
 * - The reader's labels (prism `threadLens.labelers`, `labelers.ts`): when
 *   the lens answer carries every labeler the call named, a post's labels
 *   and its author's are prism's, the lens answer's; the pass's own labels
 *   are added after them only where prism's lack them (see
 *   {@link withLensLabels}).
 * - Members skip it (2026-10-25): with an answer served as `member`, the
 *   reader's labels applied and the reader's mutes whole on the device
 *   (`mutes/cache.ts`), a post node whose prism view is whole
 *   ({@link isHydratedSafe}) renders from that view with the device's
 *   mutes applied ({@link hydratedViewOf}), and only the rest go to
 *   `getPosts`. Visitors, and members without those, keep the pass for
 *   every post.
 */

import {type Client} from '@atproto/lex'
import {AtUri} from '@atproto/syntax'
import {type QueryClient} from '@tanstack/react-query'

import {
  getMuteCache,
  muteCacheGate,
  type MuteLookup,
} from '#/horizon/mutes/cache'
import {fetchPublicPosts} from '#/horizon/private/adapt/feed-view'
import {readRestored} from '#/horizon/refract/marker'
import {
  noteEmbeddingChecked,
  noteEmbeddingUnchecked,
} from '#/horizon/thread-lens/embedding'
import {
  type CheckedNode,
  type CheckedPost,
  type PublicOutcome,
} from '#/horizon/thread-lens/nodes'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bluesky's labels that end a post's showing, which a restore stands in for. */
const STRIPPING_LABELS = new Set(['!takedown', '!hide'])

function hasStrippingLabel(labels: unknown): boolean {
  return (
    Array.isArray(labels) &&
    labels.some(
      label => isObject(label) && STRIPPING_LABELS.has(label.val as string),
    )
  )
}

/** Whether the public view carries Bluesky's `!takedown` or `!hide`. */
function strippedUpstream(view: PostView): boolean {
  return hasStrippingLabel(view.labels) || hasStrippingLabel(view.author.labels)
}

/**
 * prism's view of a post node, when it is marked restored and complete
 * enough to render; otherwise `undefined`, and the stock rows apply.
 */
export function restoredViewOf(node: CheckedPost): PostView | undefined {
  const post = node.post
  if (!readRestored(post)) return undefined
  const author = post.author
  if (
    typeof post.cid !== 'string' ||
    typeof post.indexedAt !== 'string' ||
    !isObject(post.record) ||
    !isObject(author) ||
    typeof author.did !== 'string' ||
    typeof author.handle !== 'string'
  ) {
    return undefined
  }
  return post as unknown as PostView
}

/** Whether `uri` is an `app.bsky.graph.list` AT-URI. */
function isListUri(uri: string): boolean {
  try {
    return new AtUri(uri).collection === 'app.bsky.graph.list'
  } catch {
    return false
  }
}

/**
 * The block gap the public view's author state says, if any (6.3). A list
 * block names its list (8.3): the list view when the AppView carried one,
 * else the list URI stock puts in `blocking` for a block through a list
 * (its list view can be missing when the AppView could not read the list).
 */
function blockOutcome(view: PostView): PublicOutcome | undefined {
  const viewer = view.author.viewer
  if (viewer?.blockingByList) {
    return {kind: 'gap', gap: 'blocked-by-you', list: viewer.blockingByList}
  }
  if (viewer?.blocking && isListUri(viewer.blocking)) {
    return {kind: 'gap', gap: 'blocked-by-you', listUri: viewer.blocking}
  }
  if (viewer?.blocking) return {kind: 'gap', gap: 'blocked-by-you'}
  if (viewer?.blockedBy) return {kind: 'gap', gap: 'blocking-you'}
  return undefined
}

type Label = Record<string, unknown>

function labelsOf(value: unknown): Label[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

/** prism's rule (`same_label`): the same `src`, `uri`, `val` and `neg`. */
function sameLabel(a: Label, b: Label): boolean {
  return (
    a.src === b.src && a.uri === b.uri && a.val === b.val && !a.neg === !b.neg
  )
}

/** `first`'s labels, then those of `then` not among them. */
function mergedLabels(first: unknown, then: unknown): Label[] {
  const out = [...labelsOf(first)]
  for (const label of labelsOf(then)) {
    if (!out.some(held => sameLabel(held, label))) out.push(label)
  }
  return out
}

/**
 * The public view with the lens answer's labels on the post and its author
 * (`threadLens.labelers`), then any of the view's own that prism's lack.
 * prism's carry its own labels and the reader's labelers'; the view's are
 * kept after them because some posts reach the lens answer with prism's
 * labels only and nothing marks them (a post built from its record, an
 * account prism hosts while public indexing is on, a labels read prism could
 * not finish), and the pass's getPosts is sent with the reader's header
 * anyway. A quoted post's labels are the view's embed, as before.
 */
export function withLensLabels(view: PostView, node: CheckedPost): PostView {
  const author = isObject(node.post.author) ? node.post.author : {}
  return {
    ...view,
    labels: mergedLabels(node.post.labels, view.labels),
    author: {
      ...view.author,
      labels: mergedLabels(author.labels, view.author.labels),
    },
  } as PostView
}

/**
 * The outcome for one post node given the public AppView's answer (the
 * table of 6.3 and the restored exception). With `lensLabels`, a rendered
 * public view takes the lens answer's labels ({@link withLensLabels}).
 */
export function publicOutcomeOf(
  node: CheckedPost,
  view: PostView | undefined,
  {lensLabels = false}: {lensLabels?: boolean} = {},
): PublicOutcome {
  if (view) {
    const block = blockOutcome(view)
    if (block) return block
  }
  const restored = restoredViewOf(node)
  if (restored && (!view || strippedUpstream(view))) {
    return {kind: 'restored', view: restored}
  }
  if (view) {
    return {kind: 'view', view: lensLabels ? withLensLabels(view, node) : view}
  }
  return {kind: 'gap', gap: 'content-stripped'}
}

/*
 * The early views (speed pass, 2026-10-23): a read started early (the
 * press-in pre-warm, or the anchor and its cached parents at the start of a
 * read, `fetch.ts`) puts its `getPosts` here, in flight, and the pass after
 * `getThread` takes each view from it once instead of asking again, so the
 * pass only fetches what it lacks. Nothing the pass fetches itself is kept:
 * every read (a refresh included) gets views asked for during that read or
 * its press, never an earlier read's. An early request that failed is
 * dropped and its URIs are fetched by the pass itself, strictly (6.4); one
 * nothing takes is dropped after {@link LENS_VIEW_POOL_MS}.
 *
 * Only URIs the AppView itself already served as posts are warmed early
 * (the anchor and its parents found in the stock caches), never a URI known
 * only from prism, so no gap URI reaches the AppView (U-5).
 */

/** How long an early view waits to be taken. */
export const LENS_VIEW_POOL_MS = 15_000

type Pooled = {
  did: string
  at: number
  view: Promise<PostView | undefined>
  /** Set once the request answered. */
  answered?: {view: PostView | undefined}
}

const pool = new Map<string, Pooled>()

/** Tests: forget every early view. */
export function resetLensViewPool() {
  pool.clear()
}

function pooled(did: string, uri: string, now: number) {
  const entry = pool.get(uri)
  if (!entry) return undefined
  if (entry.did !== did || now - entry.at > LENS_VIEW_POOL_MS) {
    pool.delete(uri)
    return undefined
  }
  return entry
}

/**
 * Start the public views of `uris` for `did` now, unless an early view of
 * each is already waiting. For URIs the AppView already served as posts
 * only (see above).
 */
export function warmPublicViews(
  appview: Client,
  did: string,
  uris: Iterable<string>,
) {
  const now = Date.now()
  const missing = Array.from(new Set(uris)).filter(
    uri => !pooled(did, uri, now),
  )
  if (missing.length === 0) return
  const batch = fetchPublicPosts(appview, missing, {strict: true})
  for (const uri of missing) {
    const entry: Pooled = {did, at: now, view: batch.then(map => map.get(uri))}
    entry.view.then(
      view => {
        entry.answered = {view}
      },
      () => {
        if (pool.get(uri) === entry) pool.delete(uri)
      },
    )
    pool.set(uri, entry)
  }
}

/** The early view of `uri` for `did`, taken once. */
function takeEarly(did: string, uri: string, now: number) {
  const entry = pooled(did, uri, now)
  if (entry) pool.delete(uri)
  return entry?.view
}

/**
 * The early view of `uri` for `did` when it has already answered, taken
 * once; a member's post that can skip the pass waits for nothing.
 */
function takeAnswered(did: string, uri: string, now: number) {
  const entry = pooled(did, uri, now)
  if (!entry?.answered) return undefined
  pool.delete(uri)
  return entry.answered
}

/**
 * What lets a member's lens posts skip the pass (2026-10-25): the answer was
 * served as `member` with every labeler the call named applied, and the
 * device holds the reader's whole mute set. `bookmarked` says whether the
 * stock bookmarks cache holds a URI, as far as it was read.
 */
export type LensHydration = {
  mutes: MuteLookup
  bookmarked?: (uri: string) => boolean
}

/**
 * The hydration for an answer served as `servedAs`, with `readerLabels`,
 * for `did`; `undefined` (the pass for every post) for a visitor, an answer
 * whose labels are not the reader's, or with no whole mute set on the device.
 */
export function lensHydrationOf(
  did: string,
  {
    servedAs,
    readerLabels,
  }: {servedAs: string | undefined; readerLabels: boolean},
  bookmarked?: (uri: string) => boolean,
): LensHydration | undefined {
  if (servedAs !== 'member' || !readerLabels) return undefined
  const mutes = getMuteCache(did)
  if (!mutes || mutes.did !== did) return undefined
  return {mutes, ...(bookmarked ? {bookmarked} : {})}
}

/**
 * Why {@link lensHydrationOf} gave no hydration, for the timing log; the
 * first gate that closed. `undefined` when it gave one.
 */
export function lensHydrationGate(
  did: string,
  {
    servedAs,
    readerLabels,
  }: {servedAs: string | undefined; readerLabels: boolean},
): string | undefined {
  if (servedAs !== 'member') return `served as ${servedAs ?? 'nothing'}`
  if (!readerLabels) return "the reader's labels not applied"
  const mutes = getMuteCache(did)
  if (!mutes || mutes.did !== did) {
    return `mutes not whole on the device (${muteCacheGate(did) ?? 'unknown'})`
  }
  return undefined
}

/** Why a post node went to the pass ({@link passReasonOf}). */
export type PassReason =
  | 'restored'
  | 'missing fields'
  | 'no counts'
  | 'record embed'
  | 'unknown embed'
  | 'replyDisabled undecided'

/** The embeds whose posts' views are the pass's only (prism's edge 2). */
const RECORD_EMBEDS = new Set([
  'app.bsky.embed.record#view',
  'app.bsky.embed.recordWithMedia#view',
])

/** Embeds that carry no post, so no labels or viewer state of their own. */
const MEDIA_EMBEDS = new Set([
  'app.bsky.embed.images#view',
  'app.bsky.embed.external#view',
  'app.bsky.embed.video#view',
])

/**
 * Whether prism's view of `node` is whole enough to render for a member
 * without the pass. Kept to the pass:
 * - a post with no counts (prism built it from its record, so its labels and
 *   its author's can be prism's only: edge 1);
 * - a post with a record embed (the quoted post's labels and author state
 *   are prism's only: edge 2), or an embed of an unknown kind;
 * - a post whose `viewer.replyDisabled` prism could not decide (its root not
 *   a post node of the answer): the pass's is the AppView's;
 * - a post marked restored (the restored rule compares with the AppView);
 * - a view missing what renders (cid, record, time, author).
 * A post by an account prism hosts and a post whose labels read prism could
 * not finish are not marked by prism, so they skip with prism's labels (no
 * per-node marker yet; log, 2026-10-25).
 */
export function isHydratedSafe(node: CheckedPost): boolean {
  return passReasonOf(node) === undefined
}

/**
 * The first rule of {@link isHydratedSafe} that keeps `node` to the pass,
 * or `undefined` when prism's view can stand for it.
 */
export function passReasonOf(node: CheckedPost): PassReason | undefined {
  const post = node.post
  if (readRestored(post)) return 'restored'
  const author = post.author
  if (
    typeof post.cid !== 'string' ||
    typeof post.indexedAt !== 'string' ||
    !isObject(post.record) ||
    !isObject(author) ||
    typeof author.did !== 'string' ||
    typeof author.handle !== 'string'
  ) {
    return 'missing fields'
  }
  for (const count of ['likeCount', 'repostCount', 'replyCount']) {
    if (typeof post[count] !== 'number') return 'no counts'
  }
  if (post.embed !== undefined) {
    const type = isObject(post.embed) ? post.embed.$type : undefined
    if (typeof type === 'string' && RECORD_EMBEDS.has(type)) {
      return 'record embed'
    }
    if (typeof type !== 'string' || !MEDIA_EMBEDS.has(type)) {
      return 'unknown embed'
    }
  }
  const viewer = isObject(post.viewer) ? post.viewer : {}
  return typeof viewer.replyDisabled === 'boolean'
    ? undefined
    : 'replyDisabled undecided'
}

/** What one pass did, for the timing log: counts only. */
export type PublicPassStats = {
  /** Post nodes the pass was asked for. */
  asked: number
  /** Rendered from prism's view (member skip). */
  skipped: number
  /** Skipped, but the early view had answered and was used. */
  skippedEarly: number
  /** Kept to the pass, by the first reason ({@link passReasonOf}). */
  reasons: Partial<Record<PassReason | 'no hydration', number>>
  /** Taken from the early views. */
  early: number
  /** Asked of the AppView by the pass itself. */
  fetched: number
}

/** The stats as one log line. */
export function formatPassStats(stats: PublicPassStats): string {
  const reasons = Object.entries(stats.reasons)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ')
  const kept = stats.asked - stats.skipped
  return (
    `public pass: ${stats.asked} posts, ${stats.skipped} skipped` +
    (stats.skippedEarly ? ` (${stats.skippedEarly} from early views)` : '') +
    `, ${kept} to the pass` +
    (reasons ? ` (${reasons})` : '') +
    `, ${stats.early} early, ${stats.fetched} fetched`
  )
}

/**
 * prism's view of a member's post node with the reader's own state the
 * pass would have given, when it can skip the pass ({@link isHydratedSafe});
 * otherwise `undefined`.
 * - `author.viewer.muted` and `mutedByList` from the device's mute set,
 *   replacing prism's (which knows only mutes made through prism), so
 *   stock moderation hides and names them as on the stock thread.
 * - `viewer.bookmarked` when the stock bookmarks cache holds the post; a
 *   bookmark it has not read shows as not saved until the reader taps it.
 * - `embeddingDisabled`, when prism did not send it, is left out and the
 *   URI noted, so quoting it reads its postgate again at send
 *   (`embedding.ts`).
 * Labels are the lens answer's (prism's own and the reader's labelers').
 */
export function hydratedViewOf(
  node: CheckedPost,
  hydration: LensHydration | undefined,
): PostView | undefined {
  if (!hydration || !isHydratedSafe(node)) return undefined
  const post = node.post as unknown as PostView
  const mute = hydration.mutes.stateOf(post.author.did)
  const authorViewer = {...post.author.viewer, muted: mute.muted}
  if (mute.mutedByList) authorViewer.mutedByList = mute.mutedByList
  else delete authorViewer.mutedByList
  const viewer = {...post.viewer}
  if (hydration.bookmarked?.(post.uri)) viewer.bookmarked = true
  if (typeof viewer.embeddingDisabled === 'boolean') {
    noteEmbeddingChecked(post.uri)
  } else {
    noteEmbeddingUnchecked(post.uri)
  }
  return {
    ...post,
    author: {...post.author, viewer: authorViewer},
    viewer,
  }
}

/**
 * Whether the stock bookmarks cache (`useBookmarksQuery`, root `bookmarks`)
 * holds `uri`, as far as its pages were read. Read from the query client
 * by key, so this module stays free of the stock module and its session
 * import.
 */
export function bookmarkedInCache(qc: QueryClient, uri: string): boolean {
  for (const [, data] of qc.getQueriesData<{
    pages?: {bookmarks?: {subject?: {uri?: unknown}}[]}[]
  }>({queryKey: ['bookmarks']})) {
    for (const page of data?.pages ?? []) {
      if (page.bookmarks?.some(bookmark => bookmark.subject?.uri === uri)) {
        return true
      }
    }
  }
  return false
}

/**
 * The public-view pass over the post nodes of `checked` whose URI is in
 * `uris` (`postUrisToRead`). Throws when any `getPosts` batch fails. With
 * `did`, the early views waiting for that account are taken first. With
 * `lensLabels` (the answer's `readerLabels`), the views take the lens
 * answer's labels. With `hydration` (a member, {@link lensHydrationOf}),
 * a post node prism's view can stand for ({@link hydratedViewOf}) skips
 * the pass: it takes its early view only when that has already answered,
 * else prism's view; no `getPosts` is sent for it.
 */
export async function readPublicViews(
  appview: Client,
  checked: readonly CheckedNode[],
  uris: readonly string[],
  {
    did,
    lensLabels = false,
    hydration,
    onStats,
  }: {
    did?: string
    lensLabels?: boolean
    hydration?: LensHydration
    /** Called once with what the pass did (the timing log). */
    onStats?: (stats: PublicPassStats) => void
  } = {},
): Promise<Map<string, PublicOutcome>> {
  const outcomes = new Map<string, PublicOutcome>()
  const stats: PublicPassStats = {
    asked: 0,
    skipped: 0,
    skippedEarly: 0,
    reasons: {},
    early: 0,
    fetched: 0,
  }
  if (uris.length === 0) {
    onStats?.(stats)
    return outcomes
  }
  const wanted = new Set(uris)
  const posts = new Map<string, CheckedPost>()
  const now = Date.now()
  for (const node of checked) {
    if (node.type !== 'post' || !wanted.has(node.uri)) continue
    stats.asked++
    const hydrated = hydratedViewOf(node, hydration)
    if (!hydrated) {
      if (onStats) {
        const reason = hydration ? passReasonOf(node) : 'no hydration'
        if (reason) stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1
      }
      posts.set(node.uri, node)
      continue
    }
    stats.skipped++
    const early = did ? takeAnswered(did, node.uri, now) : undefined
    if (early) {
      stats.skippedEarly++
      // The AppView's own view, already here: as the pass would have it.
      if (early.view) noteEmbeddingChecked(node.uri)
      outcomes.set(node.uri, publicOutcomeOf(node, early.view, {lensLabels}))
    } else {
      outcomes.set(node.uri, publicOutcomeOf(node, hydrated))
    }
  }
  const early = new Map<string, Promise<PostView | undefined>>()
  const missing: string[] = []
  for (const uri of posts.keys()) {
    const view = did ? takeEarly(did, uri, now) : undefined
    if (view) early.set(uri, view)
    else missing.push(uri)
  }
  stats.early = early.size
  stats.fetched = missing.length
  onStats?.(stats)
  const views = new Map<string, PostView | undefined>()
  const retry: string[] = []
  const [fetched] = await Promise.all([
    fetchPublicPosts(appview, missing, {strict: true}),
    ...Array.from(early, async ([uri, view]) => {
      try {
        views.set(uri, await view)
      } catch {
        retry.push(uri)
      }
    }),
  ])
  for (const uri of missing) views.set(uri, fetched.get(uri))
  if (retry.length > 0) {
    const again = await fetchPublicPosts(appview, retry, {strict: true})
    for (const uri of retry) views.set(uri, again.get(uri))
  }
  for (const [uri, node] of posts) {
    if (views.get(uri)) noteEmbeddingChecked(uri)
    outcomes.set(uri, publicOutcomeOf(node, views.get(uri), {lensLabels}))
  }
  return outcomes
}
