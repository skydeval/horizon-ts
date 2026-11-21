/*
 * A blocked profile's tabs load nothing.
 *
 * The AppView refuses an author's feed (and likes) when either side blocks
 * the other, and the stock profile shows its block message from that error.
 * When the block is one only prism knows, the AppView serves the feed, so
 * the first page of every profile tab (Posts, Private, Replies, Media,
 * Videos, Likes) asks prism first and fails with the AppView's own error.
 */

import {XrpcResponseError} from '@atproto/lex'

import {type FeedAPI} from '#/lib/api/feed/types'
import {checkBlockWith} from '#/horizon/blocks/state'
import {app} from '#/lexicons'

/** The account a profile tab's feed descriptor reads, if it is one. */
export function profileFeedActor(feedDesc: string): string | undefined {
  const [kind, actor] = feedDesc.split('|')
  if ((kind === 'author' || kind === 'likes') && actor?.startsWith('did:')) {
    return actor
  }
  return undefined
}

/** The AppView's answer for a feed refused over a block. */
export function blockedFeedError(error: 'BlockedActor' | 'BlockedByActor') {
  const body = {
    error,
    message:
      error === 'BlockedActor'
        ? 'Requester has blocked actor'
        : 'Requester is blocked by actor',
  }
  const response = new Response(JSON.stringify(body), {
    status: 400,
    headers: {'content-type': 'application/json'},
  })
  return new XrpcResponseError(app.bsky.feed.getAuthorFeed.main, response, {
    encoding: 'application/json',
    body,
  } as never)
}

/** `api`, refused when its profile and the reader block each other. */
export function withBlockGate(feedDesc: string, api: FeedAPI): FeedAPI {
  const actor = profileFeedActor(feedDesc)
  if (!actor) return api
  return {
    peekLatest: () => api.peekLatest(),
    async fetch(params) {
      const blocked = await checkBlockWith(actor)
      if (blocked) throw blockedFeedError(blocked)
      return api.fetch(params)
    },
  }
}
