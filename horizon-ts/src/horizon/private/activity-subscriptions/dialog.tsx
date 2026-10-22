/*
 * The bell dialog's Horizon side (activity subscriptions design 2.1 and
 * 2.4): the optimistic save behind hook Dlg 1, and the private-posts line
 * behind hook Dlg 2, both used by the stock `SubscribeProfileDialog`.
 */

import {Trans} from '@lingui/react/macro'
import {useQueryClient} from '@tanstack/react-query'

import {useAppviewClient, useSession} from '#/state/session'
import {atoms as a, useTheme} from '#/alf'
import * as Dialog from '#/components/Dialog'
import {Text} from '#/components/Typography'
import {useAnalytics} from '#/analytics'
import {type Flags} from '#/horizon/private/activity-subscriptions/common'
import {useActivitySubscriptionsShown} from '#/horizon/private/activity-subscriptions/hooks'
import {getActivityTab} from '#/horizon/private/activity-subscriptions/tab'
import {setBell} from '#/horizon/private/activity-subscriptions/ui'
import {useIsMember} from '#/horizon/private/membership'
import {
  ACTIVITY_DIALOG_PRIVATE_LINE,
  OPTIMISTIC_ACTIVITY_SUBSCRIPTIONS,
  PRIVATE_ACTIVITY_SUBSCRIPTIONS,
} from '#/horizon/switches'
import type * as bsky from '#/types/bsky'

/**
 * The dialog's Save for `profile`, whose bell showed `initial` when the
 * dialog opened.
 *
 * `press(flags)` marks the subject dirty (one synchronous device write) and,
 * with `OPTIMISTIC_ACTIVITY_SUBSCRIPTIONS` on, closes the dialog with no
 * request between press and close: inside the close callback it writes the
 * shadow and the cached list, records the metric and hands the press to the
 * saver. It returns `true` then, and the stock mutation is not used. With the
 * switch off it returns `false` and the stock wait runs, which reports its
 * answer with `stockAnswered`.
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

  const context = (did: string) => ({
    did,
    subject: profile.did,
    handle: profile.handle,
    profile,
    appview,
    queryClient,
    before: initial,
  })

  return {
    press(flags: Flags): boolean {
      const did = currentAccount?.did
      if (!did) return false
      const activity = getActivityTab()
      // The account is captured now: nothing later reads the current one.
      const ctx = context(did)
      if (PRIVATE_ACTIVITY_SUBSCRIPTIONS) {
        activity.mirror.markPressed(did, profile.did)
      }
      if (!OPTIMISTIC_ACTIVITY_SUBSCRIPTIONS) {
        activity.saver.stockPress(ctx, flags)
        return false
      }
      control.close(() => {
        setBell(queryClient, profile.did, flags, profile)
        if (!flags.post && !flags.reply) {
          ax.metric('activitySubscription:disable', {})
        } else {
          ax.metric('activitySubscription:enable', {
            setting: flags.reply ? 'posts_and_replies' : 'posts',
          })
        }
        activity.saver.press(ctx, flags)
      })
      return true
    },

    /** The stock wait's answer (switch off): `ok` when Bluesky accepted. */
    stockAnswered(flags: Flags, ok: boolean) {
      const did = currentAccount?.did
      if (!did) return
      getActivityTab().saver.stockAnswered(did, profile.did, flags, ok)
    },
  }
}

/**
 * "Includes their private posts that you can see." under the dialog's
 * subtitle, for a member while prism lists `private.activitySubscriptions`
 * (SQ-1). It adds no control.
 */
export function ActivityDialogPrivateLine() {
  const t = useTheme()
  const isMember = useIsMember()
  const shown = useActivitySubscriptionsShown()
  if (!ACTIVITY_DIALOG_PRIVATE_LINE || !isMember || !shown) return null
  return (
    <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
      <Trans>Includes their private posts that you can see.</Trans>
    </Text>
  )
}
