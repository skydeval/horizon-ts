/*
 * The thread anchor's "Archived post" badge (`ThreadItemAnchor.tsx`). Stock
 * shows it when the record's `createdAt` is 24 h or more before the view's
 * `indexedAt`, Bluesky's first-seen time. A restored view's `indexedAt` is
 * when prism stored the post, often a backfill long after it was written, so
 * every older restored post would read as backdated. A view with the
 * restored marker gets no badge; every other view keeps stock's rule.
 *
 * prism fixed the cause on 2026-10-24 (`1697dac`: `indexedAt` is the earlier
 * of `createdAt` and its write time); the skip stays, harmless.
 */

import {readRestored} from '#/horizon/refract/marker'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

const BACKDATED_MS = 24 * 60 * 60 * 1000

/**
 * Whether the anchor shows the "Archived post" badge: stock's rule, skipped
 * on a restored view.
 */
export function showsArchivedBadge(post: app.bsky.feed.defs.PostView): boolean {
  if (readRestored(post)) return false
  const indexedAt = new Date(post.indexedAt)
  const createdAt = bsky.isType(app.bsky.feed.post, post.record)
    ? new Date(post.record.createdAt)
    : new Date(post.indexedAt)
  return indexedAt.getTime() - createdAt.getTime() > BACKDATED_MS
}
