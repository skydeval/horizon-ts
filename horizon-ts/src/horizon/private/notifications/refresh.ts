/*
 * Refreshing the Private view: pressing the Private tab of the
 * Public | Private switch, and the "Refresh" pill offered when prism's
 * unread count says there is something new. Kept out of `query.ts` so it
 * imports no session or React module.
 *
 * The cached list stays on screen throughout: a refresh keeps the first
 * page while it asks again, and a refresh that fails leaves it in place.
 */

import {type InfiniteData, type QueryClient} from '@tanstack/react-query'

import {type LoadedGroupedNotificationsPage} from '#/state/queries/notifications/grouped'
import {activitySubscriptionsShown} from '#/horizon/private/activity-subscriptions/checks'
import {PRIVATE_NOTIFICATIONS_ROOT} from '#/horizon/private/cache-finders'
import {type NotificationsMode} from '#/horizon/private/notifications/mode'
import {type PrivateNotificationsTab} from '#/horizon/private/notifications/page'

export function privateNotificationsQueryKey(
  did: string,
  tab: PrivateNotificationsTab,
) {
  return [PRIVATE_NOTIFICATIONS_ROOT, did, tab]
}

/**
 * Asks prism for the first page of `tab` again, as the stock
 * `refreshGroupedNotifications` does for a public feed: later pages are
 * dropped (the list is scrolled to the top first), the first stays shown
 * until the new one arrives, and a failed refetch keeps it. Fetches even
 * when the list isn't mounted, so a list about to open finds it on the way.
 */
export async function refreshPrivateNotifications(
  queryClient: QueryClient,
  did: string,
  tab: PrivateNotificationsTab,
) {
  const queryKey = privateNotificationsQueryKey(did, tab)
  queryClient.setQueryData<
    InfiniteData<LoadedGroupedNotificationsPage, string | undefined>
  >(queryKey, data =>
    data
      ? {
          pageParams: data.pageParams.slice(0, 1),
          pages: data.pages.slice(0, 1),
        }
      : data,
  )
  await queryClient.invalidateQueries({queryKey, refetchType: 'all'})
}

/**
 * Pressing a tab of the Public | Private switch.
 *
 * - Pressing the tab that's already shown, Public or Private, scrolls its
 *   list to the top and asks again, as re-pressing a stock tab does
 *   (`softReset`, the stock soft reset both lists listen for).
 * - Switching to Private with something unread asks again for the "All"
 *   pill the view opens on, starting before the view mounts, and marks
 *   "Replies" (and "Activity" while prism lists
 *   `private.activitySubscriptions`) stale so it asks when opened. Without anything unread, a list
 *   older than its stale time asks again as it mounts.
 */
export function pressNotificationsModeTab({
  queryClient,
  did,
  current,
  next,
  unread,
  select,
  softReset,
}: {
  queryClient: QueryClient
  did: string
  current: NotificationsMode
  next: NotificationsMode
  /**
   * prism's unread count, if known.
   */
  unread: number | undefined
  select: (mode: NotificationsMode) => void
  softReset: () => void
}) {
  if (next === current) {
    softReset()
    return
  }
  if (next === 'private' && unread) {
    void queryClient.invalidateQueries({
      queryKey: privateNotificationsQueryKey(did, 'replies'),
      refetchType: 'none',
    })
    if (activitySubscriptionsShown(did)) {
      void queryClient.invalidateQueries({
        queryKey: privateNotificationsQueryKey(did, 'activity'),
        refetchType: 'none',
      })
    }
    void refreshPrivateNotifications(queryClient, did, 'all')
  }
  select(next)
}

/**
 * Whether the Private list offers the stock "Refresh" pill: it's in view,
 * its first page has loaded and isn't being asked again, and prism's unread
 * count, checked since that page was asked, has something unread.
 */
export function isPrivateRefreshPillVisible({
  isActive,
  unread,
  top,
  isFetchingTop,
}: {
  /**
   * Whether the list is in view, on the focused screen.
   */
  isActive: boolean
  /**
   * prism's unread count and when it was last checked, in ms since the
   * epoch.
   */
  unread: {count: number; checkedAt: number} | undefined
  /**
   * The list's first page, once loaded.
   */
  top: Pick<LoadedGroupedNotificationsPage, 'requestedAt'> | undefined
  isFetchingTop: boolean
}): boolean {
  if (!isActive || !unread || !top || isFetchingTop) return false
  if (unread.checkedAt <= top.requestedAt) return false
  return unread.count > 0
}
