/*
 * The private-tier features prism serves, per account (2H design 4.1).
 *
 * prism's `app.nearhorizon.actor.getMembership` answers the feature families
 * it serves with the requester's status. The membership probe records each
 * answer here (`answerPrismFeatures`); the device record keeps the last one,
 * so a launch starts from it (`loadPrismFeatures`, silent). A list read from
 * the device lets reads and rendering start at once but never unlocks a
 * write: writes ask `servesFeatureForWrite`, which also needs this run's
 * answer (4.7).
 *
 * Held per DID: a list, `null` (a prism without the membership query: the
 * four private reads and nothing later), or nothing (never answered, read as
 * `null`). This module reads no session module and runs nothing at import.
 */

import {
  getCurrentClients,
  getCurrentDid,
} from '#/horizon/routing/current-clients'
import {readMembershipRecord} from '#/horizon/routing/membership-record'

/**
 * Every feature family Horizon reads. prism may list others; they are kept
 * and ignored.
 */
export const PRISM_FEATURES = [
  'private',
  'private.embeds',
  'private.bookmarks',
  'private.gates',
  'private.interactions',
  'private.notifications',
  'private.freshIndex',
  'private.paging',
  'private.crossPdsReplies',
  'private.following',
  'private.search',
  'private.threadAudience',
  'private.mediaFilters',
  'private.notificationPreferences',
] as const

export type PrismFeature = (typeof PRISM_FEATURES)[number]

/**
 * A held answer: a list, or `null` for a prism without the membership query.
 */
export type PrismFeatureList = readonly string[] | null

const held = new Map<string, PrismFeatureList>()
/** DIDs whose device record was read (or that need no read any more). */
const loaded = new Set<string>()
/** DIDs whose features prism answered in this run. */
const answered = new Set<string>()
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach(listener => listener())
}

function ensureLoaded(did: string) {
  if (loaded.has(did)) return
  loadPrismFeatures(did, readMembershipRecord(did)?.features)
}

/**
 * Fill `did`'s features from the device record. Silent: notifies no
 * listener, invalidates nothing and never marks the DID answered, because it
 * runs inside `useSyncExternalStore` snapshots. Ignored once the DID holds a
 * value.
 */
export function loadPrismFeatures(
  did: string,
  value: PrismFeatureList | undefined,
) {
  if (loaded.has(did)) return
  loaded.add(did)
  if (value !== undefined && !held.has(did)) held.set(did, value)
}

function normalized(value: PrismFeatureList | undefined): string | null {
  if (!value) return null
  return JSON.stringify(Array.from(new Set(value)).sort())
}

/**
 * Record prism's answer for `did`: marks the features answered in this run
 * (notifying the first time) and, when the list differs from the held one
 * (as sorted, de-duplicated lists; nothing held reads as `null`), replaces it,
 * notifies and, for the current account, invalidates every query of its
 * query client once (4.6).
 */
export function answerPrismFeatures(did: string, value: PrismFeatureList) {
  ensureLoaded(did)
  const newlyAnswered = !answered.has(did)
  answered.add(did)
  const changed = normalized(held.get(did)) !== normalized(value)
  if (changed) held.set(did, value)
  if (changed || newlyAnswered) notify()
  if (changed && did === getCurrentDid()) {
    void getCurrentClients()?.queryClient?.invalidateQueries()
  }
}

/**
 * The features held for `did` (`undefined`: never answered), for the device
 * record.
 */
export function getPrismFeatures(did: string): PrismFeatureList | undefined {
  ensureLoaded(did)
  return held.get(did)
}

/**
 * Whether `did`'s features were answered by prism in this run.
 */
export function featuresAnswered(did: string | undefined): boolean {
  return !!did && answered.has(did)
}

/**
 * Whether prism serves `feature` for `did` (default: the published
 * account), by the held list. Without a list (legacy prism, or never
 * answered) only `private` is served. For rendering and reads.
 */
export function servesFeature(
  feature: PrismFeature,
  did: string | undefined = getCurrentDid(),
): boolean {
  if (!did) return false
  ensureLoaded(did)
  const list = held.get(did)
  if (!list) return feature === 'private'
  return list.includes(feature)
}

/**
 * {@link servesFeature}, and the features answered in this run. Every
 * decision that writes, or whose write the server would refuse or not
 * apply, uses this (4.7).
 */
export function servesFeatureForWrite(
  feature: PrismFeature,
  did: string | undefined = getCurrentDid(),
): boolean {
  return featuresAnswered(did) && servesFeature(feature, did)
}

/**
 * Subscribe to any feature change or first answer. Returns the unsubscribe
 * function.
 */
export function subscribePrismFeatures(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Forget everything held in memory (tests, and a relaunch in tests).
 */
export function resetPrismFeatures() {
  held.clear()
  loaded.clear()
  answered.clear()
}
