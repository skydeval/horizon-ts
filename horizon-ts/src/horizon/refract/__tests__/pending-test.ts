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

import {
  askSlot,
  markStockFailed,
  refractRetry,
  resolveForWrite,
  type ScheduleResult,
  waitOnSchedule,
} from '#/horizon/refract/fill'
import {
  RF_DID,
  rfFillAnswer,
  rfPost,
  rfProfile,
  rfUri,
} from '#/horizon/refract/fixtures'
import {deferred, type Harness, setupRefract} from './harness'

/*
 * 11.1 "pending" (refract client design 5.4).
 */

let h: Harness
let start = 0

beforeEach(() => {
  jest.useFakeTimers()
  h = setupRefract()
  markStockFailed(RF_DID)
  start = Date.now()
})

afterEach(() => {
  jest.useRealTimers()
})

const pending = () => rfFillAnswer({pending: [RF_DID], withheld: []})
const profile = () => rfFillAnswer({profiles: [rfProfile()], withheld: []})

/** Each fill's send time, from the test's start. */
function track() {
  const times: number[] = []
  return {
    times,
    note: () => times.push(Date.now() - start),
  }
}

function settled(promise: Promise<ScheduleResult>) {
  let result: ScheduleResult | undefined
  void promise.then(
    value => {
      result = value
    },
    () => {},
  )
  return () => result
}

describe('the profile schedule', () => {
  it('holds through re-asks at t0 + 2, 5 and 10 s, then ends with pending', async () => {
    const sends = track()
    h.respond(() => {
      sends.note()
      return pending()
    })
    const live = {mounted: true}
    const result = settled(
      waitOnSchedule(RF_DID, {
        kind: 'profile',
        live: () => live.mounted,
        late: {live: () => live.mounted, onAnswer: () => {}},
      }),
    )
    await jest.advanceTimersByTimeAsync(9_000)
    expect(result()).toBeUndefined()
    await jest.advanceTimersByTimeAsync(2_000)
    expect(result()).toEqual({kind: 'unavailable', reason: 'pending'})
    // First ask at the frame, then offsets from the first answer.
    expect(sends.times.length).toBe(4)
    expect(sends.times[1] - sends.times[0]).toBeGreaterThanOrEqual(1_990)
    expect(sends.times[2] - sends.times[0]).toBeGreaterThanOrEqual(4_990)
    expect(sends.times[3] - sends.times[0]).toBeGreaterThanOrEqual(9_990)
    // 30 and 60 s while mounted; nothing once unmounted.
    await jest.advanceTimersByTimeAsync(21_000)
    expect(sends.times.length).toBe(5)
    live.mounted = false
    await jest.advanceTimersByTimeAsync(40_000)
    expect(sends.times.length).toBe(5)
  })

  it('a profile at a re-ask ends the hold with it', async () => {
    let n = 0
    h.respond(() => (++n < 3 ? pending() : profile()))
    const result = settled(waitOnSchedule(RF_DID, {kind: 'profile'}))
    await jest.advanceTimersByTimeAsync(6_000)
    expect(result()?.kind).toBe('positive')
  })

  it('ends at the cap, t0 + 12 s, when every answer takes 9 s', async () => {
    h.respond(async () => {
      await new Promise(resolve => setTimeout(resolve, 9_000))
      return pending()
    })
    const result = settled(waitOnSchedule(RF_DID, {kind: 'profile'}))
    // t0 is the first answer, about 9 s in.
    await jest.advanceTimersByTimeAsync(9_100 + 11_800)
    expect(result()).toBeUndefined()
    await jest.advanceTimersByTimeAsync(400)
    expect(result()).toEqual({kind: 'unavailable', reason: 'pending'})
    // Never two calls in flight: each re-ask goes after the previous answer.
    expect(h.fills().length).toBeLessThanOrEqual(3)
  })

  it('unavailable holds through one re-ask only', async () => {
    h.respond(() =>
      rfFillAnswer({withheld: [{id: RF_DID, reason: 'unavailable'}]}),
    )
    const result = settled(waitOnSchedule(RF_DID, {kind: 'profile'}))
    await jest.advanceTimersByTimeAsync(1_500)
    expect(result()).toBeUndefined()
    await jest.advanceTimersByTimeAsync(1_000)
    expect(result()).toEqual({kind: 'unavailable', reason: 'unconfirmed'})
  })

  it('a failed first call is transient', async () => {
    h.respond(() => {
      throw new TypeError('network down')
    })
    const result = settled(waitOnSchedule(RF_DID, {kind: 'profile'}))
    await jest.advanceTimersByTimeAsync(100)
    expect(result()?.kind).toBe('unavailable')
    expect((result() as {reason: string}).reason).toBe('transient')
  })

  it('a focus run during the 30 s wait joins and sends no extra call', async () => {
    h.respond(() => pending())
    void waitOnSchedule(RF_DID, {kind: 'profile'}).catch(() => {})
    await jest.advanceTimersByTimeAsync(15_000)
    const calls = h.fills().length
    const joined = settled(waitOnSchedule(RF_DID, {kind: 'profile'}))
    await jest.advanceTimersByTimeAsync(1_000)
    expect(h.fills().length).toBe(calls)
    await jest.advanceTimersByTimeAsync(15_000)
    expect(joined()).toEqual({kind: 'unavailable', reason: 'pending'})
    expect(h.fills().length).toBe(calls + 1)
  })

  it('Retry while a call is in flight sends no second call and holds anew', async () => {
    const slow = deferred<unknown>()
    let n = 0
    h.respond(() =>
      ++n === 1 ? pending() : n === 2 ? slow.promise : pending(),
    )
    void waitOnSchedule(RF_DID, {kind: 'profile'}).catch(() => {})
    await jest.advanceTimersByTimeAsync(2_100)
    expect(h.fills().length).toBe(2)
    const waiting = settled(waitOnSchedule(RF_DID, {kind: 'profile'}))
    refractRetry(RF_DID)
    await jest.advanceTimersByTimeAsync(100)
    expect(h.fills().length).toBe(2)
    slow.resolve(pending())
    // The adopted answer is the new t0; the moved wait holds through 10 s.
    await jest.advanceTimersByTimeAsync(5_000)
    expect(waiting()).toBeUndefined()
    await jest.advanceTimersByTimeAsync(6_000)
    expect(waiting()).toEqual({kind: 'unavailable', reason: 'pending'})
  })
})

