/*
 * The client mute filter's pure part (activity subscriptions design 2.5):
 * leaving muted authors out of the private list and the nav badge's
 * private-only count. Imports no session or React module; the mute list is
 * read in `muted.ts`.
 */

import {type NotificationView} from '#/state/queries/notifications/grouped'
import {isNonEmpty} from '#/state/queries/notifications/grouped/types'

/**
 * `notification` without the items, actors or post of muted authors, or
 * `undefined` when nothing of it is left. Returns the same object when
 * nothing is muted. A row's author is usually hidden by the stock
 * moderation already; this covers a page whose author merge failed.
 */
export function withoutMutedAuthors(
  notification: NotificationView,
  muted: ReadonlySet<string>,
): NotificationView | undefined {
  if (muted.size === 0) return notification
  switch (notification.type) {
    case 'subscribedPost': {
      const items = notification.items.filter(
        item => !muted.has(item.actor.did) && !muted.has(item.post.author.did),
      )
      if (items.length === notification.items.length) return notification
      return isNonEmpty(items) ? {...notification, items} : undefined
    }
    case 'reply':
    case 'quote':
    case 'mention':
      return muted.has(notification.post.author.did) ? undefined : notification
    case 'like':
    case 'repost':
    case 'likeViaRepost':
    case 'repostViaRepost':
    case 'follow':
    case 'generatorLike': {
      const actors = notification.actors.filter(actor => !muted.has(actor.did))
      if (actors.length === notification.actors.length) return notification
      if (!isNonEmpty(actors)) return undefined
      if (notification.type === 'follow') {
        return {
          ...notification,
          actors,
          actorDids: notification.actorDids.filter(did => !muted.has(did)),
        }
      }
      return {...notification, actors}
    }
    default:
      return muted.has(notification.actor.did) ? undefined : notification
  }
}

/** One unread private-only item, as the nav badge's count keeps it. */
export type UnreadItem = {author: string}

/**
 * How many of `items` count toward the nav badge: those whose author is not
 * muted, at most `cap`.
 */
export function countUnmuted(
  items: readonly UnreadItem[],
  muted: ReadonlySet<string>,
  cap: number,
): number {
  let count = 0
  for (const item of items) {
    if (muted.has(item.author)) continue
    count++
    if (count >= cap) return cap
  }
  return count
}
