/*
 * The bell's visible side for the savers (activity subscriptions design
 * 2.3): the public pair's cache (the profile shadow and the stock cached list
 * of activity subscriptions), and the toasts a press ends with, the success
 * one in the stock dialog's wording.
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
  readFlags,
} from '#/horizon/private/activity-subscriptions/common'
import {type ActivityToasts} from '#/horizon/private/activity-subscriptions/saver'
import {type app} from '#/lexicons'
import type * as bsky from '#/types/bsky'

type ListData = InfiniteData<
  app.bsky.notification.listActivitySubscriptions.$OutputBody
>

/**
 * The shadow's `activitySubscription` as `setBell` last wrote it, per query
 * client (that is, per account) and subject. Only the bell writes that field
 * of the shadow, and the shadow has no synchronous getter, so this is its
 * current value.
 */
const written = new WeakMap<QueryClient, Map<string, Flags>>()

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
  let bells = written.get(queryClient)
  if (!bells) {
    bells = new Map()
    written.set(queryClient, bells)
  }
  bells.set(subject, flags)
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

/**
 * The public pair's cached truth for `subject` (2.3, `truth`): the shadow's
 * current value, or else the profile's own `viewer.activitySubscription`
 * (absent is off). Read inside the close callback before `setBell` writes
 * the press, never from the dialog's render.
 */
export function readBellTruth(
  queryClient: QueryClient | undefined,
  subject: string,
  profile?: bsky.profile.AnyProfileView,
): Flags {
  const shadowed = queryClient && written.get(queryClient)?.get(subject)
  if (shadowed) return shadowed
  return readFlags(profile?.viewer?.activitySubscription)
}

/** The toasts as the savers' press groups use them. */
export const bellUi: ActivityToasts = {
  savedToast(handle, after, before) {
    const name = sanitizeHandle(handle, '@')
    if (!isOn(after)) {
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
  privateFailedToast(handle, limit) {
    const name = sanitizeHandle(handle, '@')
    Toast.show(
      limit
        ? t`You’ve reached the limit for private notification subscriptions`
        : t`Couldn’t save private notification settings for ${name}`,
      {type: 'error'},
    )
  },
  combinedFailedToast(handle, limit) {
    const name = sanitizeHandle(handle, '@')
    Toast.show(
      limit
        ? t`Couldn’t save notification settings for ${name}. You’ve reached the limit for private notification subscriptions`
        : t`Couldn’t save notification settings for ${name}`,
      {type: 'error'},
    )
  },
}
