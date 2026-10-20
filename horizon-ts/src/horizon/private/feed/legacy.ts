/*
 * Private posts on the legacy feed query (`src/state/queries/post-feed.ts`),
 * which serves profile feeds: the Private tab (6.4), the Posts and Replies
 * merges (6.3.1) and the pinned private post on the Posts tab (6.5).
 * The Media and Videos tabs merge the profile's private media while prism
 * lists `private.mediaFilters` (change list item 4). The owner's Likes tab
 * merges their liked private posts (change list item 5, `likes-merge.ts`). Following on the legacy path (the Following v2 flag
 * off) shows no private posts. For a member, every legacy feed's pages come
 * back with the private posts they quote resolved (`quotes/resolve.ts`).
 */

import {type AtIdentifierString} from '@atproto/syntax'

import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {logger} from '#/logger'
import {
  type AdaptInput,
  isOwnItem,
  pendingAsInput,
  type PrivateSource,
  toFeedViewPosts,
} from '#/horizon/private/adapt/feed-view'
import {
  getPrivateAuthorFeed,
  getPrivatePosts,
} from '#/horizon/private/api/reads'
import {PrivateAuthorMergeFeedAPI} from '#/horizon/private/feed/author-merge'
import {privateTabDid} from '#/horizon/private/feed/keys'
import {
  LIKE_RECORDS_PAGE_LIMIT,
  PrivateLikesMergeFeedAPI,
} from '#/horizon/private/feed/likes-merge'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {withPrivateQuotes} from '#/horizon/private/quotes/resolve'
import {privateMediaFiltersServed} from '#/horizon/private/server-support'
import {getPendingPosts} from '#/horizon/private/store'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {getCurrentPdsClient} from '#/horizon/routing/current-clients'
import {PRIVATE_READING} from '#/horizon/switches'
import {app, com} from '#/lexicons'

const LIKE_COLLECTION = 'app.bsky.feed.like'

/**
 * prism's largest author feed page.
 */
const AUTHOR_FEED_MAX = 50

/**
 * The private posts of one author that the reader may view.
 */
export class PrivateAuthorFeedAPI implements FeedAPI {
  constructor(
    private actor: string,
    private source: PrivateSource,
  ) {}

  async peekLatest(): Promise<app.bsky.feed.defs.FeedViewPost> {
    const res = await this.fetch({cursor: undefined, limit: 1})
    return res.feed[0]
  }

  async fetch({
    cursor,
    limit,
  }: {
    cursor: string | undefined
    limit: number
  }): Promise<FeedAPIResponse> {
    // A short or empty page with a cursor is followed (feed/paging.ts).
    const page = await fetchUntilItems(async pageCursor => {
      const res = await getPrivateAuthorFeed(this.source.prism, {
        actor: this.actor,
        limit: Math.min(limit, AUTHOR_FEED_MAX),
        cursor: pageCursor,
      })
      return {items: res.feed, cursor: res.cursor}
    }, cursor)
    const inputs: AdaptInput[] = page.items.map(view => ({view}))
    if (cursor === undefined && this.actor === this.source.did) {
      // The author's own just-written posts, above what prism serves.
      // Only a post's own item counts; a repost item is not the post.
      const served = new Set<string>(
        page.items.filter(view => isOwnItem(view)).map(view => view.uri),
      )
      const pending = getPendingPosts()
        .filter(entry => !served.has(entry.uri))
        .map(pendingAsInput)
      inputs.unshift(...pending)
    }
    const feed = await toFeedViewPosts(inputs, this.source)
    return {cursor: page.cursor, feed}
  }
}

/**
 * A Private tab without a private source (the render in which the clients
 * are not current yet): nothing, and no request.
 */
class EmptyFeedAPI implements FeedAPI {
  peekLatest(): Promise<app.bsky.feed.defs.FeedViewPost> {
    return Promise.resolve(
      undefined as unknown as app.bsky.feed.defs.FeedViewPost,
    )
  }

  fetch(): Promise<FeedAPIResponse> {
    return Promise.resolve({cursor: undefined, feed: []})
  }
}

/**
 * One first page's lookup of a profile's pinned private post, shared by the
 * Posts tab's wrapper (which shows it) and its merge (which excludes it from
 * the private side): one `getProfile` and one `getPosts`, made on first use.
 */
export type PinnedPrivatePostLookup = {
  /** The pinned post as a feed item with `reasonPin`, or nothing. */
  item: () => Promise<app.bsky.feed.defs.FeedViewPost | undefined>
  /** Its URI, when `item` resolves to one. */
  uri: () => Promise<string | undefined>
}

/**
 * The lookup for `actor`'s pinned private post: resolves to the post when the
 * profile's `pinnedPost` is private and prism serves it to the reader;
 * nothing otherwise, and on any failure.
 */
