import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

const mockPersistedWrite = jest.fn()
jest.mock('#/state/persisted', () => ({
  write: (...args: unknown[]) => mockPersistedWrite(...args),
}))
const mockLocal = new Map<string, string>()
const mockWriteLocal = jest.fn((key: string, value: string | undefined) => {
  if (value === undefined) mockLocal.delete(key)
  else mockLocal.set(key, value)
})
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: (key: string) => mockLocal.get(key),
  writeLocal: (key: string, value: string | undefined) =>
    mockWriteLocal(key, value),
  subscribeLocal: () => () => {},
}))
let mockProbeFallback = true
/*
 * The Phase 2 cases run on the legacy probe (`MEMBERSHIP_QUERY` off); the
 * 2H cases turn it on.
 */
let mockMembershipQuery = false
// Live getters, so each test can flip the switches.
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {
      MEMBERSHIP_PROBE_FALLBACK: {
        get: () => mockProbeFallback,
        enumerable: true,
      },
      MEMBERSHIP_QUERY: {get: () => mockMembershipQuery, enumerable: true},
    },
  ),
)

import {createLexClient} from '#/lib/lexClient'
import {nearhorizon} from '#/horizon/lexicons'
import {
  getPrivateTimeline,
  reportedPrismWrite,
} from '#/horizon/private/api/reads'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '../current-clients'
import {featuresAnswered, resetPrismFeatures, servesFeature} from '../features'
import {getPrismHealth, resetPrismHealth} from '../health'
import {
  getMembership,
  getPrivateIndexed,
  isMembershipConfirmed,
  isPrivateMember,
  MAX_UNKNOWN_ATTEMPTS,
  MEMBERSHIP_RECHECK_MIN_MS,
  membershipFromError,
  membershipStorageKey,
  onEnteredIndexing,
  type ProbeEnvironment,
  requestMembershipRecheck,
  resetMembership,
  RETRY_SCHEDULE_MS,
  RETRY_STEADY_MS,
  startMembershipProbe,
  subscribeMembership,
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
  const clock = {now: 1_000_000}
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
    now: () => clock.now,
  }
  return {
    env,
    timers,
    clock,
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

/** The v2 device record. */
function record(
  state: string,
  features: readonly string[] | null = null,
): string {
  return JSON.stringify({v: 2, state, features})
}

beforeEach(() => {
  resetMembership()
  resetPrismFeatures()
  resetPrismHealth()
  mockProbeFallback = true
  mockMembershipQuery = false
  replies = []
  requests.length = 0
  mockPersistedWrite.mockReset()
  mockWriteLocal.mockClear()
  mockLocal.clear()
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
      // A plain busy 503: a named Unavailable carries prism's 30 s floor.
      replies.push({status: 503, body: {error: 'NotEnoughResources'}})
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

  describe('with public indexing off (501 NotImplemented)', () => {
    const notImplemented: Reply = {
      status: 501,
      body: {error: 'NotImplemented', message: 'public indexing is off'},
    }

    it('falls back to the private timeline, and its success means member', async () => {
      replies.push(notImplemented, {status: 200, body: {feed: []}})
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(requests).toHaveLength(2)
      expect(requests[0]).toContain('/xrpc/app.bsky.feed.getTimeline')
      expect(requests[1]).toContain('/xrpc/app.nearhorizon.private.getTimeline')
      expect(requests[1]).toContain('limit=1')
      expect(getMembership(DID)).toBe('member')
      expect(clock.timers).toHaveLength(0)
    })

    it('NotReady from the fallback means indexing, and retries ask the private timeline', async () => {
      replies.push(notImplemented, {status: 400, body: {error: 'NotReady'}})
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(getMembership(DID)).toBe('indexing')
      expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])

      replies.push({status: 200, body: {feed: []}})
      clock.fireNext()
      await settle()
      expect(requests).toHaveLength(3)
      expect(requests[2]).toContain('/xrpc/app.nearhorizon.private.getTimeline')
      expect(getMembership(DID)).toBe('member')
    })

    it('NotEnrolled from the fallback means not-member, and stops', async () => {
      replies.push(notImplemented, {status: 400, body: {error: 'NotEnrolled'}})
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(getMembership(DID)).toBe('not-member')
      expect(clock.timers).toHaveLength(0)
    })

    it('with the switch off a 501 stays unknown', async () => {
      mockProbeFallback = false
      replies.push(notImplemented)
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(requests).toHaveLength(1)
      expect(getMembership(DID)).toBe('unknown')
      expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])
    })
  })

  describe('persisted per account', () => {
    /** A new app start: memory is gone, the device keys stay. */
    function relaunch() {
      resetMembership()
      resetPrismFeatures()
    }

    it('keeps each answered state in its own device key, never in Bluesky storage', async () => {
      for (const [error, state] of [
        [undefined, 'member'],
        ['NotReady', 'indexing'],
        ['NotEnrolled', 'not-member'],
      ] as const) {
        relaunch()
        replies.push(
          error
            ? {status: 400, body: {error}}
            : {status: 200, body: {feed: []}},
        )
        const cancel = startMembershipProbe(DID, prism, manualEnvironment().env)
        await settle()
        cancel()
        expect(mockLocal.get(membershipStorageKey(DID))).toBe(record(state))
      }
      expect(mockPersistedWrite).not.toHaveBeenCalled()
    })

    it('starts from the persisted state at once, unconfirmed, before any answer', () => {
      mockLocal.set(membershipStorageKey(DID), 'member')
      relaunch()
      expect(getMembership(DID)).toBe('member')
      expect(isMembershipConfirmed(DID)).toBe(false)
      expect(getMembership('did:plc:someoneelseaaaaaaaaaaaaa')).toBe('unknown')
    })

    it('re-checks in the background: the same answer confirms it', async () => {
      mockLocal.set(membershipStorageKey(DID), 'member')
      relaunch()
      replies.push({status: 200, body: {feed: []}})
      startMembershipProbe(DID, prism, manualEnvironment().env)
      expect(getMembership(DID)).toBe('member')
      await settle()
      expect(getMembership(DID)).toBe('member')
      expect(isMembershipConfirmed(DID)).toBe(true)
      // The plain round 3 value is upgraded to the v2 record, once.
      expect(mockWriteLocal).toHaveBeenCalledTimes(1)
      expect(mockLocal.get(membershipStorageKey(DID))).toBe(record('member'))
    })

    it('re-checks in the background: a changed answer replaces it, in memory and on the device', async () => {
      mockLocal.set(membershipStorageKey(DID), 'member')
      relaunch()
      replies.push({status: 400, body: {error: 'NotEnrolled'}})
      startMembershipProbe(DID, prism, manualEnvironment().env)
      await settle()
      expect(getMembership(DID)).toBe('not-member')
      expect(mockLocal.get(membershipStorageKey(DID))).toBe(
        record('not-member'),
      )
    })

    it('a failed re-check keeps the persisted state, unconfirmed', async () => {
      mockLocal.set(membershipStorageKey(DID), 'member')
      relaunch()
      replies.push(new TypeError('Failed to fetch'))
      startMembershipProbe(DID, prism, manualEnvironment().env)
      await settle()
      expect(getMembership(DID)).toBe('member')
      expect(isMembershipConfirmed(DID)).toBe(false)
    })

    it('ignores a value it did not write', () => {
      mockLocal.set(membershipStorageKey(DID), 'admin')
      relaunch()
      expect(getMembership(DID)).toBe('unknown')
    })
  })

  describe('the membership query (2H, MEMBERSHIP_QUERY on)', () => {
    const FEATURES = ['private', 'private.embeds', 'private.bookmarks']
    const answer = (status: string, headers?: Record<string, string>) => ({
      status: 200,
      body: {status, features: FEATURES},
      headers,
    })

    beforeEach(() => {
      mockMembershipQuery = true
    })

    it('member: one getMembership, no getTimeline, features recorded and persisted', async () => {
      replies.push(answer('member'))
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain('/xrpc/app.nearhorizon.actor.getMembership')
      expect(getMembership(DID)).toBe('member')
      expect(isMembershipConfirmed(DID)).toBe(true)
      expect(featuresAnswered(DID)).toBe(true)
      expect(servesFeature('private.bookmarks', DID)).toBe(true)
      expect(servesFeature('private.search', DID)).toBe(false)
      expect(clock.timers).toHaveLength(0)
      expect(mockLocal.get(membershipStorageKey(DID))).toBe(
        record('member', FEATURES),
      )
    })

    it('indexing retries after Retry-After, else the schedule', async () => {
      replies.push(answer('indexing', {'retry-after': '7'}))
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(getMembership(DID)).toBe('indexing')
      expect(servesFeature('private.embeds', DID)).toBe(true)
      expect(clock.timers.map(t => t.ms)).toEqual([7_000])

      relaunchProbe()
      replies.push(answer('indexing'))
      const clock2 = manualEnvironment()
      startMembershipProbe(DID, prism, clock2.env)
      await settle()
      expect(clock2.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])
    })

    it('T-12: servesFeature(private.degraded) after a probe listing it, not for an older saved list', async () => {
      mockLocal.set(membershipStorageKey(DID), record('member', FEATURES))
      relaunchProbe()
      expect(servesFeature('private.degraded', DID)).toBe(false)
      expect(servesFeature('private.reindexing', DID)).toBe(false)
      replies.push({
        status: 200,
        body: {
          status: 'member',
          features: [...FEATURES, 'private.degraded', 'private.reindexing'],
        },
      })
      startMembershipProbe(DID, prism, manualEnvironment().env)
      await settle()
      expect(servesFeature('private.degraded', DID)).toBe(true)
      expect(servesFeature('private.reindexing', DID)).toBe(true)
    })

    it('notEligible is not-member, with no retry, features still recorded', async () => {
      replies.push(answer('notEligible'))
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(getMembership(DID)).toBe('not-member')
      expect(featuresAnswered(DID)).toBe(true)
      expect(clock.timers).toHaveLength(0)
    })

    it('an unknown status keeps the state, records the features, and retries as an attempt', async () => {
      replies.push(answer('somethingNew'))
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(getMembership(DID)).toBe('unknown')
      expect(servesFeature('private.embeds', DID)).toBe(true)
      expect(mockLocal.get(membershipStorageKey(DID))).toBeUndefined()
      expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])
    })

    it('a 429 keeps everything and waits for Retry-After, else the schedule', async () => {
      replies.push({
        status: 429,
        body: {error: 'RateLimitExceeded'},
        headers: {'retry-after': '30'},
      })
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(getMembership(DID)).toBe('unknown')
      expect(featuresAnswered(DID)).toBe(false)
      expect(clock.timers.map(t => t.ms)).toEqual([30_000])

      replies.push({status: 429, body: {error: 'RateLimitExceeded'}})
      clock.fireNext()
      await settle()
      expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[1]])
    })

    for (const [label, reply] of [
      ['404', {status: 404, body: {error: 'NotFound'}}],
      [
        '501 MethodNotImplemented',
        {status: 501, body: {error: 'MethodNotImplemented'}},
      ],
      ['a non-XRPC 404', {status: 404, body: 'Not Found'}],
    ] as const) {
      it(`${label} falls back to getTimeline, then the private timeline, with no features`, async () => {
        replies.push(
          reply,
          {status: 501, body: {error: 'NotImplemented'}},
          {status: 200, body: {feed: []}},
        )
        const clock = manualEnvironment()
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        expect(requests).toHaveLength(3)
        expect(requests[1]).toContain('/xrpc/app.bsky.feed.getTimeline')
        expect(requests[2]).toContain(
          '/xrpc/app.nearhorizon.private.getTimeline',
        )
        expect(getMembership(DID)).toBe('member')
        expect(featuresAnswered(DID)).toBe(true)
        expect(servesFeature('private', DID)).toBe(true)
        expect(servesFeature('private.embeds', DID)).toBe(false)
        expect(mockLocal.get(membershipStorageKey(DID))).toBe(record('member'))
      })
    }

    it('a network failure stays unknown and retries', async () => {
      replies.push(new TypeError('Failed to fetch'))
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(getMembership(DID)).toBe('unknown')
      expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])
    })

    it('a 200 that does not parse is an unanswered attempt', async () => {
      replies.push({status: 200, body: {status: 'member', features: [1, 2]}})
      const clock = manualEnvironment()
      startMembershipProbe(DID, prism, clock.env)
      await settle()
      expect(getMembership(DID)).toBe('unknown')
      expect(featuresAnswered(DID)).toBe(false)
      expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])
    })

    it('MEMBERSHIP_QUERY off asks no getMembership', async () => {
      mockMembershipQuery = false
      replies.push({status: 200, body: {feed: []}})
      startMembershipProbe(DID, prism, manualEnvironment().env)
      await settle()
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain('/xrpc/app.bsky.feed.getTimeline')
    })

    it('writes the record once per change and reads it back', async () => {
      replies.push(answer('member'))
      startMembershipProbe(DID, prism, manualEnvironment().env)
      await settle()
      expect(mockWriteLocal).toHaveBeenCalledTimes(1)
      relaunchProbe()
      expect(getMembership(DID)).toBe('member')
      expect(servesFeature('private.bookmarks', DID)).toBe(true)
      expect(featuresAnswered(DID)).toBe(false)
      replies.push(answer('member'))
      startMembershipProbe(DID, prism, manualEnvironment().env)
      await settle()
      expect(mockWriteLocal).toHaveBeenCalledTimes(1)
    })

    it('a round 3 plain value reads with features never answered; malformed JSON is ignored', () => {
      mockLocal.set(membershipStorageKey(DID), 'member')
      relaunchProbe()
      expect(getMembership(DID)).toBe('member')
      expect(servesFeature('private', DID)).toBe(true)
      expect(servesFeature('private.embeds', DID)).toBe(false)
      mockLocal.set(membershipStorageKey(DID), '{"v":2,"state":')
      relaunchProbe()
      expect(getMembership(DID)).toBe('unknown')
      mockLocal.set(membershipStorageKey(DID), record('admin'))
      relaunchProbe()
      expect(getMembership(DID)).toBe('unknown')
    })

    describe('T-3: calls never demote (BR-1)', () => {
      const REINDEXING: Reply = {
        status: 503,
        body: {error: 'Reindexing', retryAfter: 30},
      }

      /** A member answered by the probe, with the current clients published. */
      async function member() {
        replies.push(answer('member'))
        const clock = manualEnvironment()
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        publishCurrentClients({did: DID} as unknown as CurrentClients)
        mockWriteLocal.mockClear()
        return clock
      }

      afterEach(() => {
        clearCurrentClients()
      })

      it('a read’s Reindexing leaves member, persists nothing, no toast, and forces a recheck inside 60 s at the 30 s hint', async () => {
        const entered: string[] = []
        const unsubscribe = onEnteredIndexing(did => entered.push(did))
        const clock = await member()
        replies.push(REINDEXING)
        await expect(getPrivateTimeline(prism, {})).rejects.toThrow()
        expect(getMembership(DID)).toBe('member')
        expect(isPrivateMember(DID)).toBe(true)
        expect(mockWriteLocal).not.toHaveBeenCalled()
        expect(entered).toEqual([])
        expect(getPrismHealth(DID).causes.has('catching-up')).toBe(true)
        // Forced: well inside MEMBERSHIP_RECHECK_MIN_MS of the last answer.
        expect(clock.timers.map(t => t.ms)).toEqual([30_000])
        replies.push(answer('member'))
        clock.fireNext()
        await settle()
        expect(requests).toHaveLength(3)
        expect(requests[2]).toContain('getMembership')
        expect(getPrismHealth(DID).causes.has('catching-up')).toBe(false)
        unsubscribe()
      })

      it('a read’s 400 NotReady leaves member; the forced probe’s indexing demotes, with the toast', async () => {
        const entered: string[] = []
        const unsubscribe = onEnteredIndexing(did => entered.push(did))
        const clock = await member()
        replies.push({status: 400, body: {error: 'NotReady'}})
        await expect(getPrivateTimeline(prism, {})).rejects.toThrow()
        expect(getMembership(DID)).toBe('member')
        expect(entered).toEqual([])
        expect(clock.timers.map(t => t.ms)).toEqual([RETRY_SCHEDULE_MS[0]])
        replies.push(answer('indexing'))
        clock.fireNext()
        await settle()
        expect(getMembership(DID)).toBe('indexing')
        expect(entered).toEqual([DID])
        unsubscribe()
      })

      it('the forced recheck stays single-flight and only moves a timer earlier', async () => {
        const clock = await member()
        replies.push(REINDEXING)
        await expect(getPrivateTimeline(prism, {})).rejects.toThrow()
        requestMembershipRecheck(DID, {force: true, atMs: 60_000})
        expect(clock.timers.map(t => t.ms)).toEqual([30_000])
        requestMembershipRecheck(DID, {force: true, atMs: 5_000})
        expect(clock.timers.map(t => t.ms)).toEqual([5_000])
      })

      it('membershipFromError gives nothing for Reindexing', async () => {
        replies.push(REINDEXING)
        const reindexing = await prism
          .call(nearhorizon.privateGetTimeline, {})
          .catch((e: unknown) => e)
        expect(membershipFromError(reindexing)).toBe(undefined)
      })

      it('after 503 Reindexing from getTimeline, still a member', async () => {
        await member()
        replies.push(REINDEXING)
        await expect(getPrivateTimeline(prism, {})).rejects.toThrow()
        expect(getMembership(DID)).toBe('member')
        expect(isPrivateMember(DID)).toBe(true)
      })

      it('NotEnrolled from a read still demotes', async () => {
        await member()
        replies.push({status: 400, body: {error: 'NotEnrolled'}})
        await expect(getPrivateTimeline(prism, {})).rejects.toThrow()
        expect(getMembership(DID)).toBe('not-member')
      })
    })

    describe('T-4: membership while re-indexing (BR-2, 2.3)', () => {
      const reindexing = (headers?: Record<string, string>, valid = 30) => ({
        status: 200,
        body: {
          status: 'reindexing',
          features: [...FEATURES, 'private.reindexing'],
          permissions: {privateRead: true, privateIndexed: true},
          ...(valid ? {validForSecs: valid} : {}),
        },
        headers,
      })

      it('reindexing is an answered member: confirmed, listeners told, record written, catching-up set, polled at Retry-After', async () => {
        const listener = jest.fn()
        const unsubscribe = subscribeMembership(listener)
        replies.push(reindexing({'retry-after': '20'}))
        const clock = manualEnvironment()
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        expect(getMembership(DID)).toBe('member')
        expect(isMembershipConfirmed(DID)).toBe(true)
        expect(listener).toHaveBeenCalled()
        expect(mockLocal.get(membershipStorageKey(DID))).toBe(
          record('member', [...FEATURES, 'private.reindexing']),
        )
        expect(getPrismHealth(DID).causes.has('catching-up')).toBe(true)
        expect(clock.timers.map(t => t.ms)).toEqual([20_000])
        unsubscribe()
      })

      it('without Retry-After it polls at validForSecs, else 30 s', async () => {
        replies.push(reindexing(undefined, 45))
        const clock = manualEnvironment()
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        expect(clock.timers.map(t => t.ms)).toEqual([45_000])
        replies.push(reindexing(undefined, 0))
        clock.fireNext()
        await settle()
        expect(clock.timers.map(t => t.ms)).toEqual([30_000])
      })

      it('a later member clears catching-up and ends the polling', async () => {
        replies.push(reindexing())
        const clock = manualEnvironment()
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        replies.push(answer('member'))
        clock.fireNext()
        await settle()
        expect(getMembership(DID)).toBe('member')
        expect(getPrismHealth(DID).causes.has('catching-up')).toBe(false)
        expect(clock.timers).toHaveLength(0)
      })

      it('indexing after reindexing demotes, with the toast', async () => {
        const entered: string[] = []
        const unsubscribe = onEnteredIndexing(did => entered.push(did))
        replies.push(reindexing())
        const clock = manualEnvironment()
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        expect(entered).toEqual([])
        replies.push(answer('indexing'))
        clock.fireNext()
        await settle()
        expect(getMembership(DID)).toBe('indexing')
        expect(entered).toEqual([DID])
        expect(getPrismHealth(DID).causes.has('catching-up')).toBe(false)
        unsubscribe()
      })

      it('fresh device: confirmed member with privateIndexed, and twelve reindexing in a row keep polling', async () => {
        expect(mockLocal.get(membershipStorageKey(DID))).toBeUndefined()
        const clock = manualEnvironment()
        for (let i = 0; i < 12; i++) replies.push(reindexing())
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        expect(getMembership(DID)).toBe('member')
        expect(isMembershipConfirmed(DID)).toBe(true)
        expect(getPrivateIndexed(DID)).toBe(true)
        for (let i = 1; i < 12; i++) {
          expect(clock.timers).toHaveLength(1)
          clock.fireNext()
          await settle()
        }
        expect(requests).toHaveLength(12)
        // Past MAX_UNKNOWN_ATTEMPTS, still polling.
        expect(clock.timers.map(t => t.ms)).toEqual([30_000])
        expect(getMembership(DID)).toBe('member')
      })
    })

    describe('the recheck (3.4)', () => {
      it('asks once more after 60 s, not before, and not while a retry is pending', async () => {
        replies.push(answer('member'))
        const clock = manualEnvironment()
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        expect(requests).toHaveLength(1)

        requestMembershipRecheck(DID)
        await settle()
        expect(requests).toHaveLength(1)

        clock.clock.now += MEMBERSHIP_RECHECK_MIN_MS
        replies.push(answer('indexing'))
        requestMembershipRecheck(DID)
        await settle()
        expect(requests).toHaveLength(2)
        expect(clock.timers).toHaveLength(1)

        clock.clock.now += MEMBERSHIP_RECHECK_MIN_MS
        requestMembershipRecheck(DID)
        await settle()
        expect(requests).toHaveLength(2)
      })

      it('a private 501 MethodNotImplemented (a bookmark write) asks again', async () => {
        replies.push(answer('member'))
        const clock = manualEnvironment()
        startMembershipProbe(DID, prism, clock.env)
        await settle()
        clock.clock.now += MEMBERSHIP_RECHECK_MIN_MS
        publishCurrentClients({did: DID} as unknown as CurrentClients)
        replies.push(
          {status: 501, body: {error: 'MethodNotImplemented'}},
          {status: 200, body: {status: 'member', features: ['private']}},
        )
        await expect(
          reportedPrismWrite(nearhorizon.privateCreateBookmark, {
            send: () =>
              prism.call(nearhorizon.privateCreateBookmark, {
                uri: `at://${DID}/tools.kryphocron.feed.postPrivate/3kx`,
                cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
              }),
          }),
        ).rejects.toThrow()
        await settle()
        expect(requests).toHaveLength(3)
        expect(requests[2]).toContain('getMembership')
        expect(servesFeature('private.bookmarks', DID)).toBe(false)
        clearCurrentClients()
      })
    })

    /** A new app start: memory is gone, the device keys stay. */
    function relaunchProbe() {
      resetMembership()
      resetPrismFeatures()
    }
  })
})
