/*
 * The private unread counts outside React (2H design 10.5): the private-only
 * count the nav badge adds, the badge's composition, and mark-seen. Kept out
 * of `query.ts` so it imports no session or React module.
 */

import {type Client} from '@atproto/lex'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {
  listPrivateNotifications,
  updatePrivateSeen,
} from '#/horizon/private/api/reads'
import {REPLY_REASONS} from '#/horizon/private/notifications/page'
import {privateNotificationsServed} from '#/horizon/private/server-support'
import {isPrivatePostUri} from '#/horizon/private/uri'

export const PRIVATE_UNREAD_ROOT = 'horizon-private-unread'
export const PRIVATE_UNREAD_OWN_ROOT = 'horizon-private-unread-own'

/**
 * The most private-only unread notifications counted; at this many the
 * badge shows "30+".
 */
export const PRIVATE_ONLY_UNREAD_CAP = 30

/**
 * How many pages the private-only count reads at most.
 */
export const PRIVATE_ONLY_UNREAD_PAGES = 3

/**
 * The reader's unread private notifications that the public count cannot
 * hold: those whose `uri` is a private post (replies, quotes and mentions
 * written privately). Likes and reposts of private posts, and public replies
 * and quotes, are already counted by Bluesky's AppView. Read newest first,
 * page after page, until a page holds a read item (everything after it is
 * read too), the list ends, {@link PRIVATE_ONLY_UNREAD_CAP} are counted, or
 * {@link PRIVATE_ONLY_UNREAD_PAGES} pages were read (P-29 would make this one
 * count).
 */
export async function countPrivateOnlyUnread(prism: Client): Promise<number> {
  let count = 0
  let cursor: string | undefined
  for (let pages = 0; pages < PRIVATE_ONLY_UNREAD_PAGES; pages++) {
    const page = await listPrivateNotifications(prism, {
      limit: 50,
      cursor,
      reasons: REPLY_REASONS,
    })
    let sawRead = false
    for (const item of page.notifications) {
      if (item.isRead !== false) {
        sawRead = true
        break
      }
      if (typeof item.uri === 'string' && isPrivatePostUri(item.uri)) {
        count++
        if (count >= PRIVATE_ONLY_UNREAD_CAP) return PRIVATE_ONLY_UNREAD_CAP
      }
    }
    const next = page.cursor && page.cursor !== cursor ? page.cursor : undefined
    if (sawRead || !next) break
    cursor = next
  }
  return count
}

function parseCount(value: string): number {
  if (value === '') return 0
  if (value === '30+') return 30
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * The nav badge: the public unread count (`''`, a number, or `'30+'`) plus
 * the private-only one, in the same form.
 */
export function composeUnreadCount(
  publicCount: string,
  privateCount: number | undefined,
): string {
  const total = parseCount(publicCount) + (privateCount ?? 0)
  if (total <= 0) return ''
  if (total >= 30) return '30+'
  return String(total)
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
  queryClient.setQueryData([PRIVATE_UNREAD_OWN_ROOT, did], 0)
  return true
}
