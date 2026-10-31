/*
 * The private unread counts outside React (2H design 10.5): the private-only
 * count the nav badge adds, the badge's composition, and mark-seen. Kept out
 * of `query.ts` so it imports no session or React module.
 */

import {type Client} from '@atproto/lex'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {type UnreadItem} from '#/horizon/private/activity-subscriptions/mute-filter'
import {
  listPrivateNotifications,
  updatePrivateSeen,
} from '#/horizon/private/api/reads'
import {
  PRIVATE_UNREAD_OWN_ROOT,
  PRIVATE_UNREAD_ROOT,
} from '#/horizon/private/cache-finders'
import {
  PRIVATE_ONLY_REASONS,
  REPLY_REASONS,
} from '#/horizon/private/notifications/page'
import {privateNotificationsServed} from '#/horizon/private/server-support'
import {isPrivatePostUri} from '#/horizon/private/uri'

export {PRIVATE_UNREAD_OWN_ROOT, PRIVATE_UNREAD_ROOT}

/**
 * The highest unread count a badge shows exactly; above it the badge shows
 * "999+".
 */
export const UNREAD_BADGE_CAP = 999

/**
 * A badge's text for `count` unread: `''` for none, the number up to
 * {@link UNREAD_BADGE_CAP}, then "999+".
 */
export function formatUnreadCount(count: number): string {
  if (!(count > 0)) return ''
  if (count > UNREAD_BADGE_CAP) return `${UNREAD_BADGE_CAP}+`
  return String(Math.floor(count))
}

/**
 * The count a badge's text stands for; "999+" reads as one more than the cap,
 * so adding to it stays above the cap.
 */
export function parseUnreadCount(value: string): number {
  if (value === '') return 0
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return 0
  return value.endsWith('+') ? parsed + 1 : parsed
}

/**
 * The most private-only unread notifications counted: one past the badge
 * cap, enough to show "999+".
 */
export const PRIVATE_ONLY_UNREAD_CAP = UNREAD_BADGE_CAP + 1

/**
 * How many pages the private-only count reads at most: enough for the cap.
 * It stops at the first read notification, so it reads this far only when
 * that many are unread.
 */
export const PRIVATE_ONLY_UNREAD_PAGES = Math.ceil(PRIVATE_ONLY_UNREAD_CAP / 50)

/**
 * The reader's unread private notifications that the public count cannot
 * hold: those whose `uri` is a private post (replies, quotes and mentions
 * written privately, and with `activity` new private posts from accounts
 * whose bell is on, activity subscriptions design 2.5). Likes and reposts of
 * private posts, and public replies and quotes, are already counted by
 * Bluesky's AppView. Read newest first, page after page, until a page holds
 * a read item (everything after it is read too), the list ends, or
 * {@link PRIVATE_ONLY_UNREAD_PAGES} pages were read (P-29 would make this one
 * count). Each is kept as its author, so the count's `select` can leave out
 * muted authors and cap at {@link PRIVATE_ONLY_UNREAD_CAP}; without
 * `activity` there is no mute filter, so the read stops at the cap, as
 * before.
 */
export async function countPrivateOnlyUnread(
  prism: Client,
  {activity = false}: {activity?: boolean} = {},
): Promise<UnreadItem[]> {
  const items: UnreadItem[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < PRIVATE_ONLY_UNREAD_PAGES; pages++) {
    const page = await listPrivateNotifications(prism, {
      limit: 50,
      cursor,
      reasons: activity ? PRIVATE_ONLY_REASONS : REPLY_REASONS,
    })
    let sawRead = false
    for (const item of page.notifications) {
      if (item.isRead !== false) {
        sawRead = true
        break
      }
      if (typeof item.uri === 'string' && isPrivatePostUri(item.uri)) {
        items.push({author: authorDid(item)})
        // Without the mute filter nothing is dropped later: stop at the cap.
        if (!activity && items.length >= PRIVATE_ONLY_UNREAD_CAP) return items
      }
    }
    const next = page.cursor && page.cursor !== cursor ? page.cursor : undefined
    if (sawRead || !next) break
    cursor = next
  }
  return items
}

function authorDid(item: Record<string, unknown>): string {
  const author = item.author as {did?: unknown} | undefined
  return typeof author?.did === 'string' ? author.did : ''
}

/**
 * The nav badge: the public unread count (`''`, a number, or `'999+'`) plus
 * the private-only one, in the same form.
 */
export function composeUnreadCount(
  publicCount: string,
  privateCount: number | undefined,
): string {
  return formatUnreadCount(parseUnreadCount(publicCount) + (privateCount ?? 0))
}

/**
 * Mark the reader's private notifications seen up to `requestedAt` (a fresh
 * first page's request time), then clear both counts. Only with this run's
 * answer listing `private.notifications` (2H design 4.7); a failure is
 * logged and the counts stay.
 */
export async function markPrivateNotificationsSeen(
  queryClient: QueryClient,
  {prism, did, requestedAt}: {prism: Client; did: string; requestedAt: number},
): Promise<boolean> {
  if (!privateNotificationsServed({forWrite: true})) return false
  try {
    await updatePrivateSeen(prism, {
      seenAt: new Date(requestedAt).toISOString(),
    })
  } catch (error) {
    logger.warn('private notifications: mark seen failed', {
      safeMessage: error,
    })
    return false
  }
  queryClient.setQueryData([PRIVATE_UNREAD_ROOT, did], 0)
  queryClient.setQueryData([PRIVATE_UNREAD_OWN_ROOT, did], [])
  return true
}
