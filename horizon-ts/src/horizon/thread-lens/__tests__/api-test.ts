import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

const mockReport = jest.fn<(did: string, error: unknown) => void>()
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: (did: string, error: unknown) => mockReport(did, error),
  isPrivateMember: (did?: string) => !!did,
}))

import {resetPrismHealth} from '#/horizon/routing/health'
import {
  getLensRefusal,
  getLensThread,
  getLensWaitUntil,
  isLensWaiting,
  LENS_RATE_LIMIT_FALLBACK_MS,
  lensFailureOf,
  lensThreadBody,
  LensWaitError,
  liftLensNotReady,
  pendingLensTimerCount,
  recordLensWait,
  resetLensRefusals,
  resetLensWaits,
  resolveLens,
  subscribeLensWaits,
} from '#/horizon/thread-lens/api'
import {
  lensAnswer,
  OTHER_READER,
  READER,
  type Reply,
  server,
  uriOf,
} from './harness'

const ANCHOR = uriOf('3kanchor22222')

let reply: () => Reply = () => lensAnswer(ANCHOR, [])

function prism() {
  return server(READER, () => reply())
}

beforeEach(() => {
  reply = () => lensAnswer(ANCHOR, [])
  mockReport.mockClear()
  resetPrismHealth()
  resetLensWaits()
  resetLensRefusals()
})

afterEach(() => {
  jest.useRealTimers()
  resetLensWaits()
})

describe('the request (5.2, 9.2, 9.5)', () => {
  it('asks the first read with the request depth and no parentHeight', () => {
    expect(lensThreadBody({kind: 'first', anchor: ANCHOR, depth: 10})).toEqual({
      anchor: ANCHOR,
      depth: 10,
    })
    expect(lensThreadBody({kind: 'first', anchor: ANCHOR, depth: 6})).toEqual({
      anchor: ANCHOR,
      depth: 6,
    })
  })

  it('asks "Load more replies" with parentHeight 0 and the cursor', () => {
    expect(
      lensThreadBody({kind: 'replies', anchor: ANCHOR, depth: 3, cursor: 'c'}),
    ).toEqual({anchor: ANCHOR, parentHeight: 0, depth: 3, repliesCursor: 'c'})
    expect(lensThreadBody({kind: 'replies', anchor: ANCHOR, depth: 0})).toEqual(
      {anchor: ANCHOR, parentHeight: 0, depth: 1},
    )
  })

  it('asks "Load earlier posts" with depth 0 and parentHeight 80', () => {
    expect(lensThreadBody({kind: 'parents', anchor: ANCHOR})).toEqual({
      anchor: ANCHOR,
      depth: 0,
      parentHeight: 80,
    })
  })

  it('sends small pages only in development with the setting (R2-N9)', () => {
    const env = process.env as Record<string, string | undefined>
    const global = globalThis as unknown as {__DEV__: boolean}
    const dev = global.__DEV__
    env.EXPO_PUBLIC_HORIZON_LENS_SMALL_PAGES = '1'
    try {
      global.__DEV__ = true
      expect(
        lensThreadBody({kind: 'first', anchor: ANCHOR, depth: 10}),
      ).toEqual({anchor: ANCHOR, depth: 2, parentHeight: 2})
      expect(
        lensThreadBody({kind: 'replies', anchor: ANCHOR, depth: 5}),
      ).toEqual({anchor: ANCHOR, parentHeight: 0, depth: 2})
      expect(lensThreadBody({kind: 'parents', anchor: ANCHOR})).toEqual({
        anchor: ANCHOR,
        depth: 0,
        parentHeight: 2,
      })
      global.__DEV__ = false
      expect(
        lensThreadBody({kind: 'first', anchor: ANCHOR, depth: 10}),
      ).toEqual({anchor: ANCHOR, depth: 10})
    } finally {
      global.__DEV__ = dev
      delete env.EXPO_PUBLIC_HORIZON_LENS_SMALL_PAGES
    }
  })

  it('posts the body to the client it is given, with no DID field', async () => {
    const fake = prism()
    await getLensThread(fake.client, READER, {anchor: ANCHOR, depth: 10})
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].nsid).toBe('app.nearhorizon.threadLens.getThread')
    expect(fake.calls[0].body).toEqual({anchor: ANCHOR, depth: 10})
  })

  it('resolves at most 25 URIs a call', async () => {
    reply = () => ({status: 200, body: {items: [], bridging: 'full'}})
    const fake = prism()
    const uris = Array.from({length: 30}, (_, i) => uriOf(`3kr${i}2222222`))
    await resolveLens(fake.client, READER, uris)
    expect((fake.calls[0].body?.uris as string[]).length).toBe(25)
  })
})

