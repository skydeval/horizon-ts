/*
 * The sdk's preference ids on the account's own TID counter (Phase 5 design,
 * Appendix A; P5R4-N2 carried to the sdk's own call sites).
 *
 * `@bsky/sdk` mints saved-feed and muted-word ids itself, on one clock for the
 * whole page: `getPreferences` (the v1 migration and the default Following
 * feed it writes into an account with none), `addSavedFeeds`, and the muted
 * word actions (`addMutedWord`, `updateMutedWord`, `removeMutedWord` and their
 * plural forms, which backfill legacy words without an id). After an account
 * switch in one page, those ids would carry the first account's clock into
 * the second account's preferences. The patch in
 * `patches/@bsky__sdk@1.2.0.patch` asks a source set here instead, with the
 * client the preferences belong to, so each id is minted for that client's
 * DID.
 */
import {type Client} from '@atproto/lex'
import {setTidSource} from '@bsky/sdk'

import {nextPreferenceId} from '#/horizon/tid-clock/preference-id'

/**
 * The id for a preference item of `client`'s account. Undefined, and so the
 * sdk's own clock, only for a client with no DID, whose preference writes
 * fail anyway; never the current account's, which may be another account.
 */
export function sdkPreferenceId(
  client: Client | undefined,
): string | undefined {
  let did: string | undefined
  try {
    did = client?.did
  } catch {
    did = undefined
  }
  if (typeof did !== 'string' || !did.startsWith('did:')) return undefined
  return nextPreferenceId(did)
}

/**
 * Points the sdk's preference ids at `sdkPreferenceId`. Called from the app
 * entries (`App.tsx`, `App.web.tsx`) at load, not as an import side effect,
 * which the bundler's `sideEffects` list would drop. Safe to call again.
 */
export function installSdkPreferenceIds() {
  setTidSource(sdkPreferenceId)
}
