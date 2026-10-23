/*
 * The bell dialog's Horizon side (activity subscriptions design 2.1 and
 * 2.3), used by the stock `SubscribeProfileDialog`: the optimistic save of
 * both pairs behind hook Dlg 1, and the "Private posts" and "Private
 * replies" toggles behind hook Dlg 2.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'
import {useQueryClient} from '@tanstack/react-query'

import {useAppviewClient, useSession} from '#/state/session'
import {atoms as a, platform, useTheme} from '#/alf'
import * as Dialog from '#/components/Dialog'
import * as Toggle from '#/components/forms/Toggle'
import {useAnalytics} from '#/analytics'
import {
  type Flags,
  isOn,
  OFF,
  sameFlags,
} from '#/horizon/private/activity-subscriptions/common'
import {useActivitySubscriptionsShown} from '#/horizon/private/activity-subscriptions/hooks'
import {usePrivateFlags} from '#/horizon/private/activity-subscriptions/private-state'
import {
  getActivitySavers,
  savePress,
} from '#/horizon/private/activity-subscriptions/saver'
import {useIsMember, usePrivateFeedSource} from '#/horizon/private/membership'
import type * as bsky from '#/types/bsky'

/**
 * A pair's toggles' change with the stock rule: a reply needs a post, so
 * turning on replies turns on posts, and turning off posts turns off both.
 */
export function nextPair(old: Flags, values: string[]): Flags {
  if (!old.reply && values.includes('reply')) return {post: true, reply: true}
  if (old.post && !values.includes('post')) return {post: false, reply: false}
  return {post: values.includes('post'), reply: values.includes('reply')}
}

/**
 * The dialog's Save for `profile`, whose public pair showed `initial` when
 * the dialog opened, and its private pair.
 *
 * The private pair applies for a member while the feature is shown. It is
 * seeded once: unset until prism's list first reports loaded, then the flags
 * at that moment (`privateInitial`), and later fetches while the dialog is
 * open change neither. Until then its toggles are disabled.
 *
 * `press(state, privateState)` closes the dialog with no request between
 * press and close; inside the close callback it sends each changed pair
 * (`savePress`: the cached truth read, the cache write and the saver) and
 * records the stock metric for the public pair.
 */
export function useActivitySubscriptionSave(
  profile: bsky.profile.AnyProfileView,
  initial: Flags,
) {
  const ax = useAnalytics()
  const appview = useAppviewClient()
  const queryClient = useQueryClient()
  const control = Dialog.useDialogContext()
  const {currentAccount} = useSession()
  const isMember = useIsMember()
  const shown = useActivitySubscriptionsShown()
  const source = usePrivateFeedSource()
  const current = usePrivateFlags(profile.did)
  const [privateInitial, setPrivateInitial] = useState<Flags | undefined>()
  const [privateState, setPrivateState] = useState<Flags | undefined>()
  if (privateInitial === undefined && current.loaded) {
    setPrivateInitial(current.flags)
    setPrivateState(current.flags)
  }
  const privateShown = isMember && shown
  const privateReady =
    privateShown && privateInitial !== undefined && privateState !== undefined
  const privateDirty =
    privateReady && !sameFlags(privateState, privateInitial)

  return {
    /** Whether the private toggles show (a member, the feature shown). */
    privateShown,
    /** Whether they are enabled: prism's list has loaded. */
    privateReady,
    privateState: privateState ?? OFF,
    privateInitial: privateInitial ?? OFF,
    /** The private pair changed since the seed. */
    privateDirty,
    /** Any private toggle is on. */
    privateHasAny: privateReady && isOn(privateState),
    /** A change of the private toggles, with the stock rule. */
    setPrivate(values: string[]) {
      setPrivateState(old => (old ? nextPair(old, values) : old))
    },

    press(state: Flags, privateAfter: Flags = privateState ?? OFF) {
      const did = currentAccount?.did
      if (!did) return
      const savers = getActivitySavers()
      const privateSent =
        privateReady && !sameFlags(privateAfter, privateInitial ?? OFF)
      // The account is captured now: nothing later reads the current one.
      const prism =
        privateSent && source?.did === did ? source.prism : undefined
      const ctx = {
        did,
        subject: profile.did,
        handle: profile.handle,
        profile,
        appview,
        prism,
        queryClient,
      }
      const before = {public: initial, private: privateInitial ?? OFF}
      const after = {
        public: state,
        private: prism ? privateAfter : before.private,
      }
      control.close(() => {
        savePress(savers, {ctx, before, after})
        if (sameFlags(initial, state)) return
        if (!state.post && !state.reply) {
          ax.metric('activitySubscription:disable', {})
        } else {
          ax.metric('activitySubscription:enable', {
            setting: state.reply ? 'posts_and_replies' : 'posts',
          })
        }
      })
    },
  }
}

/**
 * "Private posts" and "Private replies" under the stock group, styled as
 * the stock items (hook Dlg 2). Rendered only for a member while the feature
 * is shown; disabled until prism's list has loaded, so a press never writes
 * over an unknown value.
 */
export function PrivateActivityToggles({
  save,
}: {
  save: ReturnType<typeof useActivitySubscriptionSave>
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  if (!save.privateShown) return null
  const values: string[] = []
  if (save.privateState.post) values.push('post')
  if (save.privateState.reply) values.push('reply')
  const itemStyle = [
    a.flex_1,
    a.py_xs,
    platform({
      native: [a.justify_between],
      web: [a.flex_row_reverse, a.gap_sm],
    }),
  ]
  const labelStyle = [t.atoms.text, a.font_normal, a.text_md, a.flex_1]
  return (
    <Toggle.Group
      label={l`Subscribe to account activity in private posts`}
      values={values}
      onChange={save.setPrivate}
      disabled={!save.privateReady}>
      <View style={[a.gap_sm]}>
        <Toggle.Item
          label={l`Private posts`}
          name="post"
          style={itemStyle}>
          <Toggle.LabelText style={labelStyle}>
            <Trans>Private posts</Trans>
          </Toggle.LabelText>
          <Toggle.Switch />
        </Toggle.Item>
        <Toggle.Item
          label={l`Private replies`}
          name="reply"
          style={itemStyle}>
          <Toggle.LabelText style={labelStyle}>
            <Trans>Private replies</Trans>
          </Toggle.LabelText>
          <Toggle.Switch />
        </Toggle.Item>
      </View>
    </Toggle.Group>
  )
}
