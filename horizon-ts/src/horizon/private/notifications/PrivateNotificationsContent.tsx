/*
 * The notifications screen's Private view (design 9), in place of the stock
 * pager content (Notif 4): its own pills, All and Replies, over activity on
 * private posts for the reader.
 *
 * While prism lists private notifications (`private.notifications`, P-9,
 * 2H design 10.3) each pill is a list of them with the stock notification
 * rows (`PrivateNotificationsList`); the Replies pill asks for replies,
 * quotes and mentions. Otherwise both pills show the empty state and no
 * request is made.
 */

import {useState} from 'react'
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
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {type PrivateNotificationsTab} from '#/horizon/private/notifications/page'
import {PrivateNotificationsList} from '#/horizon/private/notifications/PrivateNotificationsList'

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
  const [tab, setTab] = useState<PrivateTab>('all')
  const progress = useSharedValue(0)
  const served = usePrismFeature('private.notifications')

  const tabs: {key: PrivateTab; label: string}[] = [
    {key: 'all', label: l`All`},
    {key: 'replies', label: l`Replies`},
  ]

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
            const next: PrivateTab = key === 'replies' ? 'replies' : 'all'
            // Re-pressing the current pill scrolls it to the top, as stock
            if (next === tab) {
              emitSoftReset()
              return
            }
            progress.set(next === 'replies' ? 1 : 0)
            setTab(next)
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
