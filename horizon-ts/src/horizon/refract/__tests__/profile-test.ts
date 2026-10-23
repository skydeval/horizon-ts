import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  REFRACT: true,
}))
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  subscribeMembership: () => () => {},
  isPrivateMember: () => true,
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

import {XrpcResponseError} from '@atproto/lex'

import {
  RF_DID,
  RF_READER_DID,
  rfFillAnswer,
  rfProfile,
} from '#/horizon/refract/fixtures'
import {fromRefract, noteRestored} from '#/horizon/refract/marker'
import {
  ProfileUnavailableError,
  refractProfileQuery,
} from '#/horizon/refract/profile'
import {answerPrismFeatures} from '#/horizon/routing/features'
import {app} from '#/lexicons'
import {type Harness, setupRefract} from './harness'

/*
 * 11.1 "profile" (refract client design 4.1).
 */

function xrpcError(status: number, error: string, message = error) {
  const body = {error, message}
  return new XrpcResponseError(
    app.bsky.actor.getProfile as never,
    new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    }),
    {encoding: 'application/json', body} as never,
  )
}

const takedown = () =>
  xrpcError(400, 'AccountTakedown', 'Account has been suspended')

let h: Harness

beforeEach(() => {
  jest.useFakeTimers()
  h = setupRefract()
})

afterEach(() => {
  jest.useRealTimers()
})

function run(stock: () => Promise<unknown>, placeholder?: unknown) {
  let outcome: {value?: unknown; error?: unknown} | undefined
  void refractProfileQuery(RF_DID, stock as never, placeholder).then(
    value => {
      outcome = {value}
    },
    error => {
      outcome = {error}
    },
  )
  return () => outcome
}

describe('the profile query', () => {
  it('with refract not listed, rethrows the stock error and asks nothing', async () => {
    answerPrismFeatures(RF_READER_DID, ['private'])
    const error = takedown()
    const result = run(() => Promise.reject(error))
    await jest.advanceTimersByTimeAsync(100)
    expect(result()?.error).toBe(error)
    expect(h.fills()).toHaveLength(0)
  })

  it('AccountTakedown then a fill profile renders, with no pre-check', async () => {
    h.respond(() => rfFillAnswer({profiles: [rfProfile()], withheld: []}))
    const result = run(() => Promise.reject(takedown()))
    await jest.advanceTimersByTimeAsync(100)
    expect(fromRefract(result()?.value)).toBe(true)
    expect(h.precheckCalls).toHaveLength(0)
  })

  it('a definitive "not restored" gives the stock error', async () => {
    h.respond(() => rfFillAnswer({withheld: []}))
    const error = takedown()
    const result = run(() => Promise.reject(error))
    await jest.advanceTimersByTimeAsync(100)
    expect(result()?.error).toBe(error)
    // The 10 min skip rethrows the stock error with no second fill.
    const again = run(() => Promise.reject(error))
    await jest.advanceTimersByTimeAsync(100)
    expect(again()?.error).toBe(error)
    expect(h.fills()).toHaveLength(1)
  })

  it('a transient refract failure is ProfileUnavailableError, never the stock error', async () => {
    h.respond(() => {
      throw new TypeError('network down')
    })
    const result = run(() => Promise.reject(takedown()))
    await jest.advanceTimersByTimeAsync(100)
    const error = result()?.error
    expect(error).toBeInstanceOf(ProfileUnavailableError)
    expect((error as ProfileUnavailableError).reason).toBe('transient')
    expect(String((error as Error).message)).not.toContain('suspended')
  })

  it('pending holds the loading state through the 10 s re-ask', async () => {
    h.respond(() => rfFillAnswer({pending: [RF_DID], withheld: []}))
    const result = run(() => Promise.reject(takedown()))
    await jest.advanceTimersByTimeAsync(9_000)
    expect(result()).toBeUndefined()
    await jest.advanceTimersByTimeAsync(2_000)
    expect((result()?.error as ProfileUnavailableError).reason).toBe('pending')
  })

  it('a refetch over a restored view keeps it when the answer is pending, without a hold', async () => {
    h.respond(() => rfFillAnswer({profiles: [rfProfile()], withheld: []}))
    const first = run(() => Promise.reject(takedown()))
    await jest.advanceTimersByTimeAsync(100)
    const view = first()?.value
    h.queryClient.setQueryData(['profile', RF_DID], view)
    h.respond(() => rfFillAnswer({pending: [RF_DID], withheld: []}))
    const again = run(() => Promise.reject(takedown()))
    await jest.advanceTimersByTimeAsync(200)
    expect(again()?.value).toBe(view)
  })

  it('a stock 429 is rethrown and asks nothing', async () => {
    const error = xrpcError(429, 'RateLimitExceeded')
    const result = run(() => Promise.reject(error))
    await jest.advanceTimersByTimeAsync(100)
    expect(result()?.error).toBe(error)
    expect(h.fills()).toHaveLength(0)
  })

  it('prewarm: a later stock success replaces the restored view', async () => {
    noteRestored(RF_DID)
    h.respond(() => rfFillAnswer({profiles: [rfProfile()], withheld: []}))
    const stockView = {did: RF_DID, handle: 'stock.example.test'}
    const result = run(
      () => new Promise(resolve => setTimeout(() => resolve(stockView), 2_000)),
    )
    await jest.advanceTimersByTimeAsync(100)
    expect(fromRefract(result()?.value)).toBe(true)
    await jest.advanceTimersByTimeAsync(2_000)
    expect(h.queryClient.getQueryData(['profile', RF_DID])).toEqual(stockView)
  })
})
