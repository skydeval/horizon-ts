/*
 * The non-hook form of the activity subscriptions gate (activity
 * subscriptions design 2.5, the gate), for code outside React that is given
 * the account's DID.
 */

import {ACTIVITY_FEATURE} from '#/horizon/private/activity-subscriptions/common'
import {servesFeature} from '#/horizon/routing/features'
import {PRIVATE_ACTIVITY_SUBSCRIPTIONS} from '#/horizon/switches'

/**
 * Whether reads and rendering show the private side for `did`: the switch,
 * and prism listing the feature (a list held from an earlier run counts).
 */
export function activitySubscriptionsShown(did: string | undefined): boolean {
  return (
    PRIVATE_ACTIVITY_SUBSCRIPTIONS &&
    !!did &&
    servesFeature(ACTIVITY_FEATURE, did)
  )
}
