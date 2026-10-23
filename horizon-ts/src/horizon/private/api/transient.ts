/*
 * The one classifier of prism call errors (prism busy design 3, BR-3): is a
 * failure transient (try again later, never a verdict), permanent, or a
 * cancellation (nothing happened)? Every private read and write, the
 * membership probe and health ask it; no surface has its own rule.
 *
 * It also reads prism's retry hint (`retryAfterMs`): the body's `retryAfter`
 * first, then the `Retry-After` header, then `ratelimit-reset`, with a 30 s
 * floor for a hintless `Reindexing` or `Unavailable`, which a stock PDS proxy
 * strips of its body (design 14).
 *
 * The name avoids the activity subscriptions' `classifyPrismError`, which
 * maps its own refusals and reads transience from here (FU-3).
 */

import {
  XrpcFetchError,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'
import {CancelledError} from '@tanstack/react-query'

import {isNetworkError} from '#/lib/network-error'

export type PrismErrorClass = 'transient' | 'permanent' | 'cancelled'

/**
 * The hint for a named `Reindexing` or `Unavailable` that arrives with none
 * (a stock PDS drops both the body and the header): prism's
 * `community.reindex_retry_secs` default and its degraded minimum.
 */
export const PRISM_HINT_FALLBACK_MS = 30_000

/**
 * A private read that did not answer within its call deadline (design 2.2),
 * or a page's own wait that ran out (`withDeadline`). Transient.
 */
export class PrivateDeadlineError extends Error {
  constructor(message = 'The private read timed out') {
    super(message)
    this.name = 'PrivateDeadlineError'
  }
}

/**
 * A post prism left out while it is a suspect (design 4): the query has
 * nothing to show yet and retries on the suspect clock. Transient.
 */
export class PrivateSuspectMissError extends Error {
  constructor(message = 'The private post could not be read yet') {
    super(message)
    this.name = 'PrivateSuspectMissError'
  }
}

/**
 * A call that waited behind the account's lead call and was answered with
 * the lead's failure (design 2.2). Each waiter gets its own instance, so no
 * two queries share an error object (BR11-L2); it is classed, and its hint
 * read, through `cause`, the lead's error.
 */
export class PrivateWaiterError extends Error {
  constructor(cause: unknown) {
    super('A private read waiting for the account failed', {cause})
    this.name = 'PrivateWaiterError'
  }
}

/** The error a waiter error stands for: the lead's, at any depth. */
export function leadErrorOf(error: unknown): unknown {
  let current = error
  for (let depth = 0; depth < 5; depth++) {
    if (!(current instanceof PrivateWaiterError)) return current
    current = current.cause
  }
  return current
}

/** An `AbortError` anywhere in the cause chain (as `grouped-fallback.ts`). */
function isAbort(error: unknown): boolean {
  let current = error
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error && current.name === 'AbortError') return true
    current = (current as {cause?: unknown}).cause
  }
  return false
}

/**
 * The XRPC names that are always transient: the account's re-index or
 * first index (`Reindexing`, `NotReady`), a rate limit, a proxy's or CDN's
 * upstream failure, and the thread's named `Unavailable`.
 */
const TRANSIENT_NAMES: ReadonlySet<string> = new Set([
  'NotReady',
  'Reindexing',
  'RateLimitExceeded',
  'UpstreamFailure',
  'Unavailable',
])

/**
 * Whether a call's failure says anything about the content (permanent),
 * nothing yet (transient), or nothing at all (cancelled, checked first: the
 * network test counts "Abort" as a network error). A waiter's error is
 * classed by the lead's.
 */
