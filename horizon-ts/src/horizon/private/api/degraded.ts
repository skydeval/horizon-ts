/*
 * prism's degraded-mode signals on a 200 (prism busy design 7; prism's
 * handoff `prism-degraded-mode.md`, A and C), parsed for `reportedPrismCall`'s
 * answer context. Call sites stay on `prism.call`; nothing here acts on a
 * signal.
 *
 * - `degraded: true` (never `false`) and `retryAfter` (seconds) on the eleven
 *   listed methods while prism is behind. Global: the same for every caller.
 * - `unavailable[]`: the reader's own private posts the answer read and could
 *   not serve yet, in and outside degraded mode. Never another account's.
 * - `#viewUnavailable`: a quoted private post prism cannot show yet, with its
 *   own `retryAfter`.
 *
 * A prism without `private.degraded` never sends any of them, so they are
 * read ungated; only the inference "a listed answer without `degraded` is
 * fresh" needs the feature (health, 2.1).
 */

import {
  type UnavailablePost,
  unavailablePost,
  VIEW_UNAVAILABLE_TYPE,
} from '#/horizon/lexicons/nearhorizon'
import {secondsToMs} from '#/horizon/private/api/transient'

/**
 * The eleven methods whose 200 carries `degraded` (dm: 3.2). A 2xx of one of
 * them without the flag may clear the `degraded` cause (2.1).
 */
export const DEGRADED_METHODS: ReadonlySet<string> = new Set([
  'app.nearhorizon.private.getPosts',
  'app.nearhorizon.private.getPostThread',
  'app.nearhorizon.private.getAuthorFeed',
  'app.nearhorizon.private.getTimeline',
  'app.nearhorizon.private.getBookmarks',
  'app.nearhorizon.private.getLikes',
  'app.nearhorizon.private.getRepostedBy',
  'app.nearhorizon.private.getQuotes',
  'app.nearhorizon.private.getReplies',
  'app.nearhorizon.private.searchPosts',
  'app.nearhorizon.private.listNotifications',
])

/** What one 200 said about prism's state and the reader's own posts. */
export type AnswerSignals = {
  /** `degraded: true`; absent (and anything else) reads `false`. */
  degraded: boolean
  /** The answer's `retryAfter`, in ms. */
  retryAfterMs: number | undefined
  /** The reader's own posts listed as not served yet; malformed items dropped. */
  unavailable: UnavailablePost[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The `retryAfter` of a 200's body, or of a `#viewUnavailable` record, in
 * ms; `undefined` when absent or not a non-negative number.
 */
export function retryAfterFromBody(value: unknown): number | undefined {
  return isObject(value) ? secondsToMs(value.retryAfter) : undefined
}

/** The signals of a 200's body. A body that is not an object has none. */
export function readAnswerSignals(body: unknown): AnswerSignals {
  if (!isObject(body)) {
    return {degraded: false, retryAfterMs: undefined, unavailable: []}
  }
  const unavailable: UnavailablePost[] = []
  if (Array.isArray(body.unavailable)) {
    for (const item of body.unavailable) {
      if (unavailablePost.matches(item)) unavailable.push(item)
    }
  }
  return {
    degraded: body.degraded === true,
    retryAfterMs: retryAfterFromBody(body),
    unavailable,
  }
}

/**
 * Whether a quote's `embed.record` is prism's `#viewUnavailable` (by
 * `$type`; its own `retryAfter` is read with {@link retryAfterFromBody}).
 */
export function isViewUnavailable(
  record: unknown,
): record is {$type: string; uri: string; retryAfter?: number} {
  return (
    isObject(record) &&
    record.$type === VIEW_UNAVAILABLE_TYPE &&
    typeof record.uri === 'string'
  )
}
