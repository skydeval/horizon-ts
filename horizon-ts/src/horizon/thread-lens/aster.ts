/*
 * Aster nodes: one post fetched with `aster.getPost` for a Thread Lens
 * placeholder, drawn in the placeholder's place from prism's view as sent.
 *
 * - Only on the placeholder kinds in {@link ASTER_GAP_KINDS}, never on a
 *   kryphocron URI.
 * - The view is never run through the public-view pass and never written to
 *   a query cache: it lives in the row's own state, so no other screen or
 *   shadow finder sees it.
 * - The drawn copy is read-only: reply and embedding are disabled on it, and
 *   it is stamped so like, repost, quote and follow are hidden and their
 *   mutation queues refuse it (`refract/visitor.ts`).
 */

import {isPrivatePostUri} from '#/horizon/private/uri'
import {checkLensNode} from '#/horizon/thread-lens/nodes'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** The placeholder kinds that offer the aster action. */
export const ASTER_GAP_KINDS: ReadonlySet<string> = new Set([
  'blocked-by-you',
  'blocking-you',
  'blocked',
  'block-state-unknown',
])

/** Whether the placeholder `uri` of kind `gap` offers the aster action. */
export function offersAster(uri: string, gap: string): boolean {
  return ASTER_GAP_KINDS.has(gap) && !isPrivatePostUri(uri)
}

/**
 * Whether a blocked quote card of `uri` offers the aster action: a post's
 * URI only (a blocked feed or list card never does), never a kryphocron one.
 */
export function offersAsterQuote(uri: string): boolean {
  return /^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[^/]+$/.test(uri)
}

const stamped = new WeakSet<object>()

/**
 * An aster node as the quoted record a quote card draws (`#viewRecord`),
 * stamped like the view it came from.
 */
export function asterQuoteRecord(
  view: PostView,
): app.bsky.embed.record.ViewRecord {
  const record = {
    $type: 'app.bsky.embed.record#viewRecord',
    uri: view.uri,
    cid: view.cid,
    author: view.author,
    value: view.record,
    labels: view.labels ?? [],
    indexedAt: view.indexedAt,
    embeds: view.embed ? [view.embed] : [],
    likeCount: view.likeCount,
    repostCount: view.repostCount,
    replyCount: view.replyCount,
    quoteCount: view.quoteCount,
  } as unknown as app.bsky.embed.record.ViewRecord
  stamped.add(record)
  return record
}

/** Whether `view` is an aster copy (read-only). */
export function isAsterView(view: unknown): boolean {
  return typeof view === 'object' && view !== null && stamped.has(view)
}

/** What one aster answer gives the row. */
export type AsterOutcome =
  {kind: 'post'; view: PostView} | {kind: 'gap'; gap: string} | {kind: 'none'}

/**
 * Read prism's answer `node` for `uri`: a post node of that URI becomes a
 * stamped read-only copy of its view; a gap node its kind; anything else
 * nothing.
 */
export function asterOutcome(node: unknown, uri: string): AsterOutcome {
  const checked = checkLensNode(node)
  if (!checked || checked.uri !== uri) return {kind: 'none'}
  if (checked.type === 'gap') return {kind: 'gap', gap: checked.gap}
  const post = checked.post as unknown as PostView
  if (typeof post.cid !== 'string' || !post.author || !post.record) {
    return {kind: 'none'}
  }
  const view: PostView = {
    ...post,
    viewer: {
      ...post.viewer,
      replyDisabled: true,
      embeddingDisabled: true,
    },
  }
  stamped.add(view)
  return {kind: 'post', view}
}
