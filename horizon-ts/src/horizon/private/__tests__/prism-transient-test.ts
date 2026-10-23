import {
  XrpcFetchError,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'
import {describe, expect, it} from '@jest/globals'
import {CancelledError} from '@tanstack/react-query'

/*
 * T-1 (prism busy design 3): the classifier, the account-wide test and the
 * retry hint.
 */
import {nearhorizon} from '#/horizon/lexicons'
import {
  classifyPrismCall,
  isAccountWidePrismError,
  isPrismUnavailable,
  isTransientPrismError,
  PRISM_HINT_FALLBACK_MS,
  PrivateDeadlineError,
  PrivateSuspectMissError,
  PrivateWaiterError,
  retryAfterMs,
} from '#/horizon/private/api/transient'

const METHOD = nearhorizon.privateGetTimeline
const NOW = Date.parse('2026-10-22T21:00:00.000Z')

/** An XRPC error answer; `body: undefined` is a bare (non-XRPC) answer. */
function answered(
  status: number,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = new Response(body ? JSON.stringify(body) : 'busy', {
    status,
    headers: {
      'content-type': body ? 'application/json' : 'text/plain',
      ...headers,
    },
  })
  return new XrpcResponseError(
    METHOD as never,
    response,
    body ? ({encoding: 'application/json', body} as never) : undefined,
  )
}

function invalid(status: number) {
  return new XrpcInvalidResponseError(
    METHOD as never,
    new Response('', {status: status === 0 ? 200 : status}),
    undefined,
  )
}

function abortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

describe('T-1: classifyPrismCall', () => {
  it('names that are always transient', () => {
    for (const name of [
      'NotReady',
      'Reindexing',
      'RateLimitExceeded',
      'UpstreamFailure',
      'Unavailable',
    ]) {
      expect(classifyPrismCall(answered(400, {error: name}))).toBe('transient')
    }
  })

  it('429 and 5xx other than 501 are transient; 501 is permanent', () => {
    expect(classifyPrismCall(answered(429, {error: 'Slow'}))).toBe('transient')
    expect(classifyPrismCall(answered(500, {error: 'Internal'}))).toBe(
      'transient',
    )
    expect(classifyPrismCall(answered(504))).toBe('transient')
    expect(classifyPrismCall(answered(522))).toBe('transient')
    expect(
      classifyPrismCall(answered(501, {error: 'MethodNotImplemented'})),
    ).toBe('permanent')
    expect(classifyPrismCall(answered(501))).toBe('permanent')
  })

  it('refusals are permanent', () => {
    for (const name of [
      'NotEnrolled',
      'NotFound',
      'InvalidRequest',
      'AuthenticationRequired',
    ]) {
      expect(classifyPrismCall(answered(400, {error: name}))).toBe('permanent')
    }
    expect(classifyPrismCall(answered(401, {error: 'ExpiredToken'}))).toBe(
      'permanent',
    )
    expect(classifyPrismCall(new Error('a programming error'))).toBe(
      'permanent',
    )
  })

  it('an invalid response is transient only with status 0 or 5xx', () => {
    expect(classifyPrismCall(invalid(502))).toBe('transient')
    expect(classifyPrismCall(invalid(200))).toBe('permanent')
  })

  it('transport failures, deadlines, suspects and the outbox timeout are transient', () => {
    expect(
      classifyPrismCall(
        new XrpcFetchError(METHOD as never, new TypeError('Failed to fetch')),
      ),
    ).toBe('transient')
    expect(classifyPrismCall(new TypeError('Network request failed'))).toBe(
      'transient',
    )
    expect(classifyPrismCall(new PrivateDeadlineError())).toBe('transient')
    expect(classifyPrismCall(new PrivateSuspectMissError())).toBe('transient')
    const outbox = new Error('The call timed out')
    outbox.name = 'OutboxTimeoutError'
    expect(classifyPrismCall(outbox)).toBe('transient')
  })

  it('a cancellation is checked first, wrapped or not', () => {
    expect(classifyPrismCall(abortError())).toBe('cancelled')
    expect(
      classifyPrismCall(new XrpcFetchError(METHOD as never, abortError())),
    ).toBe('cancelled')
    expect(classifyPrismCall(new CancelledError())).toBe('cancelled')
  })

  it('a waiter takes its lead’s class', () => {
    expect(
      classifyPrismCall(
        new PrivateWaiterError(answered(503, {error: 'Reindexing'})),
      ),
    ).toBe('transient')
    expect(
      classifyPrismCall(new PrivateWaiterError(answered(400, {error: 'NotFound'}))),
    ).toBe('permanent')
    expect(isTransientPrismError(new PrivateWaiterError(abortError()))).toBe(
      false,
    )
  })
})

describe('T-1: the named Unavailable and the account-wide test', () => {
  it('only the named Unavailable, read through a waiter', () => {
    const named = answered(503, {error: 'Unavailable', retryAfter: 30})
    expect(isPrismUnavailable(named)).toBe(true)
    expect(isPrismUnavailable(new PrivateWaiterError(named))).toBe(true)
    // A bare 503 (a load balancer) is NotEnoughResources.
    const bare = answered(503)
    expect(bare.error).toBe('NotEnoughResources')
    expect(isPrismUnavailable(bare)).toBe(false)
  })

  it('a bare 503 is method-specific, a bare 522 UpstreamFailure account-wide', () => {
    expect(isAccountWidePrismError(answered(503))).toBe(false)
    const cdn = answered(522)
    expect(cdn.error).toBe('UpstreamFailure')
    expect(isAccountWidePrismError(cdn)).toBe(true)
    expect(isAccountWidePrismError(answered(502))).toBe(true)
  })

  it('NotReady, Reindexing, 429 and network are account-wide; 500, a deadline and an invalid response are not', () => {
    expect(isAccountWidePrismError(answered(400, {error: 'NotReady'}))).toBe(
      true,
    )
    expect(isAccountWidePrismError(answered(503, {error: 'Reindexing'}))).toBe(
      true,
    )
    expect(isAccountWidePrismError(answered(429))).toBe(true)
    expect(
      isAccountWidePrismError(
        new XrpcFetchError(METHOD as never, new TypeError('Failed to fetch')),
      ),
    ).toBe(true)
    expect(isAccountWidePrismError(answered(500, {error: 'Oops'}))).toBe(false)
    expect(isAccountWidePrismError(new PrivateDeadlineError())).toBe(false)
    expect(isAccountWidePrismError(invalid(502))).toBe(false)
  })
})

describe('T-1: retryAfterMs', () => {
  it('the body before the header', () => {
    expect(
      retryAfterMs(
        answered(
          503,
          {error: 'Reindexing', retryAfter: 120},
          {'retry-after': '7'},
        ),
        NOW,
      ),
    ).toBe(120_000)
  })

  it('the header in seconds or as a date, then ratelimit-reset', () => {
    expect(
      retryAfterMs(answered(429, {error: 'X'}, {'retry-after': '7'}), NOW),
    ).toBe(7_000)
    expect(
      retryAfterMs(
        answered(
          429,
          {error: 'X'},
          {'retry-after': new Date(NOW + 9_000).toUTCString()},
        ),
        NOW,
      ),
    ).toBe(9_000)
    expect(
      retryAfterMs(
        answered(429, {error: 'X'}, {'ratelimit-reset': String(NOW / 1000 + 4)}),
        NOW,
      ),
    ).toBe(4_000)
  })

  it('a hintless Reindexing or Unavailable gets 30 s, no throw; others none', () => {
    expect(retryAfterMs(answered(503, {error: 'Reindexing'}), NOW)).toBe(
      PRISM_HINT_FALLBACK_MS,
    )
    expect(retryAfterMs(answered(503, {error: 'Unavailable'}), NOW)).toBe(
      PRISM_HINT_FALLBACK_MS,
    )
    expect(PRISM_HINT_FALLBACK_MS).toBe(30_000)
    expect(retryAfterMs(answered(400, {error: 'NotReady'}), NOW)).toBe(
      undefined,
    )
    expect(retryAfterMs(answered(503), NOW)).toBe(undefined)
    expect(retryAfterMs(new TypeError('Failed to fetch'), NOW)).toBe(undefined)
  })

  it('a waiter takes its lead’s hint', () => {
    expect(
      retryAfterMs(
        new PrivateWaiterError(
          answered(503, {error: 'Reindexing', retryAfter: 45}),
        ),
        NOW,
      ),
    ).toBe(45_000)
  })
})
