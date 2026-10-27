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
 *
 * While prism is busy (prism busy design 6.7, 4.1, 5): a load that begins
 * while the account is not confirmed hides groups whose subject is another
 * author's private post until a page fetched since holds them, with the
 * catching-up note at the top (also after 20 s of ill health, design 10).
 * The gated mount asks for the first page again, joining one in flight. Once
 * the account is confirmed the list lifts itself: at the top it refreshes
 * from the top, scrolled down it offers the "Refresh" pill. With nothing to
 * show, the skeleton waits at most 30 s, then the quiet row with Try again.
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
import {isTransientPrismError} from '#/horizon/private/api/transient'
import {usePrismFeatureForWrite} from '#/horizon/private/features-hooks'
import {isPageDegraded} from '#/horizon/private/feed/degraded'
import {useEmptyWaitCapped, useLoadGate} from '#/horizon/private/load-gate'
import {usePrivateFeedSource} from '#/horizon/private/membership'
import {
  gateNotificationPages,
  notificationPrivateUris,
} from '#/horizon/private/notifications/busy'
import {
  type PrivateNotificationsPage,
  type PrivateNotificationsTab,
} from '#/horizon/private/notifications/page'
import {
  usePrivateNotificationsQuery,
  usePrivateUnreadCheck,
} from '#/horizon/private/notifications/query'
import {
  isPrivateRefreshPillVisible,
  privateNotificationsQueryKey,
  refreshPrivateNotifications,
} from '#/horizon/private/notifications/refresh'
import {markPrivateNotificationsSeen} from '#/horizon/private/notifications/unread'
import {ListUnavailable} from '#/horizon/private/render/ListUnavailable'
import {CatchingUpNote} from '#/horizon/private/status/CatchingUpNote'

type Row =
  | {type: 'section'; key: string; section: 'today' | 'earlier'}
  | {type: 'notification'; key: string; notification: NotificationView}
  | {type: 'loading'; key: string}
  | {type: 'empty'; key: string}
  | {type: 'error'; key: string}
  | {type: 'unavailable'; key: string}
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
  headerOffset = 0,
}: {
  tab: PrivateNotificationsTab
  /** The notifications header's height, pills included: the refresh pill sits below it. */
  headerOffset?: number
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
    data: queryData,
    isFetched,
    isFetching,
    isError,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
    status,
  } = usePrivateNotificationsQuery({tab})

  // The load gate (busy design 6.7, 4.1), after the query so its fetch is joined.
  const did = source?.did
  const queryKey = privateNotificationsQueryKey(did ?? '', tab)
  const isScrolledDown = useRef(false)
  const [liftMark, setLiftMark] = useState<number | undefined>(undefined)
  const gate = useLoadGate<{pages: PrivateNotificationsPage[]}>(
    did,
    queryKey,
    raw =>
      raw.pages.flatMap(page =>
        page.notifications.flatMap(notificationPrivateUris),
      ),
    {
      hiddenOf: (raw, since) =>
        gateNotificationPages(raw.pages, did, since).hidden,
      refreshFromTop: () => {
        if (!did) return
        gate.restart()
        void refreshPrivateNotifications(queryClient, did, tab)
      },
      isAtTop: () => !isScrolledDown.current,
      onScrolledDownLift: () => setLiftMark(Date.now()),
      trimmedOf: raw => isPageDegraded(raw.pages[0]),
    },
  )
  const gated = queryData
    ? gateNotificationPages(
        queryData.pages as PrivateNotificationsPage[],
        did,
        gate.loadSince,
      )
    : undefined
  const data =
    queryData && gated && gated.hidden > 0
      ? {...queryData, pages: gated.pages}
      : queryData
  const capped = useEmptyWaitCapped(
    !queryData && status === 'pending' && isFetching,
  )

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
    gate.restart()
    setLiftMark(undefined)
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
    stale: liftMark,
  })
  // The header doesn't hide over the Private view, so the pill stays beneath it
  const pillTitleHeight = useSharedValue(0)

  const notifications = data?.pages.flatMap(page => page.notifications) ?? []
  const isEmpty =
    isFetched && !isError && notifications.length === 0 && !hasNextPage

  let rows: Row[]
  // Every group hidden by the gate, with no fetch to bring them: the quiet row.
  const allHidden =
    !!gated && gated.hidden > 0 && notifications.length === 0 && !isFetching
  if (capped || allHidden || (isError && isTransientPrismError(error))) {
    if (notifications.length === 0) {
      rows = [{type: 'unavailable', key: 'unavailable'}]
    } else {
      rows = buildPrivateRows(notifications)
      rows.push({type: 'loadMoreError', key: 'loadMoreError'})
    }
  } else if (notifications.length === 0) {
    rows = [
      isError
        ? {type: 'error', key: 'error'}
        : isEmpty && !(gated && gated.hidden > 0)
          ? {type: 'empty', key: 'empty'}
          : {type: 'loading', key: 'loading'},
    ]
  } else {
    rows = buildPrivateRows(notifications)
    if (isError) rows.push({type: 'loadMoreError', key: 'loadMoreError'})
  }

  const onRefresh = async () => {
    setIsPTRing(true)
    gate.restart()
    setLiftMark(undefined)
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
                    {tab === 'activity'
                      ? l`New private posts from accounts you get notified about will show here.`
                      : l`No activity on your private posts yet.`}
                  </Text>
                </View>
              )
            case 'unavailable':
              return <ListUnavailable queryKey={queryKey} />
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
        onScrolledDownChange={(down: boolean) => {
          isScrolledDown.current = down
        }}
        ListHeaderComponent={
          <CatchingUpNote hidden={gate.hidden} illHealth />
        }
        onEndReached={() => void onEndReached()}
        onEndReachedThreshold={2}
        contentContainerStyle={{paddingBottom: 200}}
        initialNumToRender={initialNumToRender}
        windowSize={11}
        sideBorders={false}
      />
      <RefreshPill
        visible={showRefreshPill}
        headerHeight={headerOffset}
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
