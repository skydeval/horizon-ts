/*
 * Private notification preferences (prism, 2026-10-21): one stock
 * `filterablePreference` per reason a private notification has, read and
 * written on prism, honoured by prism's list and unread count. The Private
 * settings tab reads them with `usePrivateNotificationPreferences` and
 * writes one reason at a time with `useSetPrivateNotificationPreference`,
 * which shows the change at once and puts the server's answer back after.
 * Both need a private source and prism listing
 * `private.notificationPreferences`.
 *
 * `subscribedPost` (activity subscriptions design 2.7) is a stock
 * `#preference`, `{list, push}` with no `include`: whether new private posts
 * from accounts whose bell is on show. A missing key reads as on, so a toggle
 * never snaps back on an older prism.
 */

import {type Client} from '@atproto/lex'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {nearhorizon} from '#/horizon/lexicons'
import {reportedPrismCall} from '#/horizon/private/api/reads'
import {
  PRIVATE_NOTIFICATIONS_ROOT,
  PRIVATE_UNREAD_OWN_ROOT,
  PRIVATE_UNREAD_ROOT,
} from '#/horizon/private/cache-finders'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {usePrivateFeedSource} from '#/horizon/private/membership'

/** The reasons a private notification has, in the settings' order. */
export const PRIVATE_NOTIFICATION_REASONS = [
  'like',
  'reply',
  'mention',
  'quote',
  'repost',
] as const

export type PrivateNotificationReason =
  (typeof PRIVATE_NOTIFICATION_REASONS)[number]

/** Whose activity a reason counts. */
export type PreferenceInclude = 'all' | 'follows'

/** One reason's preference. */
export type PrivateNotificationPreference = {
  include: PreferenceInclude
  list: boolean
  push: boolean
}

/** A preference with no `include` (stock `#preference`). */
export type PrivatePlainPreference = {list: boolean; push: boolean}

export type PrivateNotificationPreferences = Record<
  PrivateNotificationReason,
  PrivateNotificationPreference
> & {subscribedPost: PrivatePlainPreference}

/** A key `putPrivateNotificationPreference` writes, with its value. */
export type PrivateNotificationPreferenceWrite =
  | {reason: PrivateNotificationReason; preference: PrivateNotificationPreference}
  | {reason: 'subscribedPost'; preference: PrivatePlainPreference}

/** prism's default for every reason: shown, from everyone. */
export const DEFAULT_PRIVATE_NOTIFICATION_PREFERENCE: PrivateNotificationPreference =
  {include: 'all', list: true, push: true}

/** The default of `subscribedPost`: shown. */
export const DEFAULT_SUBSCRIBED_POST_PREFERENCE: PrivatePlainPreference = {
  list: true,
  push: true,
}

/**
 * A preference as read: an unknown `include` reads as `all`, so a value a
 * newer prism adds never hides a reason.
 */
function readPreference(raw: {
  include: string
  list: boolean
  push: boolean
}): PrivateNotificationPreference {
  return {
    include: raw.include === 'follows' ? 'follows' : 'all',
    list: raw.list,
    push: raw.push,
  }
}

function readPreferences(
  raw: Record<
    PrivateNotificationReason,
    {include: string; list: boolean; push: boolean}
  > & {subscribedPost?: {list: boolean; push: boolean}},
): PrivateNotificationPreferences {
  const out = {} as PrivateNotificationPreferences
  for (const reason of PRIVATE_NOTIFICATION_REASONS) {
    out[reason] = raw[reason]
      ? readPreference(raw[reason])
      : DEFAULT_PRIVATE_NOTIFICATION_PREFERENCE
  }
  out.subscribedPost = raw.subscribedPost
    ? {list: raw.subscribedPost.list, push: raw.subscribedPost.push}
    : DEFAULT_SUBSCRIBED_POST_PREFERENCE
  return out
}

/** The reader's private notification preferences. */
export async function getPrivateNotificationPreferences(
  prism: Client,
): Promise<PrivateNotificationPreferences> {
  const res = await reportedPrismCall(() =>
    prism.call(nearhorizon.privateGetNotificationPreferences, {}),
  )
  return readPreferences(res.preferences)
}

/**
 * Replaces one key's preference; returns every preference after the write.
 */
export async function putPrivateNotificationPreference(
  prism: Client,
  {reason, preference}: PrivateNotificationPreferenceWrite,
): Promise<PrivateNotificationPreferences> {
  const res = await reportedPrismCall(() =>
    prism.call(
      nearhorizon.privatePutNotificationPreferences,
      reason === 'subscribedPost'
        ? {subscribedPost: {list: preference.list, push: preference.push}}
        : {[reason]: preference},
    ),
  )
  return readPreferences(res.preferences)
}

export const PRIVATE_NOTIFICATION_PREFERENCES_ROOT =
  'horizon-private-notification-preferences'

function preferencesKey(did: string) {
  return [PRIVATE_NOTIFICATION_PREFERENCES_ROOT, did]
}

/** The private source, when prism serves preferences. */
function usePreferencesSource() {
  const source = usePrivateFeedSource()
  const served = usePrismFeature('private.notificationPreferences')
  return served ? source : undefined
}

/** Whether the Private settings tab can read and write preferences. */
export function usePrivateNotificationPreferencesServed(): boolean {
  return usePreferencesSource() !== undefined
}

export function usePrivateNotificationPreferences() {
  const source = usePreferencesSource()
  return useQuery({
    enabled: !!source,
    staleTime: STALE.MINUTES.ONE,
    queryKey: preferencesKey(source?.did ?? ''),
    queryFn: () => {
      if (!source) throw new Error('private preferences: no source')
      return getPrivateNotificationPreferences(source.prism)
    },
  })
}

/**
 * Writes one key. The change shows at once; on failure the previous
 * value comes back. Afterwards the private list and counts are asked
 * again, since the preferences filter them.
 */
export function useSetPrivateNotificationPreference() {
  const source = usePreferencesSource()
  const queryClient = useQueryClient()
  const key = preferencesKey(source?.did ?? '')
  return useMutation({
    mutationFn: (write: PrivateNotificationPreferenceWrite) => {
      if (!source) throw new Error('private preferences: no source')
      return putPrivateNotificationPreference(source.prism, write)
    },
    onMutate: async ({reason, preference}) => {
      await queryClient.cancelQueries({queryKey: key})
      const previous =
        queryClient.getQueryData<PrivateNotificationPreferences>(key)
      if (previous) {
        queryClient.setQueryData<PrivateNotificationPreferences>(key, {
          ...previous,
          [reason]: preference,
        })
      }
      return {previous}
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous)
    },
    onSuccess: preferences => {
      queryClient.setQueryData(key, preferences)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: [PRIVATE_NOTIFICATIONS_ROOT],
      })
      void queryClient.invalidateQueries({queryKey: [PRIVATE_UNREAD_ROOT]})
      void queryClient.invalidateQueries({queryKey: [PRIVATE_UNREAD_OWN_ROOT]})
    },
  })
}
