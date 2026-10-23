/*
 * The render gate of activity subscriptions for private posts (activity
 * subscriptions design 2.5, the gate) as a hook for the session's account.
 */

import {ACTIVITY_FEATURE} from '#/horizon/private/activity-subscriptions/common'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {PRIVATE_ACTIVITY_SUBSCRIPTIONS} from '#/horizon/switches'

/**
 * Whether the private side shows for the session's account: the switch, and
 * prism listing `private.activitySubscriptions` (a held list counts). For
 * the pill, the settings row, the private toggles, the bell icon, prism's
 * list and the mute filter.
 */
export function useActivitySubscriptionsShown(): boolean {
  const served = usePrismFeature(ACTIVITY_FEATURE)
  return PRIVATE_ACTIVITY_SUBSCRIPTIONS && served
}
