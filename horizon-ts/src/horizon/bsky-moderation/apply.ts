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

import {configureGlobalAppLabelers} from '#/state/session/additional-moderation-authorities'

/** Bluesky's moderation labeler. */
export const BSKY_MODERATION_DID = api.moderation.did as DidString

/** Whether requests carry Bluesky's moderation labeler right now. */
export function bskyModerationApplied(): boolean {
  return Client.appLabelers.includes(BSKY_MODERATION_DID)
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
