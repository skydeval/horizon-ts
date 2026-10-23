import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  REFRACT: true,
}))
let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => mockMembership,
  subscribeMembership: () => () => {},
  isPrivateMember: () => mockMembership === 'member',
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

import {RefractClearedError} from '#/horizon/refract/api'
import {
  askFill,
  FILL_COLD_DID_CAP,
  markStockFailed,
  refractDidState,
  splitFill,
} from '#/horizon/refract/fill'
import {
  RF_DID,
  RF_DID_2,
  RF_STOCK_DID,
  rfFillAnswer,
  rfPost,
  rfProfile,
  rfUri,
} from '#/horizon/refract/fixtures'
import {isNotedRestored, noteRestored} from '#/horizon/refract/marker'
import {peekRestoredPost} from '#/horizon/refract/store'
import {publishCurrentClients} from '#/horizon/routing/current-clients'
import {asked, deferred, type Harness, setupRefract} from './harness'

/*
 * 11.1 "batcher" and "skips" (refract client design 5.1, 5.3).
 */

let h: Harness

beforeEach(() => {
  jest.useFakeTimers()
  mockMembership = 'member'
  h = setupRefract()
})

afterEach(() => {
  jest.useRealTimers()
})

async function settle(ms = 50) {
  await jest.advanceTimersByTimeAsync(ms)
}

describe('batching', () => {
  it('adds every URI’s author to dids and drops invalid ids', async () => {
    markStockFailed(RF_DID)
    const run = askFill(
      {
        uris: [
          rfUri('rf1'),
          'at://someone.example.test/app.bsky.feed.post/x',
          'at://did:plc:abc/app.bsky.graph.follow/x',
        ],
        dids: ['not-a-did'],
      },
      {kind: 'slot', foreground: true},
    )
    await settle()
    await run
    expect(h.fills()).toHaveLength(1)
    expect(asked(h.fills()[0])).toEqual({dids: [RF_DID], uris: [rfUri('rf1')]})
  })

  it('splits at 25 URIs, 25 DIDs and the cold-DID cap', () => {
    const cold = Array.from(
      {length: FILL_COLD_DID_CAP * 2 + 4},
      (_, i) => `did:plc:cold${i}`,
    )
    const chunks = splitFill(cold, [], () => true)
    expect(chunks.map(chunk => chunk.dids.length)).toEqual([
      FILL_COLD_DID_CAP,
      FILL_COLD_DID_CAP,
      4,
    ])
    expect(FILL_COLD_DID_CAP).toBe(25)
    const warm = Array.from({length: 30}, (_, i) => `did:plc:warm${i}`)
    expect(splitFill(warm, [], () => false).map(c => c.dids.length)).toEqual([
      25, 5,
    ])
    const uris = Array.from({length: 30}, (_, i) => rfUri(`p${i}`))
    const byUri = splitFill([RF_DID], uris, () => false)
    expect(byUri.every(chunk => chunk.uris.length <= 25)).toBe(true)
    expect(byUri.every(chunk => chunk.dids.includes(RF_DID))).toBe(true)
  })

  it('merges asks in the same frame into one call', async () => {
    markStockFailed(RF_DID)
    markStockFailed(RF_DID_2)
    const a = askFill({dids: [RF_DID]}, {kind: 'profile', foreground: true})
    const b = askFill({dids: [RF_DID_2]}, {kind: 'profile', foreground: true})
    await settle()
    await Promise.all([a, b])
    expect(h.fills()).toHaveLength(1)
    expect(asked(h.fills()[0]).dids.sort()).toEqual([RF_DID, RF_DID_2].sort())
  })

  it('a foreground ask joins a waiting background batch and sends it at once', async () => {
    markStockFailed(RF_DID)
    markStockFailed(RF_DID_2)
    // Use up the pacer so the background batch has to wait for its slot.
    const first = askFill({dids: [RF_DID]}, {kind: 'slot', foreground: false})
    await settle(20)
    expect(h.fills()).toHaveLength(1)
    await first
    const waiting = askFill(
      {dids: [RF_DID_2]},
      {kind: 'slot', foreground: false},
    )
    await settle(20)
    expect(h.fills()).toHaveLength(1)
    const fore = askFill(
      {dids: [RF_DID_2]},
      {kind: 'profile', foreground: true},
    )
    await settle(20)
    expect(h.fills()).toHaveLength(2)
    await Promise.all([waiting, fore])
  })

  it('drops an ask whose callers all unmounted', async () => {
    markStockFailed(RF_DID)
    const run = askFill(
      {dids: [RF_DID]},
      {kind: 'slot', foreground: true, live: () => false},
    )
    await settle()
    await run
    expect(h.fills()).toHaveLength(0)
  })
})

