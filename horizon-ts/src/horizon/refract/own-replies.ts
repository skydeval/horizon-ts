/*
 * The reader's own reply under a restored parent (refract client design 4.2
 * step 2): kept apart from `writes.ts` so the write path doesn't load the
 * shadow cache and its query modules.
 */

import {type QueryClient} from '@tanstack/react-query'

import {updatePostShadow} from '#/state/cache/post-shadow'
import {addOwnRestoredReply, peekRestoredPost} from '#/horizon/refract/store'
import {resolvedViaRestoredParent} from '#/horizon/refract/writes'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

/**
 * After a reply is posted (the composer's AppView wait returned it): when its
 * parent resolved through the fallback, record the reply in the store's
 * own-replies set and bump the parent's reply count through its shadow.
 */
export function noteOwnRestoredReply(
  queryClient: QueryClient,
  parentUri: string | undefined,
  posts: readonly {value: unknown}[] | undefined,
) {
  if (!parentUri || !resolvedViaRestoredParent(parentUri)) return
  const first = posts?.[0]?.value
  if (!bsky.isType(app.bsky.unspecced.defs.threadItemPost, first)) return
  addOwnRestoredReply(first.post)
  const parent = peekRestoredPost(parentUri)
  updatePostShadow(queryClient, parentUri, {
    optimisticReplyCount: (parent?.replyCount ?? 0) + 1,
  })
}
