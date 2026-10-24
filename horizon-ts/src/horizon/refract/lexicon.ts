/*
 * Hand-written schemas for prism's `app.nearhorizon.refract.*` reads, from
 * prism's lexicon files (`lexicons/app/nearhorizon/refract/*.json`). Every
 * view is typed as a map here, so one odd view never fails an answer; the
 * normalizer and the answer reader (`normalize.ts`, `answer.ts`) check each
 * one where it is used. The additive fields (`servedAs`, `withheld`,
 * `viewerChecked`) are optional, as a prism that has not deployed them
 * leaves them out (refract client design 5.2).
 */

import {l} from '@atproto/lex'

/** The errors every refract method declares (RF-S5). */
const ERRORS = [
  'NotEnabled',
  'AuthRequired',
  'InvalidToken',
  'RateLimitExceeded',
] as const

const answerFields = {
  servedAs: l.optional(l.string()),
  viewerChecked: l.optional(l.lexMap()),
}

export const fill = l.query(
  'app.nearhorizon.refract.fill',
  l.params({
    dids: l.optional(l.array(l.string({format: 'did'}), {maxLength: 25})),
    uris: l.optional(l.array(l.string({format: 'at-uri'}), {maxLength: 25})),
  }),
  l.jsonPayload({
    profiles: l.array(l.lexMap()),
    posts: l.array(l.lexMap()),
    pending: l.array(l.string()),
    withheld: l.optional(l.array(l.lexMap())),
    ...answerFields,
  }),
  ERRORS,
)

export const getAuthorFeed = l.query(
  'app.nearhorizon.refract.getAuthorFeed',
  l.params({
    actor: l.string({format: 'at-identifier'}),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
    filter: l.optional(l.string()),
    includePins: l.optional(l.boolean()),
  }),
  l.jsonPayload({
    feed: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
    ...answerFields,
  }),
  [
    ...ERRORS,
    'NotFound',
    'AccountTakedown',
    'AccountDeactivated',
    'InvalidRequest',
  ],
)

export const getPostThread = l.query(
  'app.nearhorizon.refract.getPostThread',
  l.params({
    uri: l.string({format: 'at-uri'}),
    depth: l.optional(l.integer({minimum: 0, maximum: 1000})),
    parentHeight: l.optional(l.integer({minimum: 0, maximum: 1000})),
  }),
  l.jsonPayload({thread: l.lexMap(), ...answerFields}),
  [...ERRORS, 'NotFound'],
)

export const getReplies = l.query(
  'app.nearhorizon.refract.getReplies',
  l.params({
    anchor: l.string({format: 'at-uri'}),
    root: l.string({format: 'at-uri'}),
  }),
  l.jsonPayload({posts: l.array(l.lexMap()), ...answerFields}),
  ERRORS,
)

export const getTimeline = l.query(
  'app.nearhorizon.refract.getTimeline',
  l.params({
    cursor: l.optional(l.string()),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
  }),
  l.jsonPayload({
    feed: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
    ...answerFields,
  }),
  ERRORS,
)

export const listNotifications = l.query(
  'app.nearhorizon.refract.listNotifications',
  l.params({
    cursor: l.optional(l.string()),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
  }),
  l.jsonPayload({
    notifications: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
    ...answerFields,
  }),
  ERRORS,
)

export const getUnreadCount = l.query(
  'app.nearhorizon.refract.getUnreadCount',
  l.params({seenAt: l.optional(l.string({format: 'datetime'}))}),
  l.jsonPayload({count: l.integer(), ...answerFields}),
  ERRORS,
)

/**
 * Any account's reposts of restored posts, newest first, each with a
 * `reasonRepost` by the actor (prism's refract-reposts design 3.2).
 */
export const getAuthorReposts = l.query(
  'app.nearhorizon.refract.getAuthorReposts',
  l.params({
    actor: l.string({format: 'at-identifier'}),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    feed: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
    ...answerFields,
  }),
  [...ERRORS, 'AccountTakedown', 'AccountDeactivated', 'InvalidRequest'],
)

/**
 * Prefix matches on handle or display name over restored accounts only
 * (feature `refract.search`, prism `0c4634d`), ignoring case and diacritics.
 * Views come marked restored with fill's gate, block, mute and visitor rules
 * applied, in a stable order: exact handle, handle prefix, display-name
 * prefix, by handle within each. `q` over 100 characters is `InvalidRequest`.
 */
export const searchActorsTypeahead = l.query(
  'app.nearhorizon.refract.searchActorsTypeahead',
  l.params({
    q: l.string(),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
  }),
  l.jsonPayload({
    actors: l.array(l.lexMap()),
    withheld: l.optional(l.array(l.lexMap())),
    ...answerFields,
  }),
  [...ERRORS, 'InvalidRequest'],
)

/**
 * The paged form of {@link searchActorsTypeahead}. Drops happen after the
 * page is cut, so a page can be short (even empty) with a cursor.
 */
export const searchActors = l.query(
  'app.nearhorizon.refract.searchActors',
  l.params({
    q: l.string(),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    actors: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
    withheld: l.optional(l.array(l.lexMap())),
    ...answerFields,
  }),
  [...ERRORS, 'InvalidRequest'],
)

/** The methods' NSIDs, which share prism's one rate-limit family. */
export const REFRACT_METHODS = {
  fill: 'app.nearhorizon.refract.fill',
  getAuthorFeed: 'app.nearhorizon.refract.getAuthorFeed',
  getPostThread: 'app.nearhorizon.refract.getPostThread',
  getReplies: 'app.nearhorizon.refract.getReplies',
  getTimeline: 'app.nearhorizon.refract.getTimeline',
  listNotifications: 'app.nearhorizon.refract.listNotifications',
  getUnreadCount: 'app.nearhorizon.refract.getUnreadCount',
  getAuthorReposts: 'app.nearhorizon.refract.getAuthorReposts',
  searchActorsTypeahead: 'app.nearhorizon.refract.searchActorsTypeahead',
  searchActors: 'app.nearhorizon.refract.searchActors',
} as const

export type RefractMethod =
  (typeof REFRACT_METHODS)[keyof typeof REFRACT_METHODS]
