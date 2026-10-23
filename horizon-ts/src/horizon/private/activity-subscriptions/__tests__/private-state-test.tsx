import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * prism's state of the private pair (activity subscriptions design 2.2):
 * the whole-list read, the query and its gate, the selector with the overlay
 * of pending presses (T7-6), the pre-warm (T7-8) and FU-3's list read
 * (T7-11), against a fake prism.
 */

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')
jest.mock('#/components/Toast', () => ({show: () => {}}))
jest.mock('#/state/cache/profile-shadow', () => ({
  updateProfileShadow: () => {},
}))
jest.mock('#/state/queries/activity-subscriptions', () => ({
  RQKEY_getActivitySubscriptions: ['activity-subscriptions'],
}))

let mockSource: unknown
jest.mock('#/horizon/private/membership', () => ({
  usePrivateFeedSource: () => mockSource,
}))
let mockShown = true
jest.mock('#/horizon/private/activity-subscriptions/hooks', () => ({
  useActivitySubscriptionsShown: () => mockShown,
}))
const mockSaversRef: {current: unknown} = {current: undefined}
jest.mock('#/horizon/private/activity-subscriptions/saver', () => ({
  ...jest.requireActual<object>(
    '#/horizon/private/activity-subscriptions/saver',
  ),
  getActivitySavers: () => mockSaversRef.current,
}))

import {QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook} from '@testing-library/react-native'

import {getPrismHealth} from '#/horizon/routing/health'
import {getMembership, resetMembership} from '#/horizon/routing/membership'
import {membershipStorageKey} from '#/horizon/routing/membership-record'
import {writeLocal} from '#/horizon/session/local-store'
import {type Flags, OFF} from '../common'
import {
  privateActivitySubscriptionsKey,
  type PrivateFlagsMap,
  readAllPrismSubscriptions,
  readCachedPrivateFlags,
  setPrivateFlags,
  usePrivateActivityPrefetch,
  usePrivateFlags,
} from '../private-state'
import {savePress} from '../saver'
import {
  BOTH,
  DID,
  type Harness,
  harness,
  ON,
  settle,
  SUBJECT,
  SUBJECT_2,
  xrpcError,
} from './harness'

const LIST = privateActivitySubscriptionsKey(DID)
const PUT = 'app.nearhorizon.private.putActivitySubscription'

let h: Harness

beforeEach(() => {
  h = harness()
  mockSaversRef.current = h.savers
  mockSource = {did: DID, prism: h.prism.client, appview: h.bluesky.client}
  mockShown = true
})

function wrapper({children}: {children: React.ReactNode}) {
  return (
    <QueryClientProvider client={h.queryClient}>{children}</QueryClientProvider>
  )
}

function pressPrivate(flags: Flags, before: Flags) {
  savePress(h.savers, {
    ctx: h.ctx(),
    before: {public: OFF, private: before},
    after: {public: OFF, private: flags},
  })
}

