/*
 * The Notifications settings screen's Public | Private folder tabs (Phase 3,
 * batch B, rolling list item 6), for members. Public is the stock screen.
 * Private mirrors the stock rows that private activity can cause: likes,
 * replies, mentions, quotes and reposts of private posts.
 *
 * The Private rows read and write prism's private notification preferences
 * (`preferences.ts`) while prism lists `private.notificationPreferences`
 * (2026-10-21): per reason, whether it shows and whose activity counts.
 * Without the feature they are shown disabled with a note, and nothing is
 * stored. While prism lists `private.activitySubscriptions` a sixth row,
 * "Activity from others", follows Reposts (activity subscriptions design
 * 2.5): one switch for new private posts from accounts whose bell is on.
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {ItemTextWithSubtitle} from '#/screens/Settings/NotificationSettings/components/ItemTextWithSubtitle'
import {atoms as a} from '#/alf'
import {Admonition} from '#/components/Admonition'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import * as Toggle from '#/components/forms/Toggle'
import {At_Stroke2_Corner2_Rounded as AtIcon} from '#/components/icons/At'
import {BellRinging_Stroke2_Corner0_Rounded as BellRingingIcon} from '#/components/icons/BellRinging'
import {Bubble_Stroke2_Corner2_Rounded as BubbleIcon} from '#/components/icons/Bubble'
import {Heart2_Stroke2_Corner0_Rounded as HeartIcon} from '#/components/icons/Heart2'
import {CloseQuote_Stroke2_Corner0_Rounded as CloseQuoteIcon} from '#/components/icons/Quote'
import {Repost_Stroke2_Corner2_Rounded as RepostIcon} from '#/components/icons/Repost'
import * as Layout from '#/components/Layout'
import {useActivitySubscriptionsShown} from '#/horizon/private/activity-subscriptions/hooks'
import {useIsMember} from '#/horizon/private/membership'
import {
  type PreferenceInclude,
  type PrivateNotificationPreference,
  type PrivateNotificationReason,
  type PrivatePlainPreference,
  usePrivateNotificationPreferences,
  usePrivateNotificationPreferencesServed,
  useSetPrivateNotificationPreference,
} from '#/horizon/private/notifications/preferences'
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

/** Each reason's row: icon, title and subtitle. */
function useReasonRows(): {
  reason: PrivateNotificationReason
  icon: typeof HeartIcon
  titleText: React.ReactNode
  subtitleText: React.ReactNode
}[] {
  return [
    {
      reason: 'like',
      icon: HeartIcon,
      titleText: <Trans>Likes</Trans>,
      subtitleText: <Trans>When people like your private posts</Trans>,
    },
    {
      reason: 'reply',
      icon: BubbleIcon,
      titleText: <Trans>Replies</Trans>,
      subtitleText: <Trans>When people reply to your private posts</Trans>,
    },
    {
      reason: 'mention',
      icon: AtIcon,
      titleText: <Trans>Mentions</Trans>,
      subtitleText: <Trans>When people mention you in private posts</Trans>,
    },
    {
      reason: 'quote',
      icon: CloseQuoteIcon,
      titleText: <Trans>Quotes</Trans>,
      subtitleText: <Trans>When people quote your private posts</Trans>,
    },
    {
      reason: 'repost',
      icon: RepostIcon,
      titleText: <Trans>Reposts</Trans>,
      subtitleText: <Trans>When people repost your private posts</Trans>,
    },
  ]
}

/**
 * The private rows: live while prism serves private notification
 * preferences (2026-10-21), otherwise disabled with a note.
 */
