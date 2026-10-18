/*
 * What the composer hands `onPostSuccess` after a private compose. The stock
 * composer waits for the public AppView to serve the new posts, which it
 * never will for a private post; this builds the same data from the pending
 * posts the write just recorded.
 */

import {type AtUriString} from '@atproto/syntax'

import {getPendingBatch} from '#/horizon/private/store'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {type app} from '#/lexicons'

/**
 * Success data for a private compose whose first URI is `postUri`: the
 * written posts as `getPostThreadV2` items, so an open private thread
 * inserts the reply as it does for public replies. `undefined` for a private
 * reply to a public post, which is not part of the public thread.
 */
export function privatePostSuccessData(
  replyToUri: string | undefined,
  postUri: string,
):
  | {
      replyToUri?: string
      posts: app.bsky.unspecced.getPostThreadV2.ThreadItem[]
    }
  | undefined {
  if (replyToUri && !isPrivatePostUri(replyToUri)) return undefined
  const batch = getPendingBatch(postUri)
  if (batch.length === 0) return undefined
  return {
    replyToUri,
    posts: batch.map((pending, depth) => ({
      uri: pending.uri as AtUriString,
      depth,
      value: {
        $type: 'app.bsky.unspecced.defs#threadItemPost',
        post: pending.postView,
        moreParents: false,
        moreReplies: 0,
        opThread: false,
        hiddenByThreadgate: false,
        mutedByViewer: false,
      },
    })),
  }
}