export function classifyPrismCall(error: unknown): PrismErrorClass {
  const lead = leadErrorOf(error)
  if (lead instanceof CancelledError || isAbort(lead)) return 'cancelled'
  if (lead instanceof XrpcResponseError) {
    if (TRANSIENT_NAMES.has(lead.error)) return 'transient'
    const status = lead.status
    if (status === 429) return 'transient'
    if (status >= 500 && status !== 501) return 'transient'
    return 'permanent'
  }
  if (lead instanceof XrpcInvalidResponseError) {
    const status = lead.response.status
    return status === 0 || (status >= 500 && status !== 501)
      ? 'transient'
      : 'permanent'
  }
  if (lead instanceof XrpcFetchError) return 'transient'
  if (
    lead instanceof PrivateDeadlineError ||
    lead instanceof PrivateSuspectMissError
  ) {
    return 'transient'
  }
  // The outbox's own call timeout (`timed`), by name: its class is private.
  if (lead instanceof Error && lead.name === 'OutboxTimeoutError') {
    return 'transient'
  }
  if (isNetworkError(lead)) return 'transient'
  return 'permanent'
}

/** {@link classifyPrismCall} is `transient`. */
export function isTransientPrismError(error: unknown): boolean {
  return classifyPrismCall(error) === 'transient'
}

/**
 * prism's named XRPC `Unavailable` (only `getPostThread`'s anchor miss sends
 * it), read through a waiter's `cause`. A bare 503 is `NotEnoughResources`,
 * never this.
 */
export function isPrismUnavailable(error: unknown): boolean {
  const lead = leadErrorOf(error)
  return lead instanceof XrpcResponseError && lead.error === 'Unavailable'
}

/**
 * Whether a transient failure is about the whole account rather than one
 * method (design 2.1, 2.2): `NotReady`, `Reindexing`, a 429, an
 * `UpstreamFailure` (locus's 502, or a bare 502 or other bare 5xx the lex
 * client has no name for, a CDN's 520 to 524 among them) and a network
 * failure. Another 5xx (a plain
 * 500, a bare 503's `NotEnoughResources`, a 504), an invalid response and a
 * deadline are method-specific. Only meaningful for a transient error.
 */
export function isAccountWidePrismError(error: unknown): boolean {
  const lead = leadErrorOf(error)
  if (lead instanceof XrpcResponseError) {
    return (
      lead.error === 'NotReady' ||
      lead.error === 'Reindexing' ||
      lead.error === 'RateLimitExceeded' ||
      lead.error === 'UpstreamFailure' ||
      lead.status === 429
    )
  }
  if (lead instanceof XrpcInvalidResponseError) return false
  if (lead instanceof PrivateDeadlineError) return false
  if (lead instanceof XrpcFetchError) return true
  return isNetworkError(lead)
}

/**
 * A `Retry-After` value in ms: seconds, or an HTTP date (moved from
 * `membership.ts`). `undefined` for none or a value that does not parse.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return undefined
}

/**
 * A `ratelimit-reset` value in ms from now: epoch seconds, as the atproto
 * services send it, or a delta in seconds from a server that sends one.
 */
function parseRateLimitReset(
  value: string | null | undefined,
  now: number,
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  if (seconds > 1e9) return Math.max(0, seconds * 1000 - now)
  return seconds * 1000
}

/** A body's `retryAfter` in seconds, as ms; `undefined` unless a number. */
export function secondsToMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }
  return value * 1000
}

/**
 * prism's retry hint on a failed call, in ms: the body's `retryAfter`
 * (seconds), then the `Retry-After` header (seconds or a date), then
 * `ratelimit-reset`. With none, a named `Reindexing` or `Unavailable` gets
 * {@link PRISM_HINT_FALLBACK_MS}; any other error `undefined`. A waiter's
 * error reads its lead's. Prism calls only.
 */
export function retryAfterMs(
  error: unknown,
  now = Date.now(),
): number | undefined {
  const lead = leadErrorOf(error)
  if (!(lead instanceof XrpcResponseError)) return undefined
  const body = lead.body as {retryAfter?: unknown} | undefined
  const hint =
    secondsToMs(body?.retryAfter) ??
    parseRetryAfter(lead.headers.get('retry-after'), now) ??
    parseRateLimitReset(lead.headers.get('ratelimit-reset'), now)
  if (hint !== undefined) return hint
  if (lead.error === 'Reindexing' || lead.error === 'Unavailable') {
    return PRISM_HINT_FALLBACK_MS
  }
  return undefined
}
