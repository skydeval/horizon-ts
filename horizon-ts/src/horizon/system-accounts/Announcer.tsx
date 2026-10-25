/*
 * The announcer's live regions (system accounts design 4.6), mounted empty
 * once per window at start-up by Horizon's session provider, so they exist
 * before their text changes. Web: one `role="status"` region (polite) and
 * one `role="alert"` region, visually hidden. Android: the same, as
 * `accessibilityLiveRegion` texts. iOS speaks through the system
 * announcement and renders nothing here.
 */

import {useSyncExternalStore} from 'react'
import {View} from 'react-native'

import {atoms as a} from '#/alf'
import {Text} from '#/components/Typography'
import {IS_IOS, IS_WEB} from '#/env'
import {getAnnouncerState, subscribeAnnouncer} from './announce'

export function SystemAccountsAnnouncer() {
  const state = useSyncExternalStore(subscribeAnnouncer, getAnnouncerState)
  if (IS_IOS) return null
  if (IS_WEB) {
    return (
      <View pointerEvents="none" style={[a.sr_only]}>
        <View
          role="status"
          aria-live="polite"
          testID="systemAccountsAnnouncerStatus">
          <Text>{state.polite[0]}</Text>
          <Text>{state.polite[1]}</Text>
        </View>
        <View role="alert" testID="systemAccountsAnnouncerAlert">
          <Text>{state.alert[0]}</Text>
          <Text>{state.alert[1]}</Text>
        </View>
      </View>
    )
  }
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="yes"
      style={[{position: 'absolute', width: 1, height: 1, opacity: 0}]}>
      <Text accessibilityLiveRegion="polite">
        {state.polite[0] || state.polite[1]}
      </Text>
      <Text accessibilityLiveRegion="assertive">
        {state.alert[0] || state.alert[1]}
      </Text>
    </View>
  )
}
