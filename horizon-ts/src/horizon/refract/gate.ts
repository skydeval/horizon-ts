/*
 * Whether restored accounts are read for an account (refract client design
 * RF-1), and the visitor-form prediction (9.2).
 *
 * `refractActive(did)` holds when the `REFRACT` switch is on, the account is
 * the signed-in one and prism lists `refract` for it. It holds for
 * non-members too. A `NotEnabled` answer turns it off for the account until
 * prism's next `getMembership` answer.
 *
 * Reads only private health's `catching-up` (RF-4) and never reports to
 * health or membership.
 */

import {useSyncExternalStore} from 'react'

import {getCurrentDid} from '#/horizon/routing/current-clients'
import {
  onPrismFeaturesAnswer,
  servesFeature,
  subscribePrismFeatures,
} from '#/horizon/routing/features'
import {getPrismHealth, subscribePrismHealth} from '#/horizon/routing/health'
import {getMembership, subscribeMembership} from '#/horizon/routing/membership'
import {REFRACT} from '#/horizon/switches'

/** Accounts whose refract calls answered `NotEnabled`, until the next answer. */
const notEnabled = new Set<string>()
const listeners = new Set<() => void>()
let watching = false

function notify() {
  listeners.forEach(listener => listener())
}

function watch() {
  if (watching) return
  watching = true
  onPrismFeaturesAnswer(did => {
    if (notEnabled.delete(did)) notify()
  })
}

/**
 * Whether restored accounts are read for `did` (default: the signed-in
 * account).
 */
export function refractActive(did: string | undefined = getCurrentDid()) {
  if (!REFRACT || !did) return false
  watch()
  if (did !== getCurrentDid()) return false
  if (notEnabled.has(did)) return false
  return servesFeature('refract', did)
}

/**
 * prism answered `NotEnabled` for `did`: off until its next `getMembership`
 * answer.
 */
export function markRefractNotEnabled(did: string) {
  watch()
  if (notEnabled.has(did)) return
  notEnabled.add(did)
  notify()
}

/**
 * Whether prism would serve `did` in visitor form now (9.2): true unless the
 * account is a member and health has no `catching-up`.
 */
export function restoredVisitorForm(
  did: string | undefined = getCurrentDid(),
): boolean {
  if (!did) return true
  if (getMembership(did) !== 'member') return true
  return getPrismHealth(did).causes.has('catching-up')
}

/**
 * Called on any change that can move {@link refractActive} or
 * {@link restoredVisitorForm}. Returns the unsubscribe function.
 */
export function subscribeRefractGate(listener: () => void) {
  watch()
  listeners.add(listener)
  const unsubscribes = [
    subscribePrismFeatures(listener),
    subscribeMembership(listener),
    subscribePrismHealth(listener),
  ]
  return () => {
    listeners.delete(listener)
    unsubscribes.forEach(unsubscribe => unsubscribe())
  }
}

/** {@link refractActive} for the signed-in account, re-rendering on change. */
export function useRefractActive(): boolean {
  return useSyncExternalStore(subscribeRefractGate, () => refractActive())
}

/** {@link restoredVisitorForm}, re-rendering on change. */
export function useRestoredVisitorForm(): boolean {
  return useSyncExternalStore(subscribeRefractGate, () => restoredVisitorForm())
}

/** Test-only: forget `NotEnabled` marks. */
export function resetRefractGate() {
  notEnabled.clear()
}
