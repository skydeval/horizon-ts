/*
 * The Private notifications queries (2H design 10.3, 10.5): the list for a
 * pill, prism's unread count for the Private tab, and the private-only count
 * the nav badge adds to the public one (`unread.ts`).
 *
 * All of them need `PRIVATE_NOTIFICATIONS_SWITCH`, a private source (a
 * member, `PRIVATE_READING`) and prism listing `private.notifications`;
 * otherwise nothing is asked and the counts are `undefined`.
 */

import {useInfiniteQuery, useQuery} from '@tanstack/react-query'

import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {STALE} from '#/state/queries'
import {type LoadedGroupedNotificationsPage} from '#/state/queries/notifications/grouped'
import {moderateNotification} from '#/state/queries/notifications/grouped/moderate'
import {useSession} from '#/state/session'
import {useThreadgateHiddenReplyUris} from '#/state/threadgate-hidden-replies'
import {getPrivateUnreadCount} from '#/horizon/private/api/reads'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {usePrivateFeedSource} from '#/horizon/private/membership'
import {
  fetchPrivateNotificationsPage,
  type PrivateNotificationsTab,
} from '#/horizon/private/notifications/page'
import {privateNotificationsQueryKey} from '#/horizon/private/notifications/refresh'
import {
  countPrivateOnlyUnread,
  PRIVATE_UNREAD_OWN_ROOT,
  PRIVATE_UNREAD_ROOT,
} from '#/horizon/private/notifications/unread'
import {PRIVATE_NOTIFICATIONS_SWITCH} from '#/horizon/switches'

/**
 * How often the counts are asked again (the stock unread poll's interval).
 */
export const PRIVATE_UNREAD_INTERVAL_MS = 30_000

export {privateNotificationsQueryKey}

/**
 * Whether the private notification queries run: the switch, a source, and
 * the feature.
 */
function useEnabledSource() {
  const source = usePrivateFeedSource()
  const served = usePrismFeature('private.notifications')
  return PRIVATE_NOTIFICATIONS_SWITCH && served ? source : undefined
}

/**
 * The Private view's list for `tab`: stock grouped pages, moderated as the
 * stock list moderates them, a notification already shown on an earlier
 * page left out.
 */
export function usePrivateNotificationsQuery({
  tab,
}: {
  tab: PrivateNotificationsTab
}) {
  const source = useEnabledSource()
  const {currentAccount} = useSession()
  const moderationOpts = useModerationOpts()
  const {uris: hiddenReplyUris} = useThreadgateHiddenReplyUris()
  const viewerDid = currentAccount?.did
  return useInfiniteQuery({
    enabled: !!source && !!moderationOpts,
    staleTime: STALE.SECONDS.FIFTEEN,
    queryKey: privateNotificationsQueryKey(source?.did ?? '', tab),
    queryFn: ({pageParam}): Promise<LoadedGroupedNotificationsPage> => {
      if (!source) throw new Error('private notifications: no source')
      return fetchPrivateNotificationsPage({
        source,
        tab,
        cursor: pageParam,
        viewerDid,
        requestedAt: Date.now(),
      })
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.cursor,
    select(data) {
      const seen = new Set<string>()
      return {
        ...data,
        pages: data.pages.map(page => ({
          ...page,
          notifications: page.notifications.flatMap(notification => {
            const moderated = moderateNotification(notification, {
              moderationOpts,
              hiddenReplyUris,
            })
            if (!moderated || seen.has(moderated.id)) return []
            seen.add(moderated.id)
            return [moderated]
          }),
        })),
      }
    },
  })
}

/**
 * prism's full unread count, for the Private tab's badge.
 */
export function usePrivateUnreadCount(): number | undefined {
  return usePrivateUnreadCheck()?.count
}

/**
 * prism's full unread count and when it was last checked (or cleared by
 * mark-seen), in ms since the epoch, for the Private list's "Refresh" pill.
 */
export function usePrivateUnreadCheck():
  {count: number; checkedAt: number} | undefined {
  const source = useEnabledSource()
  const {data, dataUpdatedAt} = useQuery({
    enabled: !!source,
    queryKey: [PRIVATE_UNREAD_ROOT, source?.did ?? ''],
    queryFn: () => {
      if (!source) throw new Error('private notifications: no source')
      return getPrivateUnreadCount(source.prism)
    },
    refetchInterval: PRIVATE_UNREAD_INTERVAL_MS,
  })
  return source && data !== undefined
    ? {count: data, checkedAt: dataUpdatedAt}
    : undefined
}

/**
 * The private-only unread count the nav badge adds (Notif 5).
 */
export function usePrivateOnlyUnreadCount(): number | undefined {
  const source = useEnabledSource()
  const {data} = useQuery({
    enabled: !!source,
    queryKey: [PRIVATE_UNREAD_OWN_ROOT, source?.did ?? ''],
    queryFn: () => {
      if (!source) throw new Error('private notifications: no source')
      return countPrivateOnlyUnread(source.prism)
    },
    refetchInterval: PRIVATE_UNREAD_INTERVAL_MS,
  })
  return source ? data : undefined
}