export function PrivateNotificationSettings() {
  const served = usePrivateNotificationPreferencesServed()
  const rows = useReasonRows()
  const activity = useActivitySubscriptionsShown()
  const {data, isError} = usePrivateNotificationPreferences()
  if (!served || !data) {
    return (
      <>
        <View style={[a.px_lg, a.pb_md]}>
          <Admonition type={served && isError ? 'error' : 'info'}>
            {!served ? (
              <Trans>
                Private notification settings arrive with server support.
              </Trans>
            ) : isError ? (
              <Trans>
                Your private notification settings couldn’t be loaded. Try again
                later.
              </Trans>
            ) : (
              <Trans>Loading your private notification settings…</Trans>
            )}
          </Admonition>
        </View>
        <View style={[a.gap_sm]}>
          {rows.map(row => (
            <DisabledRow
              key={row.reason}
              icon={row.icon}
              titleText={row.titleText}
              subtitleText={row.subtitleText}
            />
          ))}
          {activity && (
            <DisabledRow
              icon={BellRingingIcon}
              titleText={<ActivityTitle />}
              subtitleText={<ActivitySubtitle />}
            />
          )}
        </View>
      </>
    )
  }
  return (
    <View style={[a.gap_sm]}>
      {rows.map(row => (
        <PreferenceRow
          key={row.reason}
          reason={row.reason}
          icon={row.icon}
          titleText={row.titleText}
          subtitleText={row.subtitleText}
          preference={data[row.reason]}
        />
      ))}
      {activity && <ActivityRow preference={data.subscribedPost} />}
    </View>
  )
}

function ActivityTitle() {
  return <Trans>Activity from others</Trans>
}

function ActivitySubtitle() {
  return <Trans>New private posts from accounts you get notified about</Trans>
}

/**
 * "Activity from others": one switch for whether new private posts from
 * accounts whose bell is on show in Private notifications. No include
 * control; push is kept as stored.
 */
function ActivityRow({preference}: {preference: PrivatePlainPreference}) {
  const {t: l} = useLingui()
  const {mutate} = useSetPrivateNotificationPreference()
  return (
    <SettingsList.Item style={[a.flex_col, a.align_start, a.gap_sm]}>
      <View style={[a.w_full, a.flex_row, a.align_start, a.gap_sm]}>
        <SettingsList.ItemIcon icon={BellRingingIcon} />
        <ItemTextWithSubtitle
          titleText={<ActivityTitle />}
          subtitleText={<ActivitySubtitle />}
        />
        <Toggle.Item
          name="private_notification_subscribedPost"
          label={l`Show in Private notifications`}
          value={preference.list}
          onChange={list =>
            mutate({
              reason: 'subscribedPost',
              preference: {list, push: preference.push},
            })
          }>
          <Toggle.Platform />
        </Toggle.Item>
      </View>
    </SettingsList.Item>
  )
}

/**
 * One reason: a switch for whether it shows in Private notifications, and
 * while on, whose activity counts. Push is not offered while there is no
 * private push; its stored value is kept as it is.
 */
function PreferenceRow({
  reason,
  icon,
  titleText,
  subtitleText,
  preference,
}: {
  reason: PrivateNotificationReason
  icon: typeof HeartIcon
  titleText: React.ReactNode
  subtitleText: React.ReactNode
  preference: PrivateNotificationPreference
}) {
  const {t: l} = useLingui()
  const {mutate} = useSetPrivateNotificationPreference()
  const set = (next: Partial<PrivateNotificationPreference>) =>
    mutate({reason, preference: {...preference, ...next}})
  return (
    <SettingsList.Item style={[a.flex_col, a.align_start, a.gap_sm]}>
      <View style={[a.w_full, a.flex_row, a.align_start, a.gap_sm]}>
        <SettingsList.ItemIcon icon={icon} />
        <ItemTextWithSubtitle
          titleText={titleText}
          subtitleText={subtitleText}
        />
        <Toggle.Item
          name={`private_notification_${reason}`}
          label={l`Show in Private notifications`}
          value={preference.list}
          onChange={list => set({list})}>
          <Toggle.Platform />
        </Toggle.Item>
      </View>
      {preference.list && (
        <View style={[a.w_full]}>
          <SegmentedControl.Root
            type="radio"
            label={l`Whose activity notifies you`}
            value={preference.include}
            onChange={(include: PreferenceInclude) => set({include})}>
            <SegmentedControl.Item value="all" label={l`Everyone`}>
              <SegmentedControl.ItemText>
                {l`Everyone`}
              </SegmentedControl.ItemText>
            </SegmentedControl.Item>
            <SegmentedControl.Item value="follows" label={l`People I follow`}>
              <SegmentedControl.ItemText>
                {l`People I follow`}
              </SegmentedControl.ItemText>
            </SegmentedControl.Item>
          </SegmentedControl.Root>
        </View>
      )}
    </SettingsList.Item>
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
