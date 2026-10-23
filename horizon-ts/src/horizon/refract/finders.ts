/*
 * The restored posts the shadow and placeholder finders yield (refract
 * client design 5.6): the restored-post store's posts, the reader's own
 * replies under restored posts, and the posts of the `['refract-replies']`
 * queries. A like, repost or reply-count shadow then reaches a restored post
 * wherever it renders, and a tapped restored reply or quote renders at once
 * from the placeholder.
 */

import {type QueryClient} from '@tanstack/react-query'

import {findStoredPosts} from '#/horizon/refract/store'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** The `['refract-replies']` query root (4.2). */
export const REFRACT_REPLIES_ROOT = 'refract-replies'

/** Every restored post held outside stock queries whose URI is `uri`. */
export function* findRestoredPosts(
  queryClient: QueryClient,
  uri: string,
): Generator<PostView, void> {
  yield* findStoredPosts(uri)
  const datas = queryClient.getQueriesData<{posts?: unknown}>({
    queryKey: [REFRACT_REPLIES_ROOT],
  })
  for (const [, data] of datas) {
    if (!data || !Array.isArray(data.posts)) continue
    for (const post of data.posts as PostView[]) {
      if (post?.uri === uri) yield post
    }
  }
}
