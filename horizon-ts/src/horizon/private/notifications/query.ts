/*
 * The Private notifications queries (2H design 10.3, 10.5): the list for a
 * pill, prism's unread count for the Private tab, and the private-only count
 * the nav badge adds to the public one (`unread.ts`).
 *
 * All of them need `PRIVATE_NOTIFICATIONS_SWITCH`, a private source (a
 * member, `PRIVATE_READING`) and prism listing `private.notifications`;
 * otherwise nothing is asked and the counts are `undefined`.
 */

import {useEffect, useEffectEvent} from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {STALE} from '#/state/queries'
import {moderateNotification} from '#/state/queries/notifications/grouped/moderate'
import {useSession} from '#/state/session'
import {useThreadgateHiddenReplyUris} from '#/state/threadgate-hidden-replies'
import {useActivitySubscriptionsShown} from '#/horizon/private/activity-subscriptions/hooks'
import {
  countUnmuted,
  type UnreadItem,
  withoutMutedAuthors,
} from '#/horizon/private/activity-subscriptions/mute-filter'
import {useMutedDids} from '#/horizon/private/activity-subscriptions/muted'
import {getPrivateUnreadCount} from '#/horizon/private/api/reads'
import {keepOverData, PRIVATE_RETRY} from '#/horizon/private/api/transient'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {degradedStaleTime} from '#/horizon/private/feed/degraded'
import {
  type PrivateFeedSource,
  usePrivateFeedSource,
} from '#/horizon/private/membership'
import {
  fetchPrivateNotificationsPage,
  type PrivateNotificationsPage,
  type PrivateNotificationsTab,
} from '#/horizon/private/notifications/page'
import {privateNotificationsQueryKey} from '#/horizon/private/notifications/refresh'
import {
  countPrivateOnlyUnread,
  PRIVATE_ONLY_UNREAD_CAP,
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
 * The query function of `tab`'s list, shared by the list and its prefetch.
 */
function privateNotificationsQueryFn(
  source: PrivateFeedSource | undefined,
  tab: PrivateNotificationsTab,
  viewerDid: string | undefined,
) {
  return ({
    pageParam,
  }: {
    pageParam: string | undefined
  }): Promise<PrivateNotificationsPage> => {
    if (!source) throw new Error('private notifications: no source')
    return fetchPrivateNotificationsPage({
      source,
      tab,
      cursor: pageParam,
      viewerDid,
      requestedAt: Date.now(),
    })
  }
}

/**
 * The Private view's list for `tab`: stock grouped pages, moderated as the
 * stock list moderates them, a notification already shown on an earlier
 * page left out. While prism lists `private.activitySubscriptions`, authors
 * the reader muted on Bluesky are left out too (activity subscriptions
 * design 2.5), for pages whose author merge failed.
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
  const muted = useMutedDids()
  const viewerDid = currentAccount?.did
  const fetchPage = privateNotificationsQueryFn(source, tab, viewerDid)
  return useInfiniteQuery({
    enabled: !!source && !!moderationOpts,
    // Stale at once while a page is degraded (busy design 6.7).
    staleTime: degradedStaleTime(STALE.SECONDS.FIFTEEN),
    queryKey: privateNotificationsQueryKey(source?.did ?? '', tab),
    // Retried while prism is busy, never over a page it shows (busy design 5).
    queryFn: context => keepOverData(context, () => fetchPage(context)),
    ...PRIVATE_RETRY,
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
            const kept = moderated && withoutMutedAuthors(moderated, muted)
            if (!kept || seen.has(kept.id)) return []
            seen.add(kept.id)
            return [kept]
          }),
        })),
      }
    },
  })
}

/**
 * Prefetch `tab`'s first page when the Private view mounts, with the list's
 * own key and fetcher, so its first switch shows cached rows (activity
 * subscriptions design 2.5). Only while `enabled`.
 */
export function usePrefetchPrivateNotifications(
  tab: PrivateNotificationsTab,
  enabled: boolean,
) {
  const source = useEnabledSource()
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const viewerDid = currentAccount?.did
  const did = source?.did
  const prefetch = useEffectEvent(() => {
    if (!source) return
    void queryClient.prefetchInfiniteQuery({
      queryKey: privateNotificationsQueryKey(source.did, tab),
      queryFn: privateNotificationsQueryFn(source, tab, viewerDid),
      initialPageParam: undefined as string | undefined,
      staleTime: STALE.SECONDS.FIFTEEN,
    })
  })
  useEffect(() => {
    if (enabled && did) prefetch()
  }, [enabled, did, tab])
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
 * The private-only unread count the nav badge adds (Notif 5). While prism
 * lists `private.activitySubscriptions` it also counts new private posts from
 * accounts whose bell is on, and leaves out authors the reader muted on
 * Bluesky (activity subscriptions design 2.5); the cap applies after that.
 */
export function usePrivateOnlyUnreadCount(): number | undefined {
  const source = useEnabledSource()
  const activity = useActivitySubscriptionsShown()
  const muted = useMutedDids()
  const {data} = useQuery({
    enabled: !!source,
    queryKey: [PRIVATE_UNREAD_OWN_ROOT, source?.did ?? ''],
    queryFn: (): Promise<UnreadItem[]> => {
      if (!source) throw new Error('private notifications: no source')
      return countPrivateOnlyUnread(source.prism, {activity})
    },
    select: (items: UnreadItem[]) =>
      countUnmuted(items, muted, PRIVATE_ONLY_UNREAD_CAP),
    refetchInterval: PRIVATE_UNREAD_INTERVAL_MS,
  })
  return source ? data : undefined
}
