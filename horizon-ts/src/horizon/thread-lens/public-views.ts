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
 *   {@link withLensLabels}). The pass still runs for every reader: mutes,
 *   bookmarks and the viewer state prism does not hold come only from it.
 */

import {type Client} from '@atproto/lex'
import {AtUri} from '@atproto/syntax'

import {fetchPublicPosts} from '#/horizon/private/adapt/feed-view'
import {readRestored} from '#/horizon/refract/marker'
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
    entry.view.catch(() => {
      if (pool.get(uri) === entry) pool.delete(uri)
    })
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
 * The seam for skipping the pass on prism's hydrated view
 * (`threadLens.hydrated`, live; `threadLens.labelers`, live). Still empty,
 * for every reader, members included: with labels and a member's like,
 * repost, counts and `replyDisabled` in the lens answer, what only the pass
 * gives is the reader's mutes (`author.viewer.muted`, `mutedByList`: the
 * AppView's private state, which prism does not hold, and which Horizon has
 * no complete local copy of; `refract/relations.ts` reads at most 10 pages
 * and keeps them an hour), `viewer.bookmarked`, and `embeddingDisabled`
 * where prism stores no postgate. A view returned here renders as it is, so
 * filling the seam also needs those, and a labels read for the posts whose
 * lens labels can be prism's only (log, 2026-10-24).
 */
export function hydratedViewOf(_node: CheckedPost): PostView | undefined {
  return undefined
}

/**
 * The public-view pass over the post nodes of `checked` whose URI is in
 * `uris` (`postUrisToRead`). Throws when any `getPosts` batch fails. With
 * `did`, the early views waiting for that account are taken first. With
 * `lensLabels` (the answer's `readerLabels`), the views take the lens
 * answer's labels.
 */
export async function readPublicViews(
  appview: Client,
  checked: readonly CheckedNode[],
  uris: readonly string[],
  {did, lensLabels = false}: {did?: string; lensLabels?: boolean} = {},
): Promise<Map<string, PublicOutcome>> {
  const outcomes = new Map<string, PublicOutcome>()
  if (uris.length === 0) return outcomes
  const wanted = new Set(uris)
  const posts = new Map<string, CheckedPost>()
  for (const node of checked) {
    if (node.type !== 'post' || !wanted.has(node.uri)) continue
    const hydrated = hydratedViewOf(node)
    if (hydrated) {
      outcomes.set(node.uri, publicOutcomeOf(node, hydrated))
    } else {
      posts.set(node.uri, node)
    }
  }
  const now = Date.now()
  const early = new Map<string, Promise<PostView | undefined>>()
  const missing: string[] = []
  for (const uri of posts.keys()) {
    const view = did ? takeEarly(did, uri, now) : undefined
    if (view) early.set(uri, view)
    else missing.push(uri)
  }
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
    outcomes.set(uri, publicOutcomeOf(node, views.get(uri), {lensLabels}))
  }
  return outcomes
}
