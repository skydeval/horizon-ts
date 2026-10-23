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
 */

import {type Client} from '@atproto/lex'

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

/** The block gap the public view's author state says, if any (6.3). */
function blockOutcome(view: PostView): PublicOutcome | undefined {
  const viewer = view.author.viewer
  if (viewer?.blockingByList) {
    return {kind: 'gap', gap: 'blocked-by-you', list: viewer.blockingByList}
  }
  if (viewer?.blocking) return {kind: 'gap', gap: 'blocked-by-you'}
  if (viewer?.blockedBy) return {kind: 'gap', gap: 'blocking-you'}
  return undefined
}

/**
 * The outcome for one post node given the public AppView's answer (the
 * table of 6.3 and the restored exception).
 */
export function publicOutcomeOf(
  node: CheckedPost,
  view: PostView | undefined,
): PublicOutcome {
  if (view) {
    const block = blockOutcome(view)
    if (block) return block
  }
  const restored = restoredViewOf(node)
  if (restored && (!view || strippedUpstream(view))) {
    return {kind: 'restored', view: restored}
  }
  if (view) return {kind: 'view', view}
  return {kind: 'gap', gap: 'content-stripped'}
}

/**
 * The public-view pass over the post nodes of `checked` whose URI is in
 * `uris` (`postUrisToRead`). Throws when any `getPosts` batch fails.
 */
export async function readPublicViews(
  appview: Client,
  checked: readonly CheckedNode[],
  uris: readonly string[],
): Promise<Map<string, PublicOutcome>> {
  const outcomes = new Map<string, PublicOutcome>()
  if (uris.length === 0) return outcomes
  const wanted = new Set(uris)
  const posts = new Map<string, CheckedPost>()
  for (const node of checked) {
    if (node.type === 'post' && wanted.has(node.uri)) posts.set(node.uri, node)
  }
  const views = await fetchPublicPosts(appview, posts.keys(), {strict: true})
  for (const [uri, node] of posts) {
    outcomes.set(uri, publicOutcomeOf(node, views.get(uri)))
  }
  return outcomes
}