describe('T7-6: prism’s list', () => {
  it('is read to its end, 100 a page', async () => {
    for (let i = 0; i < 250; i++) {
      h.prism.rows.set(`did:plc:row${String(i).padStart(21, '0')}`, ON)
    }
    h.prism.rows.set(SUBJECT, BOTH)
    const map = await readAllPrismSubscriptions(h.prism.client)
    expect(h.prism.lists()).toHaveLength(3)
    expect(h.prism.lists().map(c => c.params.get('limit'))).toEqual([
      '100',
      '100',
      '100',
    ])
    expect(Object.keys(map)).toHaveLength(251)
    expect(map[SUBJECT]).toEqual(BOTH)
  })

  it('stops at 30 pages', async () => {
    for (let i = 0; i < 3_050; i++) {
      h.prism.rows.set(`did:plc:row${String(i).padStart(21, '0')}`, ON)
    }
    const map = await readAllPrismSubscriptions(h.prism.client)
    expect(h.prism.lists()).toHaveLength(30)
    expect(Object.keys(map)).toHaveLength(3_000)
  })

  it('throws if any page fails', async () => {
    h.prism.state.listReply = xrpcError(500, 'InternalServerError')
    await expect(readAllPrismSubscriptions(h.prism.client)).rejects.toThrow()
  })

  it('loads per account, off for an absent subject, and is not read without the gate or membership', async () => {
    h.prism.rows.set(SUBJECT, ON)
    const {result} = renderHook(() => usePrivateFlags(SUBJECT_2), {wrapper})
    expect(result.current).toEqual({flags: OFF, loaded: false})
    await act(() => settle())
    expect(result.current).toEqual({flags: OFF, loaded: true})
    expect(h.queryClient.getQueryData(LIST)).toEqual({[SUBJECT]: ON})

    for (const [source, shown] of [
      [undefined, true],
      [mockSource, false],
    ] as const) {
      h = harness()
      mockSaversRef.current = h.savers
      mockSource = source
      mockShown = shown
      renderHook(() => usePrivateFlags(SUBJECT), {wrapper})
      await act(() => settle())
      expect(h.prism.lists()).toHaveLength(0)
    }
  })

  it('reads off whenever the query is disabled, even with cached data (a demoted member)', () => {
    h.queryClient.setQueryData(LIST, {[SUBJECT]: ON})
    const {result, rerender} = renderHook(() => usePrivateFlags(SUBJECT), {
      wrapper,
    })
    expect(result.current.flags).toEqual(ON)
    mockSource = undefined
    rerender({})
    expect(result.current).toEqual({flags: OFF, loaded: false})
  })

  it('setPrivateFlags updates the map; a list not loaded stays unloaded', () => {
    setPrivateFlags(h.queryClient, DID, SUBJECT, ON)
    expect(h.queryClient.getQueryData(LIST)).toBeUndefined()
    h.queryClient.setQueryData(LIST, {[SUBJECT_2]: BOTH})
    setPrivateFlags(h.queryClient, DID, SUBJECT, ON)
    expect(h.queryClient.getQueryData(LIST)).toEqual({
      [SUBJECT_2]: BOTH,
      [SUBJECT]: ON,
    })
    setPrivateFlags(h.queryClient, DID, SUBJECT_2, OFF)
    expect(h.queryClient.getQueryData(LIST)).toEqual({[SUBJECT]: ON})
    expect(readCachedPrivateFlags(h.queryClient, DID, SUBJECT_2)).toEqual(OFF)
  })

  it('the overlay: the saver’s pending press while not idle; a fetch with the old value cannot undo it', async () => {
    h.queryClient.setQueryData(LIST, {})
    const {result} = renderHook(() => usePrivateFlags(SUBJECT), {wrapper})
    h.prism.state.putReply = 'hang'
    act(() => pressPrivate(ON, OFF))
    expect(result.current.flags).toEqual(ON)
    // A background refetch lands with prism's old value.
    await act(async () => {
      await h.queryClient.invalidateQueries({queryKey: LIST})
      await settle()
    })
    expect(h.prism.lists()).toHaveLength(1)
    expect(h.queryClient.getQueryData<PrivateFlagsMap>(LIST)).toEqual({})
    expect(result.current.flags).toEqual(ON)
    // A refusal unlights it through the saver alone: the cache holds off already.
    const before = h.queryClient.getQueryState(LIST)?.dataUpdatedAt
    await act(async () => {
      h.prism.heldOf(PUT)[0].resolve(xrpcError(400, 'InvalidRequest'))
      await settle()
    })
    expect(h.queryClient.getQueryState(LIST)?.dataUpdatedAt).toBe(before)
    expect(result.current.flags).toEqual(OFF)
  })

  it('getSnapshot is stable, and a settle renders idle and the new value together', async () => {
    h.queryClient.setQueryData(LIST, {})
    const seen: Flags[] = []
    renderHook(
      () => {
        const value = usePrivateFlags(SUBJECT)
        seen.push(value.flags)
        return value
      },
      {wrapper},
    )
    h.prism.state.putReply = 'hang'
    act(() => pressPrivate(ON, OFF))
    expect(h.savers.prism.pending(DID, SUBJECT)).toBe(
      h.savers.prism.pending(DID, SUBJECT),
    )
    const pressedAt = seen.length
    await act(async () => {
      h.prism.heldOf(PUT)[0].resolve({status: 200})
      await settle()
    })
    expect(h.savers.prism.status(DID, SUBJECT)?.idle).toBe(true)
    expect(readCachedPrivateFlags(h.queryClient, DID, SUBJECT)).toEqual(ON)
    // No frame of the old value after the press.
    expect(seen.slice(pressedAt - 1)).not.toContainEqual(OFF)
    expect(seen.at(-1)).toEqual(ON)
  })
})

describe('T7-8: the pre-warm', () => {
  it('prefetches the list for a member with the feature, once', async () => {
    const {rerender} = renderHook(() => usePrivateActivityPrefetch(), {
      wrapper,
    })
    await act(() => settle())
    rerender({})
    await act(() => settle())
    expect(h.prism.lists()).toHaveLength(1)
    expect(h.queryClient.getQueryData(LIST)).toEqual({})
  })

  it('not for a non-member, nor without the feature', async () => {
    mockSource = undefined
    renderHook(() => usePrivateActivityPrefetch(), {wrapper})
    await act(() => settle())
    mockSource = {did: DID, prism: h.prism.client, appview: h.bluesky.client}
    mockShown = false
    renderHook(() => usePrivateActivityPrefetch(), {wrapper})
    await act(() => settle())
    expect(h.prism.lists()).toHaveLength(0)
  })
})

describe('T7-11: FU-3, the list read', () => {
  it('a Reindexing read sets catching-up, leaves the toggles disabled and the account a member', async () => {
    writeLocal(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private']}),
    )
    resetMembership()
    try {
      h.prism.state.listReply = {
        status: 503,
        body: {error: 'Reindexing', message: 'Reindexing', retryAfter: 30},
      }
      const {result} = renderHook(() => usePrivateFlags(SUBJECT), {wrapper})
      await act(() => settle())
      expect(result.current).toEqual({flags: OFF, loaded: false})
      expect(getPrismHealth(DID).causes.has('catching-up')).toBe(true)
      expect(getMembership(DID)).toBe('member')
    } finally {
      writeLocal(membershipStorageKey(DID), undefined)
      resetMembership()
    }
  })
})
