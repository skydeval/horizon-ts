/*
 * The notifications screen's Private view (design 9), in place of the stock
 * pager content (Notif 4): its own pills, All and Replies, over activity on
 * private posts for the reader, and Activity, new private posts from
 * accounts whose bell is on, while prism lists
 * `private.activitySubscriptions` (activity subscriptions design 2.5).
 *
 * The pills sit in the notifications header, as the public pills do
 * (`PrivateNotificationsPills`), so they stay put while the list scrolls;
 * in the page they slid under the fixed header on web and peeked out below
 * it (2026-10-27). `usePrivateNotificationsTabs` holds the selection both
 * read.
 *
 * While prism lists private notifications (`private.notifications`, P-9,
 * 2H design 10.3) each pill is a list of them with the stock notification
 * rows (`PrivateNotificationsList`); the Replies pill asks for replies,
 * quotes and mentions, and Activity for `subscribed-post`, its first page
 * prefetched while the view is shown. Otherwise the pills show the empty
 * state and no request is made.
 */

import {useEffect, useState} from 'react'
import {View} from 'react-native'
import {type SharedValue, useSharedValue} from 'react-native-reanimated'
import {Trans, useLingui} from '@lingui/react/macro'

import {useBottomBarOffset} from '#/lib/hooks/useBottomBarOffset'
import {emitSoftReset} from '#/state/events'
import {TabPills} from '#/screens/Notifications/components/TabPills'
import {atoms as a, useTheme, web} from '#/alf'
import * as Layout from '#/components/Layout'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {useActivitySubscriptionsShown} from '#/horizon/private/activity-subscriptions/hooks'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {type PrivateNotificationsTab} from '#/horizon/private/notifications/page'
import {PrivateNotificationsList} from '#/horizon/private/notifications/PrivateNotificationsList'
import {usePrefetchPrivateNotifications} from '#/horizon/private/notifications/query'

type PrivateTab = PrivateNotificationsTab

/** The Private view's pills and their selection, shared by header and list. */
export type PrivateNotificationsTabs = {
  tabs: {key: PrivateTab; label: string}[]
  tab: PrivateTab
  progress: SharedValue<number>
  served: boolean
  onSelectTab: (key: string) => void
}

/**
 * The Private view's pill state. `shown` is whether the view is on screen,
 * which gates the Activity prefetch.
 */
export function usePrivateNotificationsTabs(
  shown: boolean,
): PrivateNotificationsTabs {
  const {t: l} = useLingui()
  const [selected, setSelected] = useState<PrivateTab>('all')
  const progress = useSharedValue(0)
  const served = usePrismFeature('private.notifications')
  const activity = useActivitySubscriptionsShown()
  usePrefetchPrivateNotifications('activity', shown && served && activity)

  const tabs = privateNotificationTabs(activity, {
    all: l`All`,
    replies: l`Replies`,
    activity: l`Activity`,
  })
  // The feature went while Activity was selected: back to All.
  const tab = tabs.some(item => item.key === selected) ? selected : 'all'
  if (tab !== selected) setSelected(tab)
  const index = tabs.findIndex(item => item.key === tab)
  useEffect(() => {
    if (progress.get() > tabs.length - 1) progress.set(index)
  }, [progress, index, tabs.length])

  const onSelectTab = (key: string) => {
    const next = tabs[Math.max(0, tabs.findIndex(item => item.key === key))]
    // Re-pressing the current pill scrolls it to the top, as stock
    if (next.key === tab) {
      emitSoftReset()
      return
    }
    progress.set(tabs.indexOf(next))
    setSelected(next.key)
  }

  return {tabs, tab, progress, served, onSelectTab}
}

/** The Private view's pills, for the notifications header. */
export function PrivateNotificationsPills({
  state,
}: {
  state: PrivateNotificationsTabs
}) {
  return (
    <TabPills
      tabs={state.tabs}
      selectedTab={state.tab}
      dragProgress={state.progress}
      onSelectTab={state.onSelectTab}
      contentContainerStyle={IS_WEB ? a.pb_sm : a.py_sm}
    />
  )
}

/**
 * The Private view below the notifications header, whose height (pills
 * included) is `headerOffset`.
 */
export function PrivateNotificationsContent({
  headerOffset,
  state,
}: {
  headerOffset: number
  state: PrivateNotificationsTabs
}) {
  const t = useTheme()
  const bottomBarOffset = useBottomBarOffset()

  return (
    <View
      testID="privateNotificationsContent"
      style={[
        a.flex_1,
        {paddingTop: headerOffset},
        // The stock empty state's height: the page less the bottom bar
        web({minHeight: `calc(100vh - ${bottomBarOffset}px)`}),
      ]}>
      <Layout.Center style={[a.flex_1]}>
        {state.served ? (
          <PrivateNotificationsList
            key={state.tab}
            tab={state.tab}
            headerOffset={headerOffset}
          />
        ) : (
          <View style={[a.flex_1, a.justify_center, a.px_lg]}>
            <Text
              style={[
                a.text_md,
                a.leading_snug,
                a.text_center,
                t.atoms.text_contrast_medium,
              ]}>
              <Trans>Activity on private posts will show here.</Trans>
            </Text>
          </View>
        )}
      </Layout.Center>
    </View>
  )
}

/**
 * The Private view's pills in order: All and Replies, and Activity while
 * prism lists `private.activitySubscriptions`. A pill's index is its drag
 * progress.
 */
export function privateNotificationTabs(
  activity: boolean,
  labels: Record<PrivateTab, string>,
): {key: PrivateTab; label: string}[] {
  const tabs: {key: PrivateTab; label: string}[] = [
    {key: 'all', label: labels.all},
    {key: 'replies', label: labels.replies},
  ]
  if (activity) tabs.push({key: 'activity', label: labels.activity})
  return tabs
}
