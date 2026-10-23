/*
 * The development fault switch (prism busy design 12.2, L-0): with
 * `horizon-dev-prism-fault` set on the device, every private call answers as
 * a busy or behind prism would, so the live checks can run without a real
 * outage. Development builds only (`IS_DEV`; `build-web` has `__DEV__`
 * false). Read through Horizon's device keys (`session/local-store`): web's
 * `localStorage`, native's in-memory map, so it is safe on every platform.
 *
 * Set it from the browser console, for example
 * `localStorage.setItem('horizon-dev-prism-fault', 'reindexing')`, and
 * remove it to clear. Values:
 * - `not-ready`: 400 `NotReady`, `Retry-After: 7`;
 * - `reindexing`: 503 `Reindexing`, body `retryAfter: 30`, no header; the
 *   probe answers `reindexing`;
 * - `reindexing-bare`: the same with no hint at all;
 * - `503`: a bare 503 (`NotEnoughResources`);
 * - `thread-503`: `getPostThread` only, 503 `Unavailable`, body
 *   `retryAfter: 300`; `thread-503-bare` with no hint;
 * - `502`: 502 `UpstreamFailure`;
 * - `omit`: no posts from `getPosts` and the timelines, `NotFound` from
 *   `getPostThread`;
 * - `degraded`: `omit`, plus `degraded: true, retryAfter: 60` on the listed
 *   answers;
 * - `thread-500`: one plain 500 from the next `getPostThread`, then clean
 *   until the value is set again;
 * - `hang`: no private call answers (a read ends at its deadline);
 * - `not-enrolled` (appearance storage choice design 11.1): a removed member
 *   after the purge, or a non-member. Every private call answers 400
 *   `NotEnrolled`, the appearance methods included, and the probe answers
 *   `notEligible` with the features prism answered.
 * - `not-enrolled-retained` (removed members design 10.1): a removed member
 *   within prism's 7 days. As `not-enrolled`, except that `getAppearance` is
 *   sent and a row in its answer is marked retained (`retainedUntil` now
 *   plus 7 days; an answer with no row is 400 `NotEnrolled`), and
 *   `releaseAppearance` answers `{}` without being sent, so a live check
 *   never deletes a real row.
 */

import {XrpcResponseError} from '@atproto/lex'

import {IS_DEV} from '#/env'
import {DEGRADED_METHODS} from '#/horizon/private/api/degraded'
import {readLocal} from '#/horizon/session/local-store'

export const DEV_PRISM_FAULT_KEY = 'horizon-dev-prism-fault'

export const DEV_PRISM_FAULTS = [
  'not-ready',
  'reindexing',
  'reindexing-bare',
  '503',
  'thread-503',
  'thread-503-bare',
  '502',
  'omit',
  'degraded',
  'thread-500',
  'hang',
  'not-enrolled',
  'not-enrolled-retained',
] as const

const GET_APPEARANCE = 'app.nearhorizon.private.getAppearance'
const RELEASE_APPEARANCE = 'app.nearhorizon.private.releaseAppearance'

/** prism's retention after a removal (prism's reply). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Whether `fault` answers as a removed member (the probe's `notEligible`). */
export function isRemovalFault(fault: DevPrismFault | undefined): boolean {
  return fault === 'not-enrolled' || fault === 'not-enrolled-retained'
}

export type DevPrismFault = (typeof DEV_PRISM_FAULTS)[number]

const THREAD = 'app.nearhorizon.private.getPostThread'

/** Whether this value's one `thread-500` has fired. */
let thread500Fired = false

/** The fault set on this device, in a development build only. */
export function devPrismFault(): DevPrismFault | undefined {
  if (!IS_DEV) return undefined
  let value: string | undefined
  try {
    value = readLocal(DEV_PRISM_FAULT_KEY)
  } catch {
    return undefined
  }
  if (value !== 'thread-500') thread500Fired = false
  return DEV_PRISM_FAULTS.find(fault => fault === value)
}

