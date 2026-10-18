/*
 * The composer's reply preview (spoilers design, 6.8). The stock preview
 * draws `replyTo.text` plainly, and `ComposerOptsPostRef` carries no facets,
 * so the post is found by URI in the query cache, through the stock finders.
 */

import {RichText as RichTextAPI, UnicodeString} from '@bsky/sdk/richtext'
import {type QueryClient} from '@tanstack/react-query'

import {findAllPostsInQueryData as findBookmarkPosts} from '#/state/queries/bookmarks/useBookmarksQuery'
import {findAllPostsInQueryData as findExplorePosts} from '#/state/queries/explore-feed-previews'
import {findAllPostsInQueryData as findNotificationPosts} from '#/state/queries/notifications/feed'
import {findAllPostsInQueryData as findGroupedNotificationPosts} from '#/state/queries/notifications/grouped'
import {RQKEY as postQueryKey} from '#/state/queries/post'
import {findAllPostsInQueryData as findFeedPosts} from '#/state/queries/post-feed'
import {findAllPostsInQueryData as findQuotePosts} from '#/state/queries/post-quotes'
import {findAllPostsInQueryData as findSearchPosts} from '#/state/queries/search-posts-v2'
import {findAllPostsInQueryData as findThreadPosts} from '#/state/queries/usePostThread/queryCache'
import {findPrivateBookmarkPosts} from '#/horizon/private/api/bookmarks'
import {SPOILER_TAGS} from '#/horizon/switches'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {spoilerFeature} from './nsid'

type PostView = app.bsky.feed.defs.PostView
type Finder = (
  queryClient: QueryClient,
  uri: string,
) => Generator<PostView, unknown>

const FINDERS: Finder[] = [
  findThreadPosts,
  findFeedPosts,
  findNotificationPosts,
  findGroupedNotificationPosts,
  findBookmarkPosts,
  findSearchPosts,
  findQuotePosts,
  findExplorePosts,
  findPrivateBookmarkPosts,
]

/**
 * Hook Spoil 7 draws the reply preview through `ReplyToText`.
 */
export function coversReplyToSpoilers(): boolean {
  return SPOILER_TAGS
}

/**
 * The post's record, when `post` is that post with the text the preview
 * shows.
 */
export function matchingRecord(
  post: PostView | undefined,
  text: string,
): app.bsky.feed.post.Main | undefined {
  if (!post) return undefined
  if (!bsky.isType(app.bsky.feed.post, post.record)) return undefined
  return post.record.text === text ? post.record : undefined
}

/**
 * The first cached post at `uri` whose record has `text`: thread, feeds,
 * notifications, Saved, search, quotes, explore, private Saved, then the
 * post query.
 */
export function findCachedPostRecord(
  queryClient: QueryClient,
  uri: string,
  text: string,
): app.bsky.feed.post.Main | undefined {
  for (const find of FINDERS) {
    for (const post of find(queryClient, uri)) {
      const record = matchingRecord(post, text)
      if (record) return record
    }
  }
  return matchingRecord(
    queryClient.getQueryData<PostView>(postQueryKey(uri)),
    text,
  )
}

/**
 * While the post is being read, a preview that might hold spoilers is drawn
 * covered: every private post, and a public one with two or more `||`.
 */
export function coversWhileLoading(text: string, isPrivate: boolean): boolean {
  return isPrivate || text.split('||').length - 1 >= 2
}

/**
 * `text` as one spoiler.
 */
export function wholeTextSpoiler(text: string): RichTextAPI {
  return new RichTextAPI({
    text,
    facets: [
      {
        index: {byteStart: 0, byteEnd: new UnicodeString(text).length},
        features: [spoilerFeature()],
      },
    ],
  })
}
