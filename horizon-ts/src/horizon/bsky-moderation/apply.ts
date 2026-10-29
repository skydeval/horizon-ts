/*
 * Puts Bluesky's moderation labeler on or takes it off the global app
 * labelers (`Client.appLabelers`), which every AppView and chat request
 * carries (with `;redact`) and which the SDK's `getPreferences` lists first
 * in the account's labelers. The country labelers on the same list are
 * legal blocks and are never touched.
 */

import {Client} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {api} from '@bsky/sdk'

import {
  additionalModerationAuthoritiesFor,
  configureGlobalAppLabelers,
} from '#/state/session/additional-moderation-authorities'

/** Bluesky's moderation labeler. */
export const BSKY_MODERATION_DID = api.moderation.did as DidString

/** Whether requests carry Bluesky's moderation labeler right now. */
export function bskyModerationApplied(): boolean {
  return Client.appLabelers.includes(BSKY_MODERATION_DID)
}

/**
 * Rebuilds the country labelers from the device's current location,
 * keeping Bluesky's labeler as it is. The session sets them before the
 * location is known (unknown means every country's), and Bluesky's own code
 * only ever adds to the list. Returns true when the list changed.
 */
export function refreshCountryLabelers(
  countryCode: string | undefined,
): boolean {
  const before = Client.appLabelers.join(',')
  const next = [
    ...(bskyModerationApplied() ? [BSKY_MODERATION_DID] : []),
    ...additionalModerationAuthoritiesFor(countryCode),
  ]
  configureGlobalAppLabelers(Array.from(new Set(next)))
  return Client.appLabelers.join(',') !== before
}

/**
 * Applies `on`. Returns true when the list changed, so the caller refetches
 * what was read under the old list.
 */
export function applyBskyModeration(on: boolean): boolean {
  if (bskyModerationApplied() === on) return false
  const others = Client.appLabelers.filter(did => did !== BSKY_MODERATION_DID)
  configureGlobalAppLabelers(on ? [BSKY_MODERATION_DID, ...others] : others)
  return true
}