describe('write fallbacks', () => {
  it('re-ask at 2 and 5 s inside 10 s, each its own call', async () => {
    const sends = track()
    h.respond(() => {
      sends.note()
      return pending()
    })
    let result: unknown
    void resolveForWrite(rfUri('rf1')).then(value => {
      result = value
    })
    await jest.advanceTimersByTimeAsync(10_000)
    expect(result).toEqual({kind: 'not-now'})
    expect(sends.times.length).toBe(3)
    expect(sends.times[2] - sends.times[0]).toBeGreaterThanOrEqual(4_990)
  })

  it('send their own call while a slow schedule call is in flight', async () => {
    const slow = deferred<unknown>()
    let n = 0
    h.respond(() =>
      ++n === 1
        ? slow.promise
        : rfFillAnswer({
            profiles: [rfProfile()],
            posts: [rfPost('rf1')],
            withheld: [],
          }),
    )
    void waitOnSchedule(RF_DID, {kind: 'profile'}).catch(() => {})
    await jest.advanceTimersByTimeAsync(100)
    let result: {kind: string} | undefined
    void resolveForWrite(rfUri('rf1')).then(value => {
      result = value
    })
    await jest.advanceTimersByTimeAsync(100)
    expect(result?.kind).toBe('positive')
    slow.resolve(pending())
  })
})

describe('slots', () => {
  it('make no call of their own for a pending author and ride along at most twice', async () => {
    h.respond(() => pending())
    void askSlot(rfUri('rf1'), {foreground: false, live: () => true}).catch(
      () => {},
    )
    await jest.advanceTimersByTimeAsync(500)
    expect(h.fills().length).toBe(1)
    await jest.advanceTimersByTimeAsync(20_000)
    expect(h.fills().length).toBe(1)
  })
})
