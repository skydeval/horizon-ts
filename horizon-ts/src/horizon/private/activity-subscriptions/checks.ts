/*
 * The checks the mirror and the reconcile make for an account before writing
 * its subscriptions to prism (activity subscriptions design 2.2, "The
 * checks", and 2.8). Non-hook reads for the given DID, so a write made for
 * an account captured at press never reads the current one.
 */

import {ACTIVITY_FEATURE} from '#/horizon/private/activity-subscriptions/common'
import {
  featuresAnswered,
  servesFeature,
  servesFeatureForWrite,
  subscribePrismFeatures,
} from '#/horizon/routing/features'
import {
  getMembership,
  isMembershipConfirmed,
  subscribeMembership,
} from '#/horizon/routing/membership'
import {PRIVATE_ACTIVITY_SUBSCRIPTIONS} from '#/horizon/switches'

/**
 * What the account's answers in this run say about writing its
 * subscriptions to prism:
 * - `no`: answered not a member, or features answered without the feature;
 * - `yes`: a confirmed member with the feature for write;
 * - `wait`: anything not answered yet (`unknown`, `indexing`, known only
 *   from the device), which is never read as "no".
 */
export type MirrorApplies = 'no' | 'wait' | 'yes'

export function mirrorApplies(did: string): MirrorApplies {
  const confirmed = isMembershipConfirmed(did)
  const state = getMembership(did)
  if (confirmed && state === 'not-member') return 'no'
  if (featuresAnswered(did) && !servesFeature(ACTIVITY_FEATURE, did)) {
    return 'no'
  }
  if (
    confirmed &&
    state === 'member' &&
    servesFeatureForWrite(ACTIVITY_FEATURE, did)
  ) {
    return 'yes'
  }
  return 'wait'
}

/**
 * Whether the device holds `member` and a feature list with the feature for
 * `did`, from this run or an earlier one: the condition for the mirror's
 * "still unanswered" toast, so nothing about private posts shows while prism
 * does not list the feature.
 */
export function deviceExpectsMirror(did: string): boolean {
  return getMembership(did) === 'member' && servesFeature(ACTIVITY_FEATURE, did)
}

/**
 * Whether the reconcile may run for `did` (2.3, "When it runs"), apart from
 * the switch and the foreground: a member confirmed in this run, with the
 * feature for write.
 */
export function reconcileApplies(did: string): boolean {
  return mirrorApplies(did) === 'yes'
}

/**
 * Whether reads and rendering show the private side for `did` (2.8): the
 * switch, and prism listing the feature (a list held from an earlier run
 * counts).
 */
export function activitySubscriptionsShown(did: string | undefined): boolean {
  return (
    PRIVATE_ACTIVITY_SUBSCRIPTIONS &&
    !!did &&
    servesFeature(ACTIVITY_FEATURE, did)
  )
}

/** Called on any membership or feature change. Returns the unsubscribe. */
export function subscribeMirrorChecks(listener: () => void): () => void {
  const a = subscribeMembership(listener)
  const b = subscribePrismFeatures(listener)
  return () => {
    a()
    b()
  }
}