describe('answers', () => {
  it('a deleted post doesn’t mark its author; status comes from profiles only', async () => {
    markStockFailed(RF_DID)
    h.respond(() =>
      rfFillAnswer({withheld: [{id: RF_DID, reason: 'unavailable'}]}),
    )
    const run = askFill(
      {uris: [rfUri('gone')]},
      {kind: 'slot', foreground: true},
    )
    await settle()
    await run
    expect(isNotedRestored(RF_DID)).toBe(false)
    h.respond(() => rfFillAnswer({profiles: [rfProfile()], withheld: []}))
    const again = askFill({dids: [RF_DID]}, {kind: 'profile', foreground: true})
    await settle()
    await again
    expect(isNotedRestored(RF_DID)).toBe(true)
  })

  it('positive posts land in the store and the post query', async () => {
    markStockFailed(RF_DID)
    h.respond(() =>
      rfFillAnswer({
        profiles: [rfProfile()],
        posts: [rfPost('rf1')],
        withheld: [],
      }),
    )
    const run = askFill(
      {uris: [rfUri('rf1')]},
      {kind: 'slot', foreground: true},
    )
    await settle()
    const outcome = await run
    const stored = peekRestoredPost(rfUri('rf1'))
    expect(stored).toBeDefined()
    expect(outcome.uris.get(rfUri('rf1'))).toEqual({
      kind: 'positive',
      post: stored,
    })
    expect(h.queryClient.getQueryData(['post', rfUri('rf1')])).toBe(stored)
    expect(h.queryClient.getQueryData(['profile', RF_DID])).toBeDefined()
  })

  it('pending then an omission gets one confirming re-ask, and only the second is final', async () => {
    markStockFailed(RF_DID)
    h.respond(() => rfFillAnswer({pending: [RF_DID], withheld: []}))
    const first = askFill({dids: [RF_DID]}, {kind: 'profile', foreground: true})
    await settle()
    expect((await first).dids.get(RF_DID)?.kind).toBe('pending')
    h.respond(() => rfFillAnswer({withheld: []}))
    const second = askFill(
      {dids: [RF_DID]},
      {kind: 'profile', foreground: true},
    )
    await settle()
    expect((await second).dids.get(RF_DID)?.kind).toBe('not-restored')
    // The first ask, the omission and its confirming re-ask.
    expect(h.fills()).toHaveLength(3)
  })

  it('the confirming re-ask can bring the profile instead', async () => {
    noteRestored(RF_DID)
    let n = 0
    h.respond(() =>
      ++n === 1
        ? rfFillAnswer({withheld: []})
        : rfFillAnswer({profiles: [rfProfile()], withheld: []}),
    )
    const run = askFill({dids: [RF_DID]}, {kind: 'profile', foreground: true})
    await settle()
    expect((await run).dids.get(RF_DID)?.kind).toBe('positive')
    expect(isNotedRestored(RF_DID)).toBe(true)
  })
})

describe('skips', () => {
  it('the stock pre-check prevents the call and gives "Deleted" for its URIs', async () => {
    h.stockProfiles.add(RF_STOCK_DID)
    const run = askFill(
      {uris: [rfUri('x', RF_STOCK_DID)]},
      {kind: 'slot', foreground: false},
    )
    await settle()
    const outcome = await run
    expect(h.precheckCalls).toEqual([[RF_STOCK_DID]])
    expect(h.fills()).toHaveLength(0)
    expect(outcome.uris.get(rfUri('x', RF_STOCK_DID))?.kind).toBe('gone')
  })

  it('no pre-check after a failed stock getProfile, or for a noted DID', async () => {
    markStockFailed(RF_DID)
    noteRestored(RF_DID_2)
    const run = askFill(
      {dids: [RF_DID, RF_DID_2]},
      {kind: 'profile', foreground: true},
    )
    await settle()
    await run
    expect(h.precheckCalls).toHaveLength(0)
  })

  it('"not restored" is cached for 10 minutes', async () => {
    markStockFailed(RF_DID)
    h.respond(() => rfFillAnswer({withheld: []}))
    const run = askFill({dids: [RF_DID]}, {kind: 'profile', foreground: true})
    await settle()
    await run
    const again = askFill({dids: [RF_DID]}, {kind: 'profile', foreground: true})
    await settle()
    expect((await again).dids.get(RF_DID)?.kind).toBe('not-restored')
    expect(h.fills()).toHaveLength(1)
    expect(refractDidState(RF_DID)?.kind).toBe('not-restored')
  })
})

describe('clearing', () => {
  it('an account switch rejects the waiting caller and the late answer writes nothing', async () => {
    markStockFailed(RF_DID)
    const answer = deferred<unknown>()
    h.respond(() => answer.promise)
    const run = askFill({dids: [RF_DID]}, {kind: 'profile', foreground: true})
    const rejected = expect(run).rejects.toBeInstanceOf(RefractClearedError)
    await settle()
    publishCurrentClients({
      did: 'did:plc:rfxreader000000000000000002',
      handle: 'other.example.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: {} as never,
      queryClient: h.queryClient,
    })
    answer.resolve(rfFillAnswer({profiles: [rfProfile()], withheld: []}))
    await settle()
    await rejected
    expect(isNotedRestored(RF_DID)).toBe(false)
    expect(h.queryClient.getQueryData(['profile', RF_DID])).toBeUndefined()
  })
})
