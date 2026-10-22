/*
 * The Private notifications list for one pill (2H design 10.3): the stock
 * notification rows over prism's private notifications, split into "Today"
 * and "Earlier" as the stock list splits a feed, with the stock loading
 * placeholder, error, load-more retry and pull to refresh.
 *
 * Mark-seen (10.5): a fresh first page (asked after the view mounted, or by a
 * pull to refresh) shown while the screen is focused marks the reader's
 * private notifications seen up to its request time, once this run's answer
 * lists `private.notifications`. Rows keep the read state prism served until
 * the list is asked again, so what was new stays tinted while it is open.
 *
 * Refresh (as the stock tabs have it): a soft reset (re-pressing the Private
 * tab, the selected pill, or the Notifications tab button) scrolls to the top
 * and asks for the first page again, and the stock "Refresh" pill is offered
 * when prism's unread count says there's something new. The cached list stays
 * shown while it asks, and if the ask fails.
 */

import {useEffect, useEffectEvent, useRef, useState} from 'react'
import {ActivityIndicator, View} from 'react-native'
import {useSharedValue} from 'react-native-reanimated'
import {useLingui} from '@lingui/react/macro'
import {useIsFocused} from '@react-navigation/native'
import {useQueryClient} from '@tanstack/react-query'
import {isToday} from 'date-fns'

import {useInitialNumToRender} from '#/lib/hooks/useInitialNumToRender'
import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {listenSoftReset} from '#/state/events'
import {type NotificationView} from '#/state/queries/notifications/grouped'
import {ErrorMessage} from '#/view/com/util/error/ErrorMessage'
import {List, type ListMethods} from '#/view/com/util/List'
import {NotificationFeedLoadingPlaceholder} from '#/view/com/util/LoadingPlaceholder'
import {LoadMoreRetryBtn} from '#/view/com/util/LoadMoreRetryBtn'
import {NotificationItem} from '#/screens/Notifications/components/NotificationItem'
import {RefreshPill} from '#/screens/Notifications/components/RefreshPill'
import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {IS_NATIVE} from '#/env'
import {usePrismFeatureForWrite} from '#/horizon/private/features-hooks'
import {usePrivateFeedSource} from '#/horizon/private/membership'
import {type PrivateNotificationsTab} from '#/horizon/private/notifications/page'
import {
  usePrivateNotificationsQuery,
  usePrivateUnreadCheck,
} from '#/horizon/private/notifications/query'
import {
  isPrivateRefreshPillVisible,
  refreshPrivateNotifications,
} from '#/horizon/private/notifications/refresh'
import {markPrivateNotificationsSeen} from '#/horizon/private/notifications/unread'

type Row =
  | {type: 'section'; key: string; section: 'today' | 'earlier'}
  | {type: 'notification'; key: string; notification: NotificationView}
  | {type: 'loading'; key: string}
  | {type: 'empty'; key: string}
  | {type: 'error'; key: string}
  | {type: 'loadMoreError'; key: string}

/**
 * "Today" before the first row when it is from today, "Earlier" before the
 * first older row after it; no headers when nothing is from today.
 */
export function buildPrivateRows(notifications: NotificationView[]): Row[] {
  const rows: Row[] = []
  const hasToday = isToday(new Date(notifications[0].indexedAt))
  let addedEarlier = false
  if (hasToday) {
    rows.push({type: 'section', key: 'section-today', section: 'today'})
  }
  for (const notification of notifications) {
    if (
      hasToday &&
      !addedEarlier &&
      !isToday(new Date(notification.indexedAt))
    ) {
      rows.push({type: 'section', key: 'section-earlier', section: 'earlier'})
      addedEarlier = true
    }
    rows.push({type: 'notification', key: notification.id, notification})
  }
  return rows
}

