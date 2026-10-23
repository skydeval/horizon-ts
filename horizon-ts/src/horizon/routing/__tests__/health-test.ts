import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {type AtUriString} from '@atproto/syntax'

/*
 * T-2 (prism busy design 2 to 2.2), without the catch-up (BR-B14): health's
 * causes, the throttle, single-flight with the same-request join, the call
 * deadline, waiters' errors, writes, confirmation and `floorSince`, and
 * `mergeAnswers`.
 */
import {nearhorizon} from '#/horizon/lexicons'
import {
  type Call,
  fakeClient,
  privateUri,
  type Reply,
} from '#/horizon/private/__tests__/fixtures'
import {
  type AnswerContext,
  CALL_DEADLINE_MS,
  getPrivatePostThread,
  getPrivateTimeline,
  mergeAnswers,
  reportedPrismCall,
  reportedPrismWrite,
  updatePrivateSeen,
} from '#/horizon/private/api/reads'
import {
  isPrismUnavailable,
  PrivateDeadlineError,
  PrivateWaiterError,
} from '#/horizon/private/api/transient'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '../current-clients'
import {answerPrismFeatures, resetPrismFeatures} from '../features'
import {
  DEGRADED_DEFAULT_MS,
  floorSince,
  getPrismHealth,
  isPrismConfirmed,
  reportProbeStatus,
  reportReadOutcome,
  resetPrismHealth,
} from '../health'
import {resetMembership} from '../membership'

const DID = 'did:plc:healthaaaaaaaaaaaaaaaaaa'
const START = 1_000_000

