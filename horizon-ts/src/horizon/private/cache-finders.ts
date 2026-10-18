/*
 * The posts of Horizon's private list queries, for the stock post shadow
 * (Shadow 2, 2H design 10.6): the private notifications pages (subjects and
 * rows) and the private search pages, so a like or repost toggled elsewhere
 * shows there too. Type imports only, so the shadow module takes no runtime
 * dependency on the queries.
 */

import {type InfiniteData, type QueryClient} from '@tanstack/react-query'

import {
  type GroupedNotificationsPage,
  type NotificationView,
} from '#/state/queries/notifications/grouped/types'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/**
 * The private notifications query root (`notifications/query.ts`).
 */
export const PRIVATE_NOTIFICATIONS_ROOT = 'horizon-private-notifications'

/**
 * The private search query root (`search/results.ts`).
 */
export const PRIVATE_SEARCH_ROOT = 'horizon-private-search'

function* postsOf(notification: NotificationView): Generator<PostView, void> {
  switch (notification.type) {
    case 'like':
    case 'repost':
    case 'likeViaRepost':
    case 'repostViaRepost':
      yield notification.post
      break
    case 'reply':
    case 'quote':
    case 'mention':
      yield notification.post
      if (notification.parent?.type === 'post') yield notification.parent.post
      break
    case 'multiPostLike':
    case 'multiPostRepost':
    case 'multiPostLikeViaRepost':
    case 'multiPostRepostViaRepost':
      yield* notification.posts
      break
    case 'subscribedPost':
      for (const item of notification.items) yield item.post
      break
  }
}

/**
 * Every cached post of the private notifications and search pages whose
 * URI is `uri`.
 */
export function* findHorizonPrivatePosts(
  queryClient: QueryClient,
  uri: string,
): Generator<PostView, void> {
  const notificationDatas = queryClient.getQueriesData<
    InfiniteData<GroupedNotificationsPage>
  >({queryKey: [PRIVATE_NOTIFICATIONS_ROOT]})
  for (const [, data] of notificationDatas) {
    for (const page of data?.pages ?? []) {
      for (const notification of page.notifications) {
        for (const post of postsOf(notification)) {
          if (post.uri === uri) yield post
        }
      }
    }
  }
  const searchDatas = queryClient.getQueriesData<
    InfiniteData<{posts: PostView[]}>
  >({queryKey: [PRIVATE_SEARCH_ROOT]})
  for (const [, data] of searchDatas) {
    for (const page of data?.pages ?? []) {
      for (const post of page.posts) {
        if (post.uri === uri) yield post
      }
    }
  }
}
