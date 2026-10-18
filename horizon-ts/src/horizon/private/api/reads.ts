/*
 * Every prism private read goes through here. A `NotEnrolled` or `NotReady`
 * answer is reported to membership, which moves the account to `not-member`
 * or `indexing` so the private features disappear; every error is then
 * rethrown for the caller to handle where the call is made.
 */

import {type Client} from '@atproto/lex'
import {
  type AtUriString,
  type DatetimeString,
  type DidString,
} from '@atproto/syntax'

import {nearhorizon} from '#/horizon/lexicons'
import {
  type PrivatePostView,
  type PrivateThreadView,
} from '#/horizon/lexicons/nearhorizon'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {reportPrismError} from '#/horizon/routing/membership'

const GET_POSTS_BATCH = 25

/**
 * Run a prism call, reporting its failure to membership (a not-member
 * answer moves the state; a 501 `MethodNotImplemented` asks the probe to
 * read the feature list again), then rethrowing it. Every prism call that a
 * feature gates goes through this.
 */
export async function reportedPrismCall<T>(
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request()
  } catch (error) {
    const did = getCurrentDid()
    if (did) reportPrismError(did, error)
    throw error
  }
}

/**
 * Private posts by URI, de-duplicated and asked 25 at a time. A URI prism
 * does not return (missing, or not readable by the reader) is simply absent.
 */
export async function getPrivatePosts(
  prism: Client,
  uris: readonly string[],
): Promise<PrivatePostView[]> {
  const unique = Array.from(new Set(uris))
  const batches: AtUriString[][] = []
  for (let i = 0; i < unique.length; i += GET_POSTS_BATCH) {
    batches.push(unique.slice(i, i + GET_POSTS_BATCH) as AtUriString[])
  }
  const pages = await Promise.all(
    batches.map(batch =>
      reportedPrismCall(() =>
        prism.call(nearhorizon.privateGetPosts, {uris: batch}),
      ),
    ),
  )
  return pages.flatMap(page => page.posts)
}

/**
 * One page of the reader's private timeline.
 */
export function getPrivateTimeline(
  prism: Client,
  params: {limit?: number; cursor?: string},
): Promise<{feed: PrivatePostView[]; cursor?: string}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetTimeline, params),
  )
}

/**
 * One page of an author's private posts that the reader may view.
 */
export function getPrivateAuthorFeed(
  prism: Client,
  params: {actor: string; limit?: number; cursor?: string; filter?: string},
): Promise<{feed: PrivatePostView[]; cursor?: string}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetAuthorFeed, {
      ...params,
      actor: params.actor as DidString,
    }),
  )
}

/**
 * One page of the reader's private bookmarks (P-8), newest first.
 */
export function getPrivateBookmarks(
  prism: Client,
  params: {limit?: number; cursor?: string},
): Promise<{
  bookmarks: {
    createdAt: string
    subject: {uri: string; cid: string}
    item: PrivatePostView
  }[]
  cursor?: string
}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetBookmarks, params),
  )
}

/**
 * A private thread. `NotFound` is rethrown like any other error.
 */
export async function getPrivatePostThread(
  prism: Client,
  params: {uri: string; depth?: number; parentHeight?: number},
): Promise<PrivateThreadView> {
  const res = await reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetPostThread, {
      ...params,
      uri: params.uri as AtUriString,
    }),
  )
  /*
   * The schema types the thread as an object only (it is recursive); the
   * thread adapter checks each node.
   */
  return res.thread as unknown as PrivateThreadView
}

/**
 * Untyped items of a 2H list (each checked where it is used).
 */
type Items = Record<string, unknown>[]

/**
 * One page of the reader's private notifications (P-9), newest first.
 */
export function listPrivateNotifications(
  prism: Client,
  params: {reasons?: string[]; limit?: number; cursor?: string},
): Promise<{notifications: Items; cursor?: string; seenAt?: string}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateListNotifications, params),
  )
}

/**
 * The reader's unread private notification count (P-9).
 */
export async function getPrivateUnreadCount(prism: Client): Promise<number> {
  const res = await reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetUnreadCount, {}),
  )
  return res.count
}

/**
 * Mark the reader's private notifications seen up to `seenAt` (P-9).
 */
export async function updatePrivateSeen(
  prism: Client,
  params: {seenAt: string},
): Promise<void> {
  await reportedPrismCall(() =>
    prism.call(nearhorizon.privateUpdateSeen, {
      seenAt: params.seenAt as DatetimeString,
    }),
  )
}

/**
 * One page of a private search (P-7), newest first.
 */
export function searchPrivatePosts(
  prism: Client,
  params: {q: string; sort?: string; limit?: number; cursor?: string},
): Promise<{posts: Items; cursor?: string}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateSearchPosts, params),
  )
}

type InteractionParams = {uri: string; limit?: number; cursor?: string}

/**
 * One page of a private post's likes (P-5).
 */
export function getPrivateLikes(
  prism: Client,
  params: InteractionParams,
): Promise<{uri: string; likes: Items; cursor?: string}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetLikes, {
      ...params,
      uri: params.uri as AtUriString,
    }),
  )
}

/**
 * One page of a private post's reposters (P-5).
 */
export function getPrivateRepostedBy(
  prism: Client,
  params: InteractionParams,
): Promise<{uri: string; repostedBy: Items; cursor?: string}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetRepostedBy, {
      ...params,
      uri: params.uri as AtUriString,
    }),
  )
}

/**
 * One page of the posts quoting a private post (P-5).
 */
export function getPrivateQuotes(
  prism: Client,
  params: InteractionParams,
): Promise<{uri: string; posts: Items; cursor?: string}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetQuotes, {
      ...params,
      uri: params.uri as AtUriString,
    }),
  )
}

/**
 * One page of the private replies to a private or public post (P-6, P-14),
 * oldest first, as thread nodes.
 */
export function getPrivateReplies(
  prism: Client,
  params: {uri: string; limit?: number; cursor?: string; depth?: number},
): Promise<{replies: Items; cursor?: string}> {
  return reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetReplies, {
      ...params,
      uri: params.uri as AtUriString,
    }),
  )
}
