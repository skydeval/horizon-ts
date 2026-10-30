/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** The service's own identity, served at /.well-known/did.json. */
export const SERVICE_DID = 'did:web:push.nearhorizon.app'

/** The service entry apps name in their `atproto-proxy` header. */
export const SERVICE_ID = '#horizon_push'

/** Where the service answers. */
export const SERVICE_ENDPOINT = 'https://push.nearhorizon.app'

/**
 * Services allowed to ask for a check (`app.nearhorizon.push.notify`), for
 * activity the public stream never carries: prism, for kryphocron posts.
 */
export const NOTIFY_SOURCES = new Set(['did:web:prism.nearhorizon.app'])

/** Accounts per notify request. */
export const MAX_NOTIFY_DIDS = 100

/** Only Horizon's own app can register. */
export const APP_ID = 'app.nearhorizon'

/** Platforms the service can deliver to (Firebase on Android). */
export const PLATFORMS = ['android'] as const

/** Phones kept per account; the oldest goes when another registers. */
export const MAX_TOKENS_PER_ACCOUNT = 10

/** Jetstream instances, tried in turn after a failed connection. */
export const JETSTREAM_HOSTS = [
  'jetstream2.us-east.bsky.network',
  'jetstream1.us-east.bsky.network',
  'jetstream1.us-west.bsky.network',
  'jetstream2.us-west.bsky.network',
]

/** Record types whose creation can concern another account. */
export const WANTED_COLLECTIONS = [
  'app.bsky.feed.post',
  'app.bsky.feed.like',
  'app.bsky.feed.repost',
  'app.bsky.graph.follow',
]

/**
 * A nudge waits this long after the event, so the AppView has indexed it by
 * the time the phone asks for its notifications.
 */
export const NUDGE_DELAY_MS = 3_000

/** At most one nudge per account in this window; later events join the next. */
export const NUDGE_COOLDOWN_MS = 10_000

/** How far back a reconnect resumes, to cover events in flight at the drop. */
export const RESUME_OVERLAP_US = 5_000_000

/** A saved cursor older than this is dropped, and the stream starts live. */
export const MAX_RESUME_AGE_US = 30 * 60 * 1_000_000