type Method = {nsid: string}

/** An XRPC error as prism (or a proxy, `body` undefined) would answer it. */
function answered(
  method: Method,
  status: number,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): XrpcResponseError {
  const response = new Response(body ? JSON.stringify(body) : '', {
    status,
    headers: {
      'content-type': body ? 'application/json' : 'text/plain',
      ...headers,
    },
  })
  return new XrpcResponseError(
    method as never,
    response,
    body ? ({encoding: 'application/json', body} as never) : undefined,
  )
}

/** Never settles, except by `signal`'s abort, as an unanswered call. */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort)
  })
}

/** A 200's body with its posts left out, as prism leaves out what it misses. */
function omitted(nsid: string, body: unknown, degraded: boolean): unknown {
  if (typeof body !== 'object' || body === null) return body
  let next = body as Record<string, unknown>
  if (nsid === 'app.nearhorizon.private.getPosts') next = {...next, posts: []}
  if (
    nsid === 'app.nearhorizon.private.getTimeline' ||
    nsid === 'app.nearhorizon.private.getAuthorFeed'
  ) {
    next = {...next, feed: []}
  }
  if (degraded && DEGRADED_METHODS.has(nsid)) {
    next = {...next, degraded: true, retryAfter: 60}
  }
  return next
}

/**
 * `send`, unless a fault is set: then the answer the fault gives. `signal`
 * aborts a `hang`.
 */
export async function withDevFault<T>(
  method: Method,
  send: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const fault = devPrismFault()
  if (!fault) return send()
  const nsid = method.nsid
  switch (fault) {
    case 'not-ready':
      throw answered(
        method,
        400,
        {error: 'NotReady', message: 'Account indexing in progress'},
        {'retry-after': '7'},
      )
    case 'reindexing':
      throw answered(method, 503, {
        error: 'Reindexing',
        message: 'Account re-indexing after an interruption; try again',
        retryAfter: 30,
      })
    case 'reindexing-bare':
      throw answered(method, 503, {
        error: 'Reindexing',
        message: 'Account re-indexing after an interruption; try again',
      })
    case '503':
      throw answered(method, 503)
    case '502':
      throw answered(method, 502, {
        error: 'UpstreamFailure',
        message: 'Upstream failure',
      })
    case 'thread-503':
    case 'thread-503-bare':
      if (nsid !== THREAD) return send()
      throw answered(method, 503, {
        error: 'Unavailable',
        message: 'Temporarily unavailable; try again',
        ...(fault === 'thread-503' ? {retryAfter: 300} : {}),
      })
    case 'thread-500':
      if (nsid !== THREAD || thread500Fired) return send()
      thread500Fired = true
      throw answered(method, 500, {
        error: 'InternalServerError',
        message: 'Internal Server Error',
      })
    case 'omit':
    case 'degraded':
      if (nsid === THREAD) {
        throw answered(method, 400, {error: 'NotFound', message: 'Not found'})
      }
      return omitted(nsid, await send(), fault === 'degraded') as T
    case 'hang':
      return hang(signal)
    case 'not-enrolled-retained':
      if (nsid === RELEASE_APPEARANCE) return {} as T
      if (nsid === GET_APPEARANCE) {
        const body = (await send()) as unknown
        if (
          typeof body === 'object' &&
          body !== null &&
          (body as {store?: unknown}).store !== undefined
        ) {
          const retainedUntil = new Date(Date.now() + RETENTION_MS).toISOString()
          return {...body, retainedUntil} as T
        }
      }
      throw notEnrolled(method)
    case 'not-enrolled':
      throw notEnrolled(method)
  }
}

function notEnrolled(method: Method): XrpcResponseError {
  return answered(method, 400, {
    error: 'NotEnrolled',
    message: 'Not enrolled in this AppView',
  })
}