/** A manual clock with its own timers; `random` is fixed at 0.5. */
function manualClock() {
  let now = START
  let seq = 0
  const timers = new Map<number, {at: number; callback: () => void}>()
  return {
    env: {
      now: () => now,
      setTimeout: (callback: () => void, ms: number): unknown => {
        const id = ++seq
        timers.set(id, {at: now + ms, callback})
        return id
      },
      clearTimeout: (handle: unknown) => {
        timers.delete(handle as number)
      },
      random: () => 0.5,
    },
    now: () => now,
    /** Move forward `ms`, running each timer as it comes due. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        await settle()
        let next: [number, {at: number; callback: () => void}] | undefined
        for (const entry of timers) {
          if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) {
            next = entry
          }
        }
        if (!next) break
        now = Math.max(now, next[1].at)
        timers.delete(next[0])
        next[1].callback()
      }
      now = end
      await settle()
    },
  }
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

type Held = {call: Call; resolve: (reply: Reply) => void}

/**
 * A prism whose every request waits until the test answers it
 * (`held`), unless `auto` answers it at once.
 */
function heldPrism() {
  const held: Held[] = []
  const state = {auto: undefined as ((call: Call) => Reply) | undefined}
  const prism = fakeClient(DID, call => {
    if (state.auto) return state.auto(call)
    return new Promise<Reply>(resolve => held.push({call, resolve}))
  })
  return {...prism, held, state}
}

const ok = (body: unknown): Reply => ({status: 200, body})
const xrpc = (status: number, body: Record<string, unknown>): Reply => ({
  status,
  body,
})
const REINDEXING = xrpc(503, {error: 'Reindexing', retryAfter: 30})
const TIMELINE = nearhorizon.privateGetTimeline.nsid
const THREAD = nearhorizon.privateGetPostThread.nsid
const ANCHOR = privateUri('3kanchor2222')

let clock: ReturnType<typeof manualClock>

beforeEach(() => {
  clock = manualClock()
  resetPrismHealth(clock.env)
  resetMembership()
  resetPrismFeatures()
  publishCurrentClients({did: DID} as unknown as CurrentClients)
})

afterEach(() => {
  clearCurrentClients()
})

/** A failure of one call, reported as the wrappers report it. */
function fail(method: string, error: unknown, seq = 0) {
  reportReadOutcome(DID, {kind: 'failed', method, seq, error})
}

/** A 2xx of one read. */
function answered(
  method: string,
  seq: number,
  opts: {degraded?: boolean; retryAfterMs?: number} = {},
) {
  reportReadOutcome(DID, {
    kind: 'answered',
    method,
    seq,
    read: true,
    degraded: opts.degraded ?? false,
    retryAfterMs: opts.retryAfterMs,
  })
}

async function errorOf(reply: Reply): Promise<unknown> {
  const prism = fakeClient(DID, () => reply)
  return prism.client
    .call(nearhorizon.privateGetTimeline, {})
    .catch((error: unknown) => error)
}

describe('causes (2.1)', () => {
  it('Reindexing sets catching-up; a 500 sets unavailable; a degraded answer sets degraded', async () => {
    fail(TIMELINE, await errorOf(REINDEXING))
    expect(getPrismHealth(DID).causes).toEqual(new Set(['catching-up']))
    fail(THREAD, await errorOf(xrpc(500, {error: 'InternalServerError'})))
    expect(getPrismHealth(DID).causes).toEqual(
      new Set(['catching-up', 'unavailable']),
    )
    answered(TIMELINE, 1, {degraded: true, retryAfterMs: 45_000})
    expect(getPrismHealth(DID).causes).toEqual(
      new Set(['catching-up', 'degraded']),
    )
  })

  it('a named Unavailable, a permanent error and a cancellation take nothing', async () => {
    fail(THREAD, await errorOf(xrpc(503, {error: 'Unavailable'})))
    fail(THREAD, await errorOf(xrpc(400, {error: 'NotFound'})))
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    fail(THREAD, abort)
    expect(getPrismHealth(DID).causes.size).toBe(0)
    expect(getPrismHealth(DID).failures).toBe(0)
  })

  it('the probe: indexing or not-member clears catching-up, so does member after reindexing; a second reindexing clears nothing', () => {
    for (const status of ['indexing', 'not-member', 'member'] as const) {
      reportProbeStatus(DID, 'reindexing')
      reportProbeStatus(DID, 'reindexing')
      expect(getPrismHealth(DID).causes.has('catching-up')).toBe(true)
      reportProbeStatus(DID, status)
      expect(getPrismHealth(DID).causes.has('catching-up')).toBe(false)
    }
  })

  it('a probe member never clears unavailable', async () => {
    fail(TIMELINE, await errorOf(xrpc(502, {error: 'UpstreamFailure'})))
    reportProbeStatus(DID, 'member')
    expect(getPrismHealth(DID).causes.has('unavailable')).toBe(true)
  })

  it('no overloaded cause exists', () => {
    const causes: string[] = ['catching-up', 'unavailable', 'degraded']
    fail(TIMELINE, new TypeError('Failed to fetch'))
    for (const cause of getPrismHealth(DID).causes) {
      expect(causes).toContain(cause)
    }
  })
})

describe('the throttle (2.2)', () => {
  it('the curve, floored by the body’s retryAfter; a 2xx resets it', async () => {
    fail(THREAD, await errorOf(xrpc(500, {error: 'Oops'})))
    // 1 s * 2^1 * 0.75 (random 0.5).
    expect(getPrismHealth(DID).retryAt - clock.now()).toBe(1_500)
    fail(THREAD, await errorOf(xrpc(500, {error: 'Oops'})))
    expect(getPrismHealth(DID).retryAt - clock.now()).toBe(3_000)
    fail(THREAD, await errorOf(xrpc(500, {error: 'Oops', retryAfter: 120})))
    expect(getPrismHealth(DID).retryAt - clock.now()).toBe(120_000)
    expect(getPrismHealth(DID).failures).toBe(3)
    answered(THREAD, 1)
    expect(getPrismHealth(DID).failures).toBe(0)
    expect(getPrismHealth(DID).retryAt).toBe(clock.now())
  })

  it('a hintless 503 Reindexing waits 30 s, not 5 s', async () => {
    fail(TIMELINE, await errorOf(xrpc(503, {error: 'Reindexing'})))
    expect(getPrismHealth(DID).retryAt - clock.now()).toBe(30_000)
  })

  it('caps the step at 5 minutes', async () => {
    fail(TIMELINE, await errorOf(xrpc(429, {error: 'X', retryAfter: 900})))
    expect(getPrismHealth(DID).retryAt - clock.now()).toBe(300_000)
  })
})

describe('single-flight (2.2)', () => {
  it('while unhealthy one call goes; a waiter with the lead’s request takes its success with no call; others go after it', async () => {
    const prism = heldPrism()
    fail(TIMELINE, await errorOf(REINDEXING))
    const lead = getPrivateTimeline(prism.client, {limit: 1})
    const same = getPrivateTimeline(prism.client, {limit: 1})
    const other = getPrivatePostThread(prism.client, {uri: ANCHOR})
    await settle()
    expect(prism.held).toHaveLength(1)
    prism.held[0].resolve(ok({feed: []}))
    await expect(lead).resolves.toEqual({feed: []})
    await expect(same).resolves.toEqual({feed: []})
    await settle()
    // The other waiter goes within the spread.
    expect(prism.held).toHaveLength(1)
    await clock.advance(500)
    expect(prism.held).toHaveLength(2)
    expect(prism.held[1].call.nsid).toBe(THREAD)
    prism.held[1].resolve(ok({thread: {}}))
    await other
  })

  it('a restart while its own attempt is the lead makes one call in all (BR13-N2)', async () => {
    const prism = heldPrism()
    fail(TIMELINE, await errorOf(REINDEXING))
    const first = getPrivateTimeline(prism.client, {})
    const restart = getPrivateTimeline(prism.client, {})
    await settle()
    prism.held[0].resolve(ok({feed: [], cursor: 'c'}))
    expect(await first).toEqual(await restart)
    await clock.advance(1_000)
    expect(prism.calls).toHaveLength(1)
  })

  it('a healthy account sends every call at once', async () => {
    const prism = heldPrism()
    void getPrivateTimeline(prism.client, {}).catch(() => {})
    void getPrivatePostThread(prism.client, {uri: ANCHOR}).catch(() => {})
    await settle()
    expect(prism.held).toHaveLength(2)
  })

  it('Reindexing rejects every waiter like a 502, each with its own error', async () => {
    for (const reply of [REINDEXING, xrpc(502, {error: 'UpstreamFailure'})]) {
      resetPrismHealth(clock.env)
      const prism = heldPrism()
      fail(TIMELINE, await errorOf(REINDEXING))
      const lead = getPrivateTimeline(prism.client, {}).catch(e => e)
      const a = getPrivatePostThread(prism.client, {uri: ANCHOR}).catch(e => e)
      const b = getPrivateTimeline(prism.client, {limit: 9}).catch(e => e)
      await settle()
      prism.held[0].resolve(reply)
      const [leadError, aError, bError] = await Promise.all([lead, a, b])
      expect(aError).toBeInstanceOf(PrivateWaiterError)
      expect(bError).toBeInstanceOf(PrivateWaiterError)
      expect(aError).not.toBe(bError)
      expect((aError as Error).cause).toBe(leadError)
      await clock.advance(1_000)
      expect(prism.calls).toHaveLength(1)
    }
  })

  it('a method-specific failure rejects waiters of that method; others go', async () => {
    const prism = heldPrism()
    // One method failed: a second method's failure would be account-wide.
    fail(THREAD, await errorOf(xrpc(500, {error: 'Oops'})))
    const lead = getPrivatePostThread(prism.client, {uri: ANCHOR}).catch(e => e)
    const sameMethod = getPrivatePostThread(prism.client, {
      uri: privateUri('3kother22222'),
    }).catch(e => e)
    const otherMethod = getPrivateTimeline(prism.client, {}).catch(e => e)
    await settle()
    prism.held[0].resolve(xrpc(500, {error: 'Oops'}))
    await lead
    expect(await sameMethod).toBeInstanceOf(PrivateWaiterError)
    await clock.advance(500)
    expect(prism.held).toHaveLength(2)
    expect(prism.held[1].call.nsid).toBe(TIMELINE)
    prism.held[1].resolve(ok({feed: []}))
    expect(await otherMethod).toEqual({feed: []})
  })

  it('a same-request waiter takes the lead’s named Unavailable and its NotFound, with no call (BR14-N1)', async () => {
    for (const reply of [
      xrpc(503, {error: 'Unavailable', retryAfter: 30}),
      xrpc(400, {error: 'NotFound'}),
    ]) {
      resetPrismHealth(clock.env)
      const prism = heldPrism()
      fail(TIMELINE, await errorOf(REINDEXING))
      const lead = getPrivatePostThread(prism.client, {uri: ANCHOR}).catch(
        e => e,
      )
      const restart = getPrivatePostThread(prism.client, {uri: ANCHOR}).catch(
        e => e,
      )
      await settle()
      prism.held[0].resolve(reply)
      const [leadError, waiterError] = await Promise.all([lead, restart])
      expect(waiterError).toBeInstanceOf(PrivateWaiterError)
      expect((waiterError as Error).cause).toBe(leadError)
      expect(isPrismUnavailable(waiterError)).toBe(
        (reply as {body: {error: string}}).body.error === 'Unavailable',
      )
      await clock.advance(1_000)
      expect(prism.calls).toHaveLength(1)
    }
  })

  it('a lead whose page is cancelled runs to its answer, and its waiters get it', async () => {
    const prism = heldPrism()
    fail(TIMELINE, await errorOf(REINDEXING))
    const page = new AbortController()
    const lead = reportedPrismCall(nearhorizon.privateGetTimeline, {
      params: {},
      signal: page.signal,
      send: signal =>
        prism.client.call(nearhorizon.privateGetTimeline, {}, {signal}),
    })
    const waiter = getPrivateTimeline(prism.client, {})
    await settle()
    page.abort()
    await settle()
    prism.held[0].resolve(ok({feed: []}))
    expect((await lead).body).toEqual({feed: []})
    expect(await waiter).toEqual({feed: []})
  })

  it('a waiter whose page gave up is dropped', async () => {
    const prism = heldPrism()
    fail(TIMELINE, await errorOf(REINDEXING))
    void getPrivateTimeline(prism.client, {}).catch(() => {})
    const page = new AbortController()
    const waiter = reportedPrismCall(nearhorizon.privateGetPostThread, {
      params: {uri: ANCHOR},
      signal: page.signal,
      send: signal =>
        prism.client.call(
          nearhorizon.privateGetPostThread,
          {uri: ANCHOR as never},
          {signal},
        ),
    }).catch((e: unknown) => e)
    await settle()
    page.abort()
    expect(((await waiter) as Error).name).toBe('AbortError')
    prism.held[0].resolve(ok({feed: []}))
    await clock.advance(1_000)
    expect(prism.calls).toHaveLength(1)
  })
})

describe('the call deadline (2.2)', () => {
  it('rejects with PrivateDeadlineError at 10 s, reports one method-specific failure, and drops the late answer', async () => {
    const prism = heldPrism()
    const read = getPrivatePostThread(prism.client, {uri: ANCHOR}).catch(
      e => e,
    )
    await clock.advance(CALL_DEADLINE_MS - 1)
    expect(getPrismHealth(DID).causes.size).toBe(0)
    await clock.advance(1)
    expect(await read).toBeInstanceOf(PrivateDeadlineError)
    expect(getPrismHealth(DID).causes).toEqual(new Set(['unavailable']))
    expect(getPrismHealth(DID).failedMethods).toEqual(new Set([THREAD]))
    expect(getPrismHealth(DID).failures).toBe(1)
    prism.held[0].resolve(ok({thread: {}}))
    await settle()
    expect(getPrismHealth(DID).failures).toBe(1)
  })

  it('writes go at once while throttled, with no deadline', async () => {
    const prism = heldPrism()
    fail(TIMELINE, await errorOf(REINDEXING))
    void getPrivateTimeline(prism.client, {}).catch(() => {})
    const write = updatePrivateSeen(prism.client, {
      seenAt: '2026-10-22T21:00:00.000Z',
    })
    await settle()
    expect(prism.held.map(h => h.call.nsid)).toEqual([
      TIMELINE,
      nearhorizon.privateUpdateSeen.nsid,
    ])
    await clock.advance(CALL_DEADLINE_MS * 3)
    prism.held[1].resolve(ok({}))
    await expect(write).resolves.toBeUndefined()
  })

  it('a write’s outcome is reported once: a 2xx clears unavailable but confirms nothing', async () => {
    const prism = fakeClient(DID, () => ok({}))
    fail(TIMELINE, await errorOf(xrpc(502, {error: 'UpstreamFailure'})))
    await reportedPrismWrite(nearhorizon.privateUpdateSeen, {
      send: () =>
        prism.client.call(nearhorizon.privateUpdateSeen, {
          seenAt: '2026-10-22T21:00:00.000Z',
        }),
    })
    expect(getPrismHealth(DID).causes.size).toBe(0)
    expect(isPrismConfirmed(DID)).toBe(false)
  })
})

describe('degraded (2.1)', () => {
  beforeEach(() => {
    answerPrismFeatures(DID, ['private', 'private.degraded'])
  })

  it('expires at retryAfter, else 30 s, and renews on a new one', async () => {
    answered(TIMELINE, 1, {degraded: true, retryAfterMs: 45_000})
    await clock.advance(44_000)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(true)
    answered(TIMELINE, 2, {degraded: true, retryAfterMs: 45_000})
    await clock.advance(44_000)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(true)
    await clock.advance(1_000)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(false)
    answered(TIMELINE, 3, {degraded: true})
    await clock.advance(DEGRADED_DEFAULT_MS - 1)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(true)
    await clock.advance(1)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(false)
  })

  it('is cleared only by a fresh answer sent after the latest degraded one', () => {
    answered(TIMELINE, 5, {degraded: true, retryAfterMs: 60_000})
    // Sent before the degraded one, arriving later: no clear.
    answered(TIMELINE, 4)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(true)
    // An unlisted method never clears.
    answered(nearhorizon.privateGetUnreadCount.nsid, 6)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(true)
    answered(TIMELINE, 6)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(false)
  })

  it('a degraded answer sent before the latest clearing one re-sets nothing; after expiry a fresh answer still sets clearedSeq', async () => {
    answered(TIMELINE, 3)
    answered(TIMELINE, 2, {degraded: true, retryAfterMs: 60_000})
    expect(getPrismHealth(DID).causes.size).toBe(0)
    answered(TIMELINE, 4, {degraded: true, retryAfterMs: 30_000})
    await clock.advance(30_000)
    expect(getPrismHealth(DID).causes.size).toBe(0)
    answered(TIMELINE, 7)
    answered(TIMELINE, 6, {degraded: true})
    expect(getPrismHealth(DID).causes.size).toBe(0)
  })

  it('without private.degraded, only expiry clears it', async () => {
    answerPrismFeatures(DID, ['private'])
    answered(TIMELINE, 1, {degraded: true, retryAfterMs: 30_000})
    answered(TIMELINE, 2)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(true)
    await clock.advance(30_000)
    expect(getPrismHealth(DID).causes.has('degraded')).toBe(false)
  })

  it('degraded alone does not throttle', async () => {
    const prism = heldPrism()
    answered(TIMELINE, 1, {degraded: true, retryAfterMs: 60_000})
    void getPrivateTimeline(prism.client, {}).catch(() => {})
    void getPrivatePostThread(prism.client, {uri: ANCHOR}).catch(() => {})
    await settle()
    expect(prism.held).toHaveLength(2)
  })
})

describe('confirmation and floorSince (2.1, BR11-L1, BR14-L1)', () => {
  it('false at launch until the first 2xx, false under an account-wide cause, true after the next 2xx', async () => {
    expect(isPrismConfirmed(DID)).toBe(false)
    expect(floorSince(DID)).toBe(START)
    answered(TIMELINE, 1)
    expect(isPrismConfirmed(DID)).toBe(true)
    expect(floorSince(DID)).toBe(undefined)
    await clock.advance(1_000)
    fail(TIMELINE, await errorOf(REINDEXING))
    expect(isPrismConfirmed(DID)).toBe(false)
    expect(floorSince(DID)).toBe(START + 1_000)
    // Cleared by the probe, but a 2xx must come after.
    answered(TIMELINE, 2)
    reportProbeStatus(DID, 'member')
    expect(isPrismConfirmed(DID)).toBe(false)
    answered(TIMELINE, 3)
    expect(isPrismConfirmed(DID)).toBe(true)
  })

  it('one getPostThread 500, or one deadline, sets unavailable but leaves the account confirmed (N9)', async () => {
    answered(TIMELINE, 1)
    fail(THREAD, await errorOf(xrpc(500, {error: 'Oops'})))
    expect(getPrismHealth(DID).causes.has('unavailable')).toBe(true)
    expect(isPrismConfirmed(DID)).toBe(true)
    fail(THREAD, new PrivateDeadlineError())
    expect(isPrismConfirmed(DID)).toBe(true)
    expect(floorSince(DID)).toBe(undefined)
  })

  it('deadlines on getTimeline then getPostThread unconfirm and make every waiter reject; a 2xx reconfirms and empties failedMethods', async () => {
    answered(TIMELINE, 1)
    fail(TIMELINE, new PrivateDeadlineError())
    expect(isPrismConfirmed(DID)).toBe(true)
    await clock.advance(1_000)
    fail(THREAD, new PrivateDeadlineError())
    expect(isPrismConfirmed(DID)).toBe(false)
    expect(getPrismHealth(DID).accountWide).toBe(true)
    expect(floorSince(DID)).toBe(START + 1_000)

    const prism = heldPrism()
    const lead = getPrivateTimeline(prism.client, {}).catch(e => e)
    const other = getPrivatePostThread(prism.client, {uri: ANCHOR}).catch(
      e => e,
    )
    await settle()
    prism.held[0].resolve(xrpc(500, {error: 'Oops'}))
    await lead
    expect(await other).toBeInstanceOf(PrivateWaiterError)

    answered(TIMELINE, 9)
    expect(isPrismConfirmed(DID)).toBe(true)
    expect(getPrismHealth(DID).failedMethods.size).toBe(0)
  })

  it('two deadlines on one method do not unconfirm', () => {
    answered(TIMELINE, 1)
    fail(THREAD, new PrivateDeadlineError())
    fail(THREAD, new PrivateDeadlineError())
    expect(isPrismConfirmed(DID)).toBe(true)
  })

  it('floorSince rises on each account-wide failure while unconfirmed, not on a method-specific one', async () => {
    answered(TIMELINE, 1)
    await clock.advance(1_000)
    answered(TIMELINE, 2, {degraded: true, retryAfterMs: 300_000})
    expect(floorSince(DID)).toBe(START + 1_000)
    await clock.advance(1_000)
    fail(TIMELINE, await errorOf(REINDEXING))
    expect(floorSince(DID)).toBe(START + 2_000)
    await clock.advance(1_000)
    fail(TIMELINE, await errorOf(xrpc(502, {error: 'UpstreamFailure'})))
    expect(floorSince(DID)).toBe(START + 3_000)
    await clock.advance(1_000)
    fail(TIMELINE, new TypeError('Failed to fetch'))
    expect(floorSince(DID)).toBe(START + 4_000)
    await clock.advance(1_000)
    // Account-wide now: a deadline raises it too.
    fail(THREAD, new PrivateDeadlineError())
    expect(floorSince(DID)).toBe(START + 5_000)
  })

  it('a method-specific failure while unconfirmed leaves the floor', async () => {
    answered(TIMELINE, 1)
    answered(TIMELINE, 2, {degraded: true, retryAfterMs: 300_000})
    const floor = floorSince(DID)
    await clock.advance(1_000)
    fail(THREAD, await errorOf(xrpc(500, {error: 'Oops'})))
    expect(floorSince(DID)).toBe(floor)
  })
})

describe('mergeAnswers (BR12-N3)', () => {
  const answer = (seq: number, extra: Partial<AnswerContext> = {}) => ({
    did: DID,
    method: nearhorizon.privateGetPosts.nsid,
    seq,
    degraded: false,
    retryAfterMs: undefined,
    unavailable: [],
    ...extra,
  })

  it('ORs degraded, unions unavailable, keeps the largest hint and the lowest seq, and seqOf gives each URI its answer’s', () => {
    const a = privateUri('3kaaaaaaaaaa') as AtUriString
    const b = privateUri('3kbbbbbbbbbb') as AtUriString
    const merged = mergeAnswers(
      [
        answer(4, {unavailable: [{uri: a, reason: 'syncing'}]}),
        answer(2, {
          degraded: true,
          retryAfterMs: 60_000,
          unavailable: [{uri: b, reason: 'indexing'}],
        }),
        answer(7, {retryAfterMs: 30_000}),
      ],
      [[a], [b], []],
    )
    expect(merged.degraded).toBe(true)
    expect(merged.unavailable.map(item => item.uri).sort()).toEqual(
      [a, b].sort(),
    )
    expect(merged.retryAfterMs).toBe(60_000)
    expect(merged.seq).toBe(2)
    expect(merged.seqOf(a)).toBe(4)
    expect(merged.seqOf(b)).toBe(2)
    expect(merged.seqOf(privateUri('3kccccccccccc'))).toBe(2)
  })
})

describe('the answer context', () => {
  it('a read returns its body with the answer’s signals and a seq taken at send', async () => {
    const own = privateUri('3kown2222222')
    const prism = fakeClient(DID, () =>
      ok({
        feed: [],
        degraded: true,
        retryAfter: 45,
        unavailable: [{uri: own, reason: 'syncing'}],
      }),
    )
    const first = await reportedPrismCall(nearhorizon.privateGetTimeline, {
      params: {},
      send: signal =>
        prism.client.call(nearhorizon.privateGetTimeline, {}, {signal}),
    })
    const second = await reportedPrismCall(nearhorizon.privateGetTimeline, {
      params: {},
      send: signal =>
        prism.client.call(nearhorizon.privateGetTimeline, {}, {signal}),
    })
    expect(first.answer).toMatchObject({
      did: DID,
      method: TIMELINE,
      degraded: true,
      retryAfterMs: 45_000,
      unavailable: [{uri: own, reason: 'syncing'}],
    })
    expect(second.answer.seq).toBeGreaterThan(first.answer.seq)
  })
})