describe('the 429 wait (11.5)', () => {
  async function rateLimited(headers: Record<string, string>) {
    reply = () => ({
      status: 429,
      body: {error: 'RateLimitExceeded'},
      headers,
    })
    const before = Date.now()
    await expect(
      getLensThread(prism().client, READER, {anchor: ANCHOR}),
    ).rejects.toBeTruthy()
    return {before, until: getLensWaitUntil(READER)!}
  }

  it('waits for Retry-After in seconds', async () => {
    const {before, until} = await rateLimited({'retry-after': '30'})
    expect(until - before).toBeGreaterThanOrEqual(29_000)
    expect(until - before).toBeLessThan(32_000)
  })

  it('waits for Retry-After as an HTTP-date', async () => {
    const date = new Date(Date.now() + 60_000).toUTCString()
    const {before, until} = await rateLimited({'retry-after': date})
    expect(until - before).toBeGreaterThan(55_000)
    expect(until - before).toBeLessThan(62_000)
  })

  it('waits for ratelimit-reset alone', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 20)
    const {before, until} = await rateLimited({'ratelimit-reset': reset})
    expect(until - before).toBeGreaterThan(17_000)
    expect(until - before).toBeLessThan(22_000)
  })

  it('waits 10 s with neither header', async () => {
    const {before, until} = await rateLimited({})
    expect(until - before).toBeGreaterThanOrEqual(
      LENS_RATE_LIMIT_FALLBACK_MS - 100,
    )
    expect(until - before).toBeLessThan(LENS_RATE_LIMIT_FALLBACK_MS + 2_000)
  })

  it('fails at once during the wait, asking prism nothing', async () => {
    await rateLimited({'retry-after': '30'})
    const fake = prism()
    const error = await getLensThread(fake.client, READER, {
      anchor: ANCHOR,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LensWaitError)
    expect(fake.calls).toHaveLength(0)
    expect(lensFailureOf(error)).toMatchObject({
      kind: 'rate-limited',
      called: false,
    })
  })

  it('keeps the later time, and ends the wait as a store event', () => {
    jest.useFakeTimers({now: 1_000_000})
    const events = jest.fn()
    const unsubscribe = subscribeLensWaits(events)
    recordLensWait(READER, 1_030_000)
    recordLensWait(READER, 1_010_000)
    expect(getLensWaitUntil(READER)).toBe(1_030_000)
    recordLensWait(READER, 1_040_000)
    expect(getLensWaitUntil(READER)).toBe(1_040_000)
    expect(pendingLensTimerCount()).toBe(1)
    events.mockClear()
    jest.advanceTimersByTime(30_000)
    expect(isLensWaiting(READER)).toBe(true)
    jest.advanceTimersByTime(10_000)
    expect(isLensWaiting(READER)).toBe(false)
    expect(events).toHaveBeenCalledTimes(1)
    expect(pendingLensTimerCount()).toBe(0)
    unsubscribe()
  })

  it('resetLensWaits leaves no timer', () => {
    jest.useFakeTimers()
    recordLensWait(READER, Date.now() + 5_000)
    recordLensWait(OTHER_READER, Date.now() + 5_000)
    expect(pendingLensTimerCount()).toBe(2)
    resetLensWaits()
    expect(pendingLensTimerCount()).toBe(0)
  })
})

describe('refusals and other failures (3.2, 11.3)', () => {
  it.each([
    [{status: 400, body: {error: 'NotEnrolled'}}, 'NotEnrolled'],
    [{status: 400, body: {error: 'NotReady'}}, 'NotReady'],
    [
      {status: 501, body: {error: 'MethodNotImplemented'}},
      'MethodNotImplemented',
    ],
  ])('records %j as a refusal for the key DID', async (answer, refusal) => {
    reply = () => answer
    // The call is for READER even though another account may be current.
    await expect(
      getLensThread(prism().client, READER, {anchor: ANCHOR}),
    ).rejects.toBeTruthy()
    expect(getLensRefusal(READER)).toBe(refusal)
    expect(getLensRefusal(OTHER_READER)).toBeUndefined()
    expect(mockReport).toHaveBeenCalledWith(READER, expect.anything())
  })

  it('lifts a NotReady refusal, never a NotEnrolled one', async () => {
    reply = () => ({status: 400, body: {error: 'NotReady'}})
    await getLensThread(prism().client, READER, {anchor: ANCHOR}).catch(
      () => {},
    )
    liftLensNotReady(READER)
    expect(getLensRefusal(READER)).toBeUndefined()
    reply = () => ({status: 400, body: {error: 'NotEnrolled'}})
    await getLensThread(prism().client, READER, {anchor: ANCHOR}).catch(
      () => {},
    )
    liftLensNotReady(READER)
    expect(getLensRefusal(READER)).toBe('NotEnrolled')
  })

  it('reads Reindexing as a failure with its hint, not a refusal', async () => {
    reply = () => ({
      status: 503,
      body: {error: 'Reindexing', retryAfter: 40},
    })
    const before = Date.now()
    const error = await getLensThread(prism().client, READER, {
      anchor: ANCHOR,
    }).catch((e: unknown) => e)
    const failure = lensFailureOf(error)
    expect(failure.kind).toBe('reindexing')
    const retryAt = (failure as {retryAt: number}).retryAt
    expect(retryAt - before).toBeGreaterThanOrEqual(39_000)
    expect(getLensRefusal(READER)).toBeUndefined()
    expect(isLensWaiting(READER)).toBe(false)
  })

  it.each([
    [{status: 500, body: {error: 'InternalServerError'}}, 'unavailable'],
    [{status: 401, body: {error: 'AuthMissing'}}, 'unavailable'],
    [{status: 400, body: {error: 'InvalidRequest'}}, 'invalid-request'],
    [new Error('network down'), 'unavailable'],
  ])('reads %j as %s', async (answer, kind) => {
    reply = () => answer
    const error = await getLensThread(prism().client, READER, {
      anchor: ANCHOR,
    }).catch((e: unknown) => e)
    expect(lensFailureOf(error).kind).toBe(kind)
    expect(getLensRefusal(READER)).toBeUndefined()
  })

  it('fails a malformed body as unavailable', async () => {
    reply = () => ({status: 200, body: {anchor: ANCHOR, nodes: 'nope'}})
    const error = await getLensThread(prism().client, READER, {
      anchor: ANCHOR,
    }).catch((e: unknown) => e)
    expect(lensFailureOf(error).kind).toBe('unavailable')
  })
})
