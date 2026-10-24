import {beforeEach, describe, expect, it, jest} from '@jest/globals'

const mockLocal = new Map<string, string>()
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: (key: string) => mockLocal.get(key),
  writeLocal: (key: string, value: string | undefined) => {
    if (value === undefined) mockLocal.delete(key)
    else mockLocal.set(key, value)
  },
  subscribeLocal: () => () => {},
}))

import {THREAD_LENS} from '#/horizon/switches'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '../current-clients'
import {
  answerPrismFeatures,
  featuresAnswered,
  loadPrismFeatures,
  resetPrismFeatures,
  servesFeature,
  servesFeatureForWrite,
  subscribePrismFeatures,
} from '../features'
import {getMembership, isPrivateMember, resetMembership} from '../membership'
import {membershipStorageKey} from '../membership-record'

const DID = 'did:plc:featuresaaaaaaaaaaaaaaaa'
const OTHER = 'did:plc:featuresotheraaaaaaaaaa'

const invalidateQueries = jest.fn(() => Promise.resolve())

function publish(did: string) {
  publishCurrentClients({
    did,
    handle: 'alice.test',
    pdsUrl: undefined,
    pdsClient: {},
    prismClient: {},
    appviewClient: {},
    queryClient: {invalidateQueries},
  } as unknown as CurrentClients)
}

beforeEach(() => {
  resetPrismFeatures()
  resetMembership()
  mockLocal.clear()
  invalidateQueries.mockClear()
  clearCurrentClients()
})

describe('servesFeature', () => {
  it('reads a list', () => {
    answerPrismFeatures(DID, ['private', 'private.gates'])
    expect(servesFeature('private', DID)).toBe(true)
    expect(servesFeature('private.gates', DID)).toBe(true)
    expect(servesFeature('private.search', DID)).toBe(false)
  })

  it('serves only private for a legacy prism (null) or nothing held', () => {
    answerPrismFeatures(DID, null)
    expect(servesFeature('private', DID)).toBe(true)
    expect(servesFeature('private.embeds', DID)).toBe(false)
    expect(servesFeature('private', OTHER)).toBe(true)
    expect(servesFeature('private.embeds', OTHER)).toBe(false)
  })

  it('an answered empty list serves nothing', () => {
    answerPrismFeatures(DID, [])
    expect(servesFeature('private', DID)).toBe(false)
  })

  it('is false without a DID, and defaults to the published account', () => {
    expect(servesFeature('private')).toBe(false)
    answerPrismFeatures(DID, ['private.bookmarks'])
    publish(DID)
    expect(servesFeature('private.bookmarks')).toBe(true)
  })

  it('ignores names it does not know', () => {
    answerPrismFeatures(DID, ['private', 'private.someday'])
    expect(servesFeature('private', DID)).toBe(true)
  })
})

describe('answers and loads', () => {
  it('a change notifies and invalidates every query once (one split pass) for the current account', () => {
    publish(DID)
    const listener = jest.fn()
    const unsubscribe = subscribePrismFeatures(listener)
    answerPrismFeatures(DID, ['private'])
    expect(listener).toHaveBeenCalledTimes(1)
    /*
     * With Thread Lens on, one pass is split in two (Phase 4 design 11.6):
     * every non-lens query is invalidated, and lens entries are only marked
     * stale.
     */
    const calls = THREAD_LENS ? 2 : 1
    expect(invalidateQueries).toHaveBeenCalledTimes(calls)
    if (THREAD_LENS) {
      const [rest, lens] = invalidateQueries.mock.calls as unknown as [
        [{predicate: (query: {queryKey: unknown[]}) => boolean}],
        [unknown],
      ]
      expect(rest[0].predicate({queryKey: ['horizon-thread-lens']})).toBe(false)
      expect(rest[0].predicate({queryKey: ['post-thread']})).toBe(true)
      expect(lens[0]).toEqual({
        queryKey: ['horizon-thread-lens'],
        refetchType: 'none',
      })
    } else {
      expect(invalidateQueries).toHaveBeenCalledWith()
    }
    answerPrismFeatures(DID, ['private'])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(invalidateQueries).toHaveBeenCalledTimes(calls)
    unsubscribe()
  })

  it('the same set in another order is no change', () => {
    publish(DID)
    answerPrismFeatures(DID, ['private', 'private.gates'])
    invalidateQueries.mockClear()
    answerPrismFeatures(DID, ['private.gates', 'private', 'private'])
    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  it('another account change invalidates nothing', () => {
    publish(DID)
    answerPrismFeatures(OTHER, ['private'])
    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  it('a first answer equal to the loaded list notifies once (answered) and invalidates nothing', () => {
    publish(DID)
    loadPrismFeatures(DID, ['private'])
    const listener = jest.fn()
    const unsubscribe = subscribePrismFeatures(listener)
    answerPrismFeatures(DID, ['private'])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(invalidateQueries).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('loading never notifies, invalidates or answers', () => {
    publish(DID)
    const listener = jest.fn()
    const unsubscribe = subscribePrismFeatures(listener)
    loadPrismFeatures(DID, ['private', 'private.bookmarks'])
    expect(listener).not.toHaveBeenCalled()
    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(servesFeature('private.bookmarks', DID)).toBe(true)
    expect(featuresAnswered(DID)).toBe(false)
    unsubscribe()
  })

  it("writes wait for this run's answer", () => {
    loadPrismFeatures(DID, ['private', 'private.bookmarks'])
    expect(servesFeatureForWrite('private.bookmarks', DID)).toBe(false)
    answerPrismFeatures(DID, ['private', 'private.bookmarks'])
    expect(servesFeatureForWrite('private.bookmarks', DID)).toBe(true)
    expect(servesFeatureForWrite('private.search', DID)).toBe(false)
  })

  it('the first read of a DID loads its device record, silently', () => {
    mockLocal.set(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private.gates']}),
    )
    const listener = jest.fn()
    const unsubscribe = subscribePrismFeatures(listener)
    expect(servesFeature('private.gates', DID)).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("getMembership's first load fills the features silently", () => {
    mockLocal.set(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private.search']}),
    )
    const listener = jest.fn()
    const unsubscribe = subscribePrismFeatures(listener)
    expect(getMembership(DID)).toBe('member')
    expect(listener).not.toHaveBeenCalled()
    expect(servesFeature('private.search', DID)).toBe(true)
    unsubscribe()
  })
})

describe('isPrivateMember', () => {
  it('needs member and the private family', () => {
    mockLocal.set(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private']}),
    )
    expect(isPrivateMember(DID)).toBe(true)
    answerPrismFeatures(DID, ['private.gates'])
    expect(isPrivateMember(DID)).toBe(false)
    answerPrismFeatures(DID, null)
    expect(isPrivateMember(DID)).toBe(true)
    expect(isPrivateMember(OTHER)).toBe(false)
    expect(isPrivateMember(undefined)).toBe(false)
  })

  it('a round 3 plain record keeps the Phase 2 behaviour', () => {
    mockLocal.set(membershipStorageKey(DID), 'member')
    expect(isPrivateMember(DID)).toBe(true)
    expect(servesFeature('private.embeds', DID)).toBe(false)
  })
})
