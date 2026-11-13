import {type Client} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {api} from '@bsky/sdk'

import {IS_TEST_USER} from '#/lib/constants'
// HORIZON: the operator's cairn primary labeler
import {cairnPrimaryLabeler} from '#/horizon/cairn/primary-labeler'
// HORIZON: a kryphocron labeler never goes into the header
import {
  subscribeKryphocronLabelers,
  withoutKryphocronLabelers,
} from '#/horizon/kryphocron-labelers'
import {com} from '#/lexicons'
import {account as accountStorage} from '#/storage'
import {
  configureAdditionalModerationAuthorities,
  configureGlobalAppLabelers,
} from './additional-moderation-authorities'
import {type SessionAccount} from './types'

/** The moderation surface of a session bundle. */
type ModerationSession = {appviewClient: Client; chatClient: Client}

/**
 * Cache an account's subscribed labeler DIDs. Called on every preferences
 * fetch, so the cache is eventually consistent with the server.
 */
export function saveLabelers(did: string, value: string[]) {
  accountStorage.set([did, 'labelers'], value)
}

/**
 * Read the cached labeler DIDs for an account, or `undefined` if none have
 * been cached yet (first session on this device) or the entry is unreadable.
 */
export function readLabelers(did: string): string[] | undefined {
  try {
    return accountStorage.get([did, 'labelers'])
  } catch {
    /* a corrupt entry fails JSON.parse inside Storage.get; treat as no cache */
    return undefined
  }
}

/**
 * Apply an account's labeler subscriptions to the appview client, without
 * duplicating the globally redacted Bluesky moderation authority.
 *
 * The Bluesky DID is filtered out because it already flows through the global
 * `Client.appLabelers`, which lex emits with a `;redact` suffix. Listing it
 * per-instance would add a second, non-redacting entry for the same authority:
 * lex collects the two lists into a `Set` keyed on the suffixed string, so
 * neither dedupes against the other.
 *
 * Appview and chat both take subscriptions. The PDS suppresses labelers because
 * repo and identity requests do not hydrate moderated content (see clients.ts).
 */
export function applyLabelersToClient(
  client: Client,
  subscribedDids: string[],
) {
  // HORIZON: remembered, so a newly named kryphocron labeler leaves the header
  rememberApplied(client, subscribedDids)
  client.setLabelers(
    // HORIZON: a kryphocron labeler never goes into the header
    withoutKryphocronLabelers(
      subscribedDids.filter(
        did =>
          did !== api.moderation.did &&
          // HORIZON: the cairn primary is on the global list already
          did !== cairnPrimaryLabeler(),
      ),
    ) as DidString[],
  )
}

/*
 * HORIZON: the last subscriptions each recent client was given. When prism
 * names a new kryphocron labeler, they are applied again without it. Only
 * the latest few clients are kept (an account switch makes new ones).
 */
const applied = new Map<Client, string[]>()
const APPLIED_KEPT = 4
let watchingKryphocron = false

function rememberApplied(client: Client, dids: string[]) {
  applied.delete(client)
  applied.set(client, dids)
  if (applied.size > APPLIED_KEPT) {
    applied.delete(applied.keys().next().value as Client)
  }
  if (watchingKryphocron) return
  watchingKryphocron = true
  subscribeKryphocronLabelers(() => {
    for (const [each, dids] of [...applied]) applyLabelersToClient(each, dids)
  })
}

export function configureModerationForGuest() {
  // This global mutation is *only* OK because this code is only relevant for testing.
  // Don't add any other global behavior here!
  switchToBskyAppLabeler()
  configureAdditionalModerationAuthorities()
}

/**
 * Configure global app labelers and the account's cached labeler
 * subscriptions. Fully synchronous so session setup can apply labeler headers
 * in the same tick, before any request goes out.
 */
export function configureModerationForAccount(
  bundle: ModerationSession,
  account: SessionAccount,
) {
  // This global mutation is *only* OK because this code is only relevant for testing.
  // Don't add any other global behavior here!
  switchToBskyAppLabeler()
  if (IS_TEST_USER(account.handle)) {
    // Test accounts may briefly use the production authority while this resolves.
    void trySwitchToTestAppLabeler(bundle.appviewClient)
  }

  // The code below is actually relevant to production (and isn't global).
  const labelerDids = readLabelers(account.did)
  if (labelerDids) {
    applyLabelersToClient(bundle.appviewClient, labelerDids)
    applyLabelersToClient(bundle.chatClient, labelerDids)
  } else {
    // If there are no headers in the storage, we'll not send them on the initial requests.
    // If we wanted to fix this, we could block on the preferences query here.
  }

  configureAdditionalModerationAuthorities()
}

function switchToBskyAppLabeler() {
  configureGlobalAppLabelers([api.moderation.did])
}

/** Resolve and install the test environment's moderation authority. */
async function trySwitchToTestAppLabeler(client: Client) {
  const did = (
    await client
      .call(com.atproto.identity.resolveHandle, {
        handle: 'mod-authority.test',
      })
      .catch(_ => undefined)
  )?.did
  if (did) {
    console.warn('USING TEST ENV MODERATION')
    configureGlobalAppLabelers([did])
  }
}
