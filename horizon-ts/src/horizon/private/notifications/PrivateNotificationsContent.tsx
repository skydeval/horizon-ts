/*
 * The notifications screen's Private view (design 9), in place of the stock
 * pager content (Notif 4): its own pills, All and Replies, over activity on
 * private posts for the reader, and Activity, new private posts from
 * accounts whose bell is on, while prism lists
 * `private.activitySubscriptions` (activity subscriptions design 2.5).
 *
 * While prism lists private notifications (`private.notifications`, P-9,
 * 2H design 10.3) each pill is a list of them with the stock notification
 * rows (`PrivateNotificationsList`); the Replies pill asks for replies,
 * quotes and mentions, and Activity for `subscribed-post`, its first page
 * prefetched as the view mounts. Otherwise the pills show the empty state
 * and no request is made.
 */

import {useEffect, useState} from 'react'
import {View} from 'react-native'
import {useSharedValue} from 'react-native-reanimated'
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

/**
 * The Private view below the notifications header, whose height is
 * `headerOffset`.
 */
export function PrivateNotificationsContent({
  headerOffset,
}: {
  headerOffset: number
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const bottomBarOffset = useBottomBarOffset()
  const [selected, setSelected] = useState<PrivateTab>('all')
  const progress = useSharedValue(0)
  const served = usePrismFeature('private.notifications')
  const activity = useActivitySubscriptionsShown()
  usePrefetchPrivateNotifications('activity', served && activity)

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
        <TabPills
          tabs={tabs}
          selectedTab={tab}
          dragProgress={progress}
          onSelectTab={key => {
            const index = Math.max(
              0,
              tabs.findIndex(item => item.key === key),
            )
            const next = tabs[index].key
            // Re-pressing the current pill scrolls it to the top, as stock
            if (next === tab) {
              emitSoftReset()
              return
            }
            progress.set(index)
            setSelected(next)
          }}
          contentContainerStyle={IS_WEB ? a.pb_sm : a.py_sm}
        />
        {served ? (
          <PrivateNotificationsList key={tab} tab={tab} />
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