export function pinnedPrivatePostLookup(
  actor: string,
  source: PrivateSource,
): PinnedPrivatePostLookup {
  let pending: Promise<app.bsky.feed.defs.FeedViewPost | undefined> | undefined
  const item = () => {
    pending ??= (async () => {
      try {
        const profile = await source.appview.call(app.bsky.actor.getProfile, {
          actor: actor as AtIdentifierString,
        })
        const uri = profile.pinnedPost?.uri
        if (!uri || !isPrivatePostUri(uri)) return undefined
        const views = await getPrivatePosts(source.prism, [uri])
        if (views.length === 0) return undefined
        const [found] = await toFeedViewPosts(
          views.map(view => ({view})),
          source,
        )
        if (!found) return undefined
        return {
          ...found,
          reason: {$type: 'app.bsky.feed.defs#reasonPin' as const},
        }
      } catch (error) {
        logger.warn('pinned private post unavailable', {safeMessage: error})
        return undefined
      }
    })()
    return pending
  }
  return {
    item,
    uri: async () => (await item())?.post.uri,
  }
}

/**
 * The Posts tab, with the profile's pinned private post on its first page
 * when the reader may view it.
 */
class PinnedPrivatePostFeedAPI implements FeedAPI {
  constructor(
    private stock: FeedAPI,
    private lookup: PinnedPrivatePostLookup,
  ) {}

  peekLatest() {
    return this.stock.peekLatest()
  }

  async fetch(params: {
    cursor: string | undefined
    limit: number
    signal?: AbortSignal
  }): Promise<FeedAPIResponse> {
    if (params.cursor !== undefined) return this.stock.fetch(params)
    const [res, pinned] = await Promise.all([
      this.stock.fetch(params),
      this.lookup.item(),
    ])
    if (!pinned) return res
    return {
      ...res,
      feed: [
        pinned,
        ...res.feed.filter(item => item.post.uri !== pinned.post.uri),
      ],
    }
  }
}

/**
 * The legacy feed API for `feedDesc`, for a member with a private source: a
 * Private tab reads prism; the Posts tab merges the profile's private posts
 * and self-threads and shows its pinned private post first; the Replies tab
 * merges all its private posts and replies (6.3.1, 6.4). Anything else is the
 * stock API. With a source each of these resolves the private posts its
 * pages quote; without one it is the stock API as it is (a Private tab
 * without a source reads nothing).
 */
export function horizonFeedApi(
  feedDesc: string,
  source: PrivateSource | undefined,
  api: FeedAPI,
): FeedAPI {
  if (!PRIVATE_READING) return api
  if (!source) return privateTabDid(feedDesc) ? new EmptyFeedAPI() : api
  return withPrivateQuotes(memberFeedApi(feedDesc, source, api))
}

function memberFeedApi(
  feedDesc: string,
  source: PrivateSource,
  api: FeedAPI,
): FeedAPI {
  const privateActor = privateTabDid(feedDesc)
  if (privateActor) return new PrivateAuthorFeedAPI(privateActor, source)
  const [kind, actor, filter, ...rest] = feedDesc.split('|')
  if (kind === 'likes' && actor && filter === undefined) {
    return ownLikesFeedApi(actor, source, api)
  }
  if (kind !== 'author' || !actor || rest.length) return api
  if (filter === 'posts_and_author_threads') {
    // A new first page makes a new lookup.
    const lookup = pinnedPrivatePostLookup(actor, source)
    return new PinnedPrivatePostFeedAPI(
      new PrivateAuthorMergeFeedAPI(api, source, actor, 'posts', lookup.uri),
      lookup,
    )
  }
  if (filter === 'posts_with_replies') {
    return new PrivateAuthorMergeFeedAPI(api, source, actor, 'replies')
  }
  // The Media and Videos tabs, while prism filters media (change list 4).
  if (privateMediaFiltersServed()) {
    if (filter === 'posts_with_media') {
      return new PrivateAuthorMergeFeedAPI(api, source, actor, 'media')
    }
    if (filter === 'posts_with_video') {
      return new PrivateAuthorMergeFeedAPI(api, source, actor, 'video')
    }
  }
  return api
}

/**
 * The Likes tab (change list item 5): the owner's own likes with their liked
 * private posts merged in, read from the owner's repo through their PDS.
 * Anyone else's Likes tab, or one without a PDS client, is stock.
 */
function ownLikesFeedApi(
  actor: string,
  source: PrivateSource,
  api: FeedAPI,
): FeedAPI {
  const pds = getCurrentPdsClient()
  if (actor !== source.did || !pds) return api
  return new PrivateLikesMergeFeedAPI(api, source, async cursor => {
    const res = await pds.call(com.atproto.repo.listRecords, {
      repo: actor as AtIdentifierString,
      collection: LIKE_COLLECTION,
      limit: LIKE_RECORDS_PAGE_LIMIT,
      cursor,
    })
    return {records: res.records, cursor: res.cursor}
  })
}
