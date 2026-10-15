import {beforeEach, describe, expect, it, jest} from '@jest/globals'

const mockPersistedWrite = jest.fn()
jest.mock('#/state/persisted', () => ({
  write: (...args: unknown[]) => mockPersistedWrite(...args),
}))
const mockWriteLocal = jest.fn()
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: (...args: unknown[]) => mockWriteLocal(...args),
  subscribeLocal: () => () => {},
}))

import {createLexClient} from '#/lib/lexClient'
import {
  getMembership,
  MAX_UNKNOWN_ATTEMPTS,
  onEnteredIndexing,
  type ProbeEnvironment,
  resetMembership,
  RETRY_SCHEDULE_MS,
  RETRY_STEADY_MS,
  startMembershipProbe,
} from '../membership'

const DID = 'did:plc:membershipaaaaaaaaaaaaaa'

type Reply = {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

let replies: (Reply | Error)[] = []
const requests: string[] = []

const fakeFetch = (input: RequestInfo | URL) => {
  requests.push(String(input instanceof Request ? input.url : input))
  const next = replies.shift()
  if (!next) return Promise.reject(new Error('no reply queued'))
  if (next instanceof Error) return Promise.reject(next)
  return Promise.resolve(
    new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: {'content-type': 'application/json', ...next.headers},
    }),
  )
}

const prism = createLexClient(
  {service: 'https://prism.example', fetch: fakeFetch},
  {appLabelers: null},
)

/** A manual clock: timers run only when the test says so. */
function manualEnvironment() {
  const timers: {callback: () => void; ms: number}[] = []
  let hidden = false
  const visibleListeners = new Set<() => void>()
  const env: ProbeEnvironment = {
    setTimeout: (callback, ms) => {
      const timer = {callback, ms}
      timers.push(timer)
      return timer
    },
    clearTimeout: handle => {
      const index = timers.indexOf(handle as (typeof timers)[number])
      if (index >= 0) timers.splice(index, 1)
    },
    isHidden: () => hidden,
    onVisible: callback => {
      visibleListeners.add(callback)
      return () => visibleListeners.delete(callback)
    },
  }
  return {
    env,
    timers,
    fireNext() {
      const timer = timers.shift()
      if (!timer) throw new Error('no timer scheduled')
      timer.callback()
    },
    setHidden(value: boolean) {
      hidden = value
      if (!value) visibleListeners.forEach(listener => listener())
    },
  }
}

/** Let the probe's request and its handlers settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  resetMembership()
  replies = []
  requests.length = 0
  mockPersistedWrite.mockReset()
  mockWriteLocal.mockReset()
})

describe('the membership machine', () => {
  it('a successful probe means member', async () => {
    replies.push({status: 200, body: {feed: []}})
    const clock = manualEnvironment()
    startMembershipProbe(DID, prism, clock.env)
    await settle()
    expect(getMembership(DID)).toBe('member')
    expect(clock.timers).toHaveLength(0)
    expect(requests[0]).toContain('/xrpc/app.bsky.feed.getTimeline')
    expect(requests[0]).toContain('limit=1')
  })

  it('NotReady means indexing, with the notice, and retries on the schedule', async () => {
    replies.push({status: 400, body: {error: 'NotReady'}})
    const entered: string[] = []
    const unsubscribe = onEnteredIndexing(did => entered.push(did))
    const clock = manualEnvironment()
    startMembershipProbe(DID, prism, clock.env)
    await settle()
    expect(getMembership(DID)).toBe('indexing')
    expect(entered).toEqual([DID])
    expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])

    replies.push({status: 400, body: {error: 'NotReady'}})
    clock.fireNext()
    await settle()
    expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[1]])
    // Still indexing: the notice is not shown again.
    expect(entered).toEqual([DID])

    replies.push({status: 200, body: {feed: []}})
    clock.fireNext()
    await settle()
    expect(getMembership(DID)).toBe('member')
    unsubscribe()
  })

  it('Retry-After wins over the schedule', async () => {
    replies.push({
      status: 400,
      body: {error: 'NotReady'},
      headers: {'retry-after': '7'},
    })
    const clock = manualEnvironment()
    startMembershipProbe(DID, prism, clock.env)
    await settle()
    expect(clock.timers.map(t => t.ms)).toEqual([7_000])
  })

  it('NotEnrolled means not-member, and stops', async () => {
    replies.push({status: 400, body: {error: 'NotEnrolled'}})
    const clock = manualEnvironment()
    startMembershipProbe(DID, prism, clock.env)
    await settle()
    expect(getMembership(DID)).toBe('not-member')
    expect(clock.timers).toHaveLength(0)
  })

  it('a network failure stays unknown and retries', async () => {
    replies.push(new TypeError('Failed to fetch'))
    const clock = manualEnvironment()
    startMembershipProbe(DID, prism, clock.env)
    await settle()
    expect(getMembership(DID)).toBe('unknown')
    expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])
  })

  it('a 5xx stays unknown and retries', async () => {
    replies.push({status: 502, body: {error: 'UpstreamFailure'}})
    const clock = manualEnvironment()
    startMembershipProbe(DID, prism, clock.env)
    await settle()
    expect(getMembership(DID)).toBe('unknown')
    expect(clock.timers).toHaveLength(1)
  })

  it('unknown retries stop after the cap and resume when the tab becomes visible', async () => {
    const clock = manualEnvironment()
    for (let i = 0; i < MAX_UNKNOWN_ATTEMPTS; i++) {
      replies.push({status: 503, body: {error: 'Unavailable'}})
    }
    startMembershipProbe(DID, prism, clock.env)
    await settle()
    const delays: number[] = []
    while (clock.timers.length > 0) {
      delays.push(clock.timers[0].ms)
      clock.fireNext()
      await settle()
    }
    expect(requests).toHaveLength(MAX_UNKNOWN_ATTEMPTS)
    expect(delays.slice(0, RETRY_SCHEDULE_MS.length)).toEqual([
      ...RETRY_SCHEDULE_MS,
    ])
    expect(delays[RETRY_SCHEDULE_MS.length]).toBe(RETRY_STEADY_MS)

    replies.push({status: 200, body: {feed: []}})
    clock.setHidden(false)
    await settle()
    expect(getMembership(DID)).toBe('member')
  })

  it('retries pause while the tab is hidden', async () => {
    replies.push({status: 400, body: {error: 'NotReady'}})
    const clock = manualEnvironment()
    startMembershipProbe(DID, prism, clock.env)
    await settle()
    clock.setHidden(true)
    clock.fireNext()
    await settle()
    expect(requests).toHaveLength(1)
    replies.push({status: 200, body: {feed: []}})
    clock.setHidden(false)
    await settle()
    expect(requests).toHaveLength(2)
    expect(getMembership(DID)).toBe('member')
  })

  it('cancelling stops any retry', async () => {
    replies.push({status: 400, body: {error: 'NotReady'}})
    const clock = manualEnvironment()
    const cancel = startMembershipProbe(DID, prism, clock.env)
    await settle()
    cancel()
    expect(clock.timers).toHaveLength(0)
  })

  it('writes nothing to persisted storage', async () => {
    replies.push({status: 400, body: {error: 'NotEnrolled'}})
    startMembershipProbe(DID, prism, manualEnvironment().env)
    await settle()
    expect(getMembership(DID)).toBe('not-member')
    expect(mockPersistedWrite).not.toHaveBeenCalled()
    expect(mockWriteLocal).not.toHaveBeenCalled()
  })
})
