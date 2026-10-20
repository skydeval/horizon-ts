/*
 * The Notifications settings screen's Public | Private folder tabs (Phase 3,
 * batch B, rolling list item 6), for members. Public is the stock screen.
 * Private mirrors the stock rows that private activity can cause: likes,
 * replies, mentions, quotes and reposts of private posts.
 *
 * prism has no private notification preference methods yet (its lexicons
 * name none), so the Private rows are shown disabled with a note and nothing
 * is stored. They are wired to prism's preference methods, behind the
 * `private.notifications` feature, once prism serves them (a dependency,
 * logged in the Phase 3 log).
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {ItemTextWithSubtitle} from '#/screens/Settings/NotificationSettings/components/ItemTextWithSubtitle'
import {atoms as a} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {At_Stroke2_Corner2_Rounded as AtIcon} from '#/components/icons/At'
import {Bubble_Stroke2_Corner2_Rounded as BubbleIcon} from '#/components/icons/Bubble'
import {Heart2_Stroke2_Corner0_Rounded as HeartIcon} from '#/components/icons/Heart2'
import {CloseQuote_Stroke2_Corner0_Rounded as CloseQuoteIcon} from '#/components/icons/Quote'
import {Repost_Stroke2_Corner2_Rounded as RepostIcon} from '#/components/icons/Repost'
import * as Layout from '#/components/Layout'
import {useIsMember} from '#/horizon/private/membership'
import {
  offersNotificationSettingsTabs,
  setNotificationSettingsMode,
  useNotificationSettingsMode,
} from '#/horizon/private/notifications/settings-mode'
import {FolderTabs} from '#/horizon/private/tabs/FolderTabs'
import {type PrivateMode} from '#/horizon/private/tabs/mode-store'

/**
 * The Public | Private tabs under the screen's header. Members only;
 * nothing renders for anyone else.
 *
 * The screen mounts them straight in `Layout.Screen`, which does not centre
 * its children (the header and the content each centre themselves), so the
 * tabs sit in `Layout.Center` to take the centre column, as the header does
 * and as Saved's tabs do (`SavedModeTabs`). Without it they drew from the
 * window's left edge, over the left nav (round 2 list, item 1).
 */
export function NotificationSettingsTabs() {
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const isMember = useIsMember()
  const mode = useNotificationSettingsMode()
  if (!currentAccount || !offersNotificationSettingsTabs(isMember)) return null
  return (
    <Layout.Center>
      <FolderTabs<PrivateMode>
        testID="notificationSettingsTabs"
        tabs={[
          {key: 'public', label: l`Public`},
          {key: 'private', label: l`Private`},
        ]}
        selected={mode}
        onSelect={next => setNotificationSettingsMode(currentAccount.did, next)}
      />
    </Layout.Center>
  )
}

/**
 * The screen while the Private tab is chosen: the stock header, the tabs,
 * and the private notification settings.
 */
export function PrivateNotificationSettingsScreen() {
  return (
    <Layout.Screen testID="privateNotificationSettingsScreen">
      <Layout.Header.Outer>
        <Layout.Header.BackButton />
        <Layout.Header.Content>
          <Layout.Header.TitleText>
            <Trans>Notifications</Trans>
          </Layout.Header.TitleText>
        </Layout.Header.Content>
        <Layout.Header.Slot />
      </Layout.Header.Outer>
      <NotificationSettingsTabs />
      <Layout.Content>
        <SettingsList.Container>
          <PrivateNotificationSettings />
        </SettingsList.Container>
      </Layout.Content>
    </Layout.Screen>
  )
}

/**
 * The private rows, disabled until prism serves private notification
 * preferences.
 */
export function PrivateNotificationSettings() {
  return (
    <>
      <View style={[a.px_lg, a.pb_md]}>
        <Admonition type="info">
          <Trans>
            Private notification settings arrive with server support.
          </Trans>
        </Admonition>
      </View>
      <View style={[a.gap_sm]}>
        <DisabledRow
          icon={HeartIcon}
          titleText={<Trans>Likes</Trans>}
          subtitleText={<Trans>When people like your private posts</Trans>}
        />
        <DisabledRow
          icon={BubbleIcon}
          titleText={<Trans>Replies</Trans>}
          subtitleText={<Trans>When people reply to your private posts</Trans>}
        />
        <DisabledRow
          icon={AtIcon}
          titleText={<Trans>Mentions</Trans>}
          subtitleText={<Trans>When people mention you in private posts</Trans>}
        />
        <DisabledRow
          icon={CloseQuoteIcon}
          titleText={<Trans>Quotes</Trans>}
          subtitleText={<Trans>When people quote your private posts</Trans>}
        />
        <DisabledRow
          icon={RepostIcon}
          titleText={<Trans>Reposts</Trans>}
          subtitleText={<Trans>When people repost your private posts</Trans>}
        />
      </View>
    </>
  )
}

function DisabledRow({
  icon,
  titleText,
  subtitleText,
}: {
  icon: typeof HeartIcon
  titleText: React.ReactNode
  subtitleText: React.ReactNode
}) {
  return (
    <View
      accessible
      accessibilityState={{disabled: true}}
      style={[{opacity: 0.5}]}>
      <SettingsList.Item style={[a.align_start]}>
        <SettingsList.ItemIcon icon={icon} />
        <ItemTextWithSubtitle
          titleText={titleText}
          subtitleText={subtitleText}
        />
      </SettingsList.Item>
    </View>
  )
}
