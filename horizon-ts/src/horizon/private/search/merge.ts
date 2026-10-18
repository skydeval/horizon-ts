/*
 * Private results merged into the stock search's post tabs (2H design 11,
 * H-2 as resolved): Top and Latest each list private and public results
 * together, gated only by who may see each post (prism reads every private
 * result for the reader).
 *
 * - Latest merges by time: both sides are newest first, and the heads are
 *   compared by their record's `createdAt` (else `indexedAt`).
 * - Top merges the private results, which prism answers in latest order (it
 *   has no ranking), into the public Top list at a fixed stride: one private
 *   result first, then one after every {@link TOP_PUBLIC_STRIDE} public
 *   results, so they are spread through the ranked list rather than stacked
 *   above it.
 *
 * Public results are never held back for private ones: prism's pages can be
 * empty for a long stretch, and a merge waiting on them would stall the
 * public list. While the public list has more to load, private results that
 * would sort after its last loaded result wait (`held`), and come in as the
 * public list grows or ends; a private load is asked for only when nothing
 * waits.
 */

import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/**
 * Public Top results between two private ones.
 */
export const TOP_PUBLIC_STRIDE = 2

function timeOf(post: PostView): number {
  const created = (post.record as {createdAt?: unknown}).createdAt
  const parsed = typeof created === 'string' ? Date.parse(created) : NaN
  if (!Number.isNaN(parsed)) return parsed
  const indexed = Date.parse(post.indexedAt)
  return Number.isNaN(indexed) ? 0 : indexed
}

/**
 * The merged list for `sort`, and how many private results wait for more
 * public ones.
 */
export function mergeSearchResults(
  publicPosts: PostView[],
  privatePosts: PostView[],
  {
    sort,
    publicHasMore,
  }: {sort: 'top' | 'latest' | undefined; publicHasMore: boolean},
): {posts: PostView[]; held: number} {
  if (privatePosts.length === 0) return {posts: publicPosts, held: 0}
  const posts: PostView[] = []
  let i = 0
  let j = 0
  if (sort === 'latest') {
    while (i < publicPosts.length || j < privatePosts.length) {
      if (j >= privatePosts.length) {
        posts.push(publicPosts[i++])
      } else if (i >= publicPosts.length) {
        if (publicHasMore) break
        posts.push(privatePosts[j++])
      } else if (timeOf(privatePosts[j]) > timeOf(publicPosts[i])) {
        posts.push(privatePosts[j++])
      } else {
        posts.push(publicPosts[i++])
      }
    }
  } else {
    let sincePrivate = TOP_PUBLIC_STRIDE
    while (i < publicPosts.length || j < privatePosts.length) {
      const privateTurn = sincePrivate >= TOP_PUBLIC_STRIDE
      if (j < privatePosts.length && (privateTurn || i >= publicPosts.length)) {
        if (!privateTurn && publicHasMore) break
        posts.push(privatePosts[j++])
        sincePrivate = 0
      } else if (i < publicPosts.length) {
        posts.push(publicPosts[i++])
        sincePrivate++
      } else {
        break
      }
    }
  }
  return {posts, held: privatePosts.length - j}
}
