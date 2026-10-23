/*
 * One load of a private search (2H design 11.3): up to
 * {@link SEARCH_PAGES_PER_LOAD} prism pages, adapted. Kept out of
 * `results.ts` so it imports no session or React module.
 */

import {logger} from '#/logger'
import {
  type PrivatePostView,
  privatePostView,
} from '#/horizon/lexicons/nearhorizon'
import {adaptPosts, type PrivateSource} from '#/horizon/private/adapt/feed-view'
import {searchPrivatePosts} from '#/horizon/private/api/reads'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {resolvePrivateQuotes} from '#/horizon/private/quotes/resolve'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/**
 * prism pages one load reads at most while they come back empty.
 */
export const SEARCH_PAGES_PER_LOAD = 3

/**
 * Posts per prism page.
 */
export const SEARCH_PAGE_LIMIT = 25

export type PrivateSearchPage = {
  posts: PostView[]
  cursor?: string
  /** When the load completed (the load gate's stamp, prism busy design 4.1). */
  fetchedAt?: number
}

/**
 * One load of a private search from `cursor`: up to
 * {@link SEARCH_PAGES_PER_LOAD} pages until one has a post, adapted, with the
 * private posts they quote resolved.
 */
export async function fetchPrivateSearchLoad(
  source: PrivateSource,
  q: string,
  cursor: string | undefined,
): Promise<PrivateSearchPage> {
  const loaded = await fetchUntilItems<PrivatePostView>(
    async next => {
      const page = await searchPrivatePosts(source.prism, {
        q,
        sort: 'latest',
        limit: SEARCH_PAGE_LIMIT,
        cursor: next,
      })
      return {
        items: page.posts.filter((item): item is PrivatePostView => {
          const ok = privatePostView.matches(item)
          if (!ok) logger.warn('private search: an item was dropped')
          return ok
        }),
        cursor: page.cursor,
      }
    },
    cursor,
    {maxPages: SEARCH_PAGES_PER_LOAD},
  )
  const {views} = await adaptPosts(
    loaded.items.map(view => ({view})),
    source.appview,
    () => undefined,
  )
  const posts = loaded.items
    .map(view => views.get(view.uri))
    .filter((post): post is PostView => !!post)
  await resolvePrivateQuotes(posts)
  return {posts, cursor: loaded.cursor}
}