export function PrivateNotificationsList({
  tab,
}: {
  tab: PrivateNotificationsTab
}) {
  const {t: l} = useLingui()
  const t = useTheme()
  const queryClient = useQueryClient()
  const isFocused = useIsFocused()
  const source = usePrivateFeedSource()
  const canMarkSeen = usePrismFeatureForWrite('private.notifications')
  const initialNumToRender = useInitialNumToRender()
  const [isPTRing, setIsPTRing] = useState(false)
  const [mountedAt] = useState(() => Date.now())
  const markedAt = useRef<number | undefined>(undefined)

  const {
    data,
    isFetched,
    isFetching,
    isError,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = usePrivateNotificationsQuery({tab})

  const top = data?.pages[0]
  const topRequestedAt = top?.requestedAt
  useEffect(() => {
    if (
      topRequestedAt === undefined ||
      topRequestedAt < mountedAt ||
      markedAt.current === topRequestedAt ||
      !isFocused ||
      !canMarkSeen ||
      !source
    ) {
      return
    }
    markedAt.current = topRequestedAt
    void markPrivateNotificationsSeen(queryClient, {
      prism: source.prism,
      did: source.did,
      requestedAt: topRequestedAt,
    })
  }, [topRequestedAt, mountedAt, isFocused, canMarkSeen, source, queryClient])

  /*
   * Back to the top and ask again, keeping the list shown while it asks. A
   * failed ask keeps it too (the query keeps its data on error).
   */
  const listRef = useRef<ListMethods>(null)
  const loadLatest = () => {
    listRef.current?.scrollToOffset({animated: IS_NATIVE, offset: 0})
    if (!source) return
    void refreshPrivateNotifications(queryClient, source.did, tab)
  }
  const onSoftReset = useEffectEvent(loadLatest)
  useEffect(() => {
    if (!isFocused) return
    return listenSoftReset(() => onSoftReset())
  }, [isFocused])

  const unread = usePrivateUnreadCheck()
  const showRefreshPill = isPrivateRefreshPillVisible({
    isActive: isFocused,
    unread,
    top,
    isFetchingTop: isFetching && !isFetchingNextPage,
  })
  // The private pills don't hide on scroll, so the pill stays beneath them
  const pillTitleHeight = useSharedValue(0)

  const notifications = data?.pages.flatMap(page => page.notifications) ?? []
  const isEmpty =
    isFetched && !isError && notifications.length === 0 && !hasNextPage

  let rows: Row[]
  if (notifications.length === 0) {
    rows = [
      isError
        ? {type: 'error', key: 'error'}
        : isEmpty
          ? {type: 'empty', key: 'empty'}
          : {type: 'loading', key: 'loading'},
    ]
  } else {
    rows = buildPrivateRows(notifications)
    if (isError) rows.push({type: 'loadMoreError', key: 'loadMoreError'})
  }

  const onRefresh = async () => {
    setIsPTRing(true)
    try {
      await refetch()
    } catch (err) {
      logger.error('Failed to refresh private notifications', {
        safeMessage: err,
      })
    }
    setIsPTRing(false)
  }

  const onEndReached = async () => {
    if (isFetching || !hasNextPage || isError) return
    try {
      await fetchNextPage()
    } catch (err) {
      logger.error('Failed to load more private notifications', {
        safeMessage: err,
      })
    }
  }

  return (
    <View style={[a.flex_1]}>
      <List
        ref={listRef}
        testID={`privateNotificationsList-${tab}`}
        style={[a.flex_1]}
        data={rows}
        keyExtractor={(row: Row) => row.key}
        renderItem={({item: row}: {item: Row}) => {
          switch (row.type) {
            case 'section':
              return <SectionHeader section={row.section} />
            case 'notification':
              return <NotificationItem notification={row.notification} />
            case 'loading':
              return <NotificationFeedLoadingPlaceholder />
            case 'empty':
              return (
                <View style={[a.px_lg, a.py_5xl]}>
                  <Text
                    style={[
                      a.text_md,
                      a.leading_snug,
                      a.text_center,
                      t.atoms.text_contrast_medium,
                    ]}>
                    {l`No activity on your private posts yet.`}
                  </Text>
                </View>
              )
            case 'error':
              return (
                <ErrorMessage
                  message={cleanError(error)}
                  onPressTryAgain={() => void refetch()}
                />
              )
            case 'loadMoreError':
              return (
                <LoadMoreRetryBtn
                  label={l`There was an issue fetching notifications. Tap here to try again.`}
                  onPress={() => void fetchNextPage()}
                />
              )
          }
        }}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={[a.pt_xl]}>
              <ActivityIndicator />
            </View>
          ) : undefined
        }
        refreshing={isPTRing}
        onRefresh={() => void onRefresh()}
        onEndReached={() => void onEndReached()}
        onEndReachedThreshold={2}
        contentContainerStyle={{paddingBottom: 200}}
        initialNumToRender={initialNumToRender}
        windowSize={11}
        sideBorders={false}
      />
      <RefreshPill
        visible={showRefreshPill}
        headerHeight={0}
        titleHeight={pillTitleHeight}
        onPress={loadLatest}
      />
    </View>
  )
}

/**
 * Drawn as the stock list's section header (not exported there).
 */
function SectionHeader({section}: {section: 'today' | 'earlier'}) {
  const t = useTheme()
  const {t: l} = useLingui()
  return (
    <View
      style={[
        a.px_lg,
        section === 'today'
          ? a.py_sm
          : [a.border_t, a.pt_md, a.pb_sm, t.atoms.border_contrast_low],
      ]}>
      <Text accessibilityRole="header" style={[a.text_md, a.font_bold]}>
        {section === 'today'
          ? l({message: 'Today', context: 'Notifications section header'})
          : l({message: 'Earlier', context: 'Notifications section header'})}
      </Text>
    </View>
  )
}
