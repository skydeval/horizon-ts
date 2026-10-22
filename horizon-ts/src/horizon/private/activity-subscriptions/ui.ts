/*
 * The bell's visible side for the saver and the mirror (activity
 * subscriptions design 2.1, 2.2): the profile shadow, the stock cached list
 * of activity subscriptions, and the toasts, with the stock dialog's success
 * wording.
 */

import {t} from '@lingui/core/macro'
import {type InfiniteData, type QueryClient} from '@tanstack/react-query'

import {sanitizeHandle} from '#/lib/strings/handles'
import {updateProfileShadow} from '#/state/cache/profile-shadow'
import {RQKEY_getActivitySubscriptions} from '#/state/queries/activity-subscriptions'
import * as Toast from '#/components/Toast'
import {
  type Flags,
  isOn,
} from '#/horizon/private/activity-subscriptions/common'
import {type BellUi} from '#/horizon/private/activity-subscriptions/saver'
import {type app} from '#/lexicons'
import type * as bsky from '#/types/bsky'

type ListData = InfiniteData<
  app.bsky.notification.listActivitySubscriptions.$OutputBody
>

/**
 * Set the bell for `subject`: the profile shadow, and the cached list (an
 * off removes the subject, as the stock dialog does; an on adds the profile
 * when it is known and absent, and the shadow updates a present one).
 */
export function setBell(
  queryClient: QueryClient | undefined,
  subject: string,
  flags: Flags,
  profile?: bsky.profile.AnyProfileView,
) {
  if (!queryClient) return
  const activitySubscription = {post: flags.post, reply: flags.reply}
  updateProfileShadow(queryClient, subject, {activitySubscription})
  queryClient.setQueryData(
    RQKEY_getActivitySubscriptions,
    (old?: ListData) => {
      if (!old) return old
      if (!isOn(flags)) {
        return {
          ...old,
          pages: old.pages.map(page => ({
            ...page,
            subscriptions: page.subscriptions.filter(
              item => item.did !== subject,
            ),
          })),
        }
      }
      const present = old.pages.some(page =>
        page.subscriptions.some(item => item.did === subject),
      )
      if (present || !profile || old.pages.length === 0) return old
      const added = {
        ...(profile as app.bsky.actor.defs.ProfileView),
        viewer: {...profile.viewer, activitySubscription},
      }
      const [first, ...rest] = old.pages
      return {
        ...old,
        pages: [
          {...first, subscriptions: [added, ...first.subscriptions]},
          ...rest,
        ],
      }
    },
  )
}

/** The bell's UI as the saver and the mirror use it. */
export const bellUi: BellUi = {
  setBell,
  savedToast(handle, flags, before) {
    const name = sanitizeHandle(handle, '@')
    if (!isOn(flags)) {
      Toast.show(t`You will no longer receive notifications for ${name}`, {
        type: 'success',
      })
    } else if (!isOn(before)) {
      Toast.show(t`You’ll start receiving notifications for ${name}!`, {
        type: 'success',
      })
    } else {
      Toast.show(t`Changes saved`, {type: 'success'})
    }
  },
  failedToast(handle) {
    const name = sanitizeHandle(handle, '@')
    Toast.show(t`Couldn’t save notification settings for ${name}`, {
      type: 'error',
    })
  },
  mirrorPendingToast(flags) {
    Toast.show(
      isOn(flags)
        ? t`Saved. Notifications for their private posts will start once Horizon reaches the server.`
        : t`Saved. Their private posts may still notify you for a little while.`,
      {type: 'info'},
    )
  },
}
