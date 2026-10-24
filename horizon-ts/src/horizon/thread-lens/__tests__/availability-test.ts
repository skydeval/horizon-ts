import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

/*
 * Who gets Thread Lens and when a screen uses it (Phase 4 design 3.2, 4.2,
 * 5.1; test 13 "Availability", "Preference" and the lens gap mark): the
 * feature list's verdict, refusals and the `NotReady` lift, the device value
 * and its per-account default, the active and lens-only rules, and the mark.
 */

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))

type State = 'unknown' | 'indexing' | 'member' | 'not-member'
const mockStates = new Map<string, State>()
const mockListeners = new Set<() => void>()
function setState(did: string, state: State) {
  mockStates.set(did, state)
  mockListeners.forEach(listener => listener())
}
jest.mock('#/horizon/routing/membership', () => {
  const {useSyncExternalStore} =
    jest.requireActual<typeof import('react')>('react')
  const get = (did?: string) =>
    (did ? mockStates.get(did) : undefined) ?? 'unknown'
  const subscribe = (listener: () => void) => {
    mockListeners.add(listener)
    return () => {
      mockListeners.delete(listener)
    }
  }
  return {
    ...jest.requireActual<object>('#/horizon/routing/membership'),
    getMembership: get,
    subscribeMembership: subscribe,
    useMembership: (did?: string) =>
      useSyncExternalStore(subscribe, () => get(did)),
    reportPrismError: () => {},
  }
})

import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {
  getLensRefusal,
  recordLensRefusal,
  resetLensRefusals,
} from '#/horizon/thread-lens/api'
import {
  isLensServed,
  lensFeatureVerdict,
  resetLensAvailability,
  useIsLensOnlyAnchor,
  useLensServed,
  useThreadLensActive,
} from '#/horizon/thread-lens/availability'
import {
  isLensGapMarked,
  LENS_GAP_PARAM,
  withLensGapMark,
} from '#/horizon/thread-lens/mark'
import {
  getThreadLensPreference,
  parseLensPreference,
  setThreadLensPreference,
  threadLensPreferenceKey,
  useThreadLensPreference,
} from '#/horizon/thread-lens/preference'
import {
  registerLensGaps,
  resetLensRegistry,
} from '#/horizon/thread-lens/registry'
import {AUTHOR, OTHER_READER, privateUriOf, READER, uriOf} from './harness'

const ANCHOR = uriOf('3kanchor22222')
/** The old unkeyed device value, ignored since the value is per account. */
const LEGACY_KEY = 'horizon:threadLens'
const PRIVATE_ANCHOR = privateUriOf('3kprivanchor2')

beforeEach(() => {
  mockStates.clear()
  resetPrismFeatures()
  resetLensRefusals()
  resetLensRegistry()
  resetLensAvailability()
  writeLocal(threadLensPreferenceKey(READER), undefined)
  writeLocal(threadLensPreferenceKey(OTHER_READER), undefined)
  writeLocal(LEGACY_KEY, undefined)
})

describe('served (3.2)', () => {
  it('serves every signed-in account while prism lists nothing about it', () => {
    expect(lensFeatureVerdict(READER)).toBe('unlisted')
    expect(isLensServed(READER)).toBe(true)
    answerPrismFeatures(READER, ['private'])
    expect(lensFeatureVerdict(READER)).toBe('unlisted')
    expect(isLensServed(READER)).toBe(true)
  })

  it('never serves signed out', () => {
    expect(isLensServed(undefined)).toBe(false)
  })

  it('serves a non-member under threadLens.signedIn', () => {
    setState(READER, 'not-member')
    answerPrismFeatures(READER, ['threadLens', 'threadLens.signedIn'])
    expect(lensFeatureVerdict(READER)).toBe('all')
    expect(isLensServed(READER)).toBe(true)
  })

  it('serves a member and not a non-member under threadLens alone', () => {
    answerPrismFeatures(READER, ['threadLens'])
    answerPrismFeatures(OTHER_READER, ['threadLens'])
    setState(READER, 'member')
    setState(OTHER_READER, 'indexing')
    expect(isLensServed(READER)).toBe(true)
    expect(isLensServed(OTHER_READER)).toBe(false)
  })

  it('serves nobody when only another threadLens value is listed', () => {
    setState(READER, 'member')
    answerPrismFeatures(READER, ['threadLens.future'])
    expect(lensFeatureVerdict(READER)).toBe('none')
    expect(isLensServed(READER)).toBe(false)
  })

  it('is taken away by a refusal for that DID only, for the run', () => {
    recordLensRefusal(READER, 'NotEnrolled')
    expect(isLensServed(READER)).toBe(false)
    expect(isLensServed(OTHER_READER)).toBe(true)
    resetLensRefusals()
    expect(isLensServed(READER)).toBe(true)
  })

  it('re-renders a mounted reader when a refusal is recorded', () => {
    const {result} = renderHook(() => useLensServed(READER))
    expect(result.current).toBe(true)
    act(() => recordLensRefusal(READER, 'MethodNotImplemented'))
    expect(result.current).toBe(false)
  })

  it('lifts NotReady when the account next becomes a member, not before', () => {
    setState(READER, 'indexing')
    renderHook(() => useLensServed(READER))
    act(() => recordLensRefusal(READER, 'NotReady'))
    act(() => setState(READER, 'indexing'))
    expect(getLensRefusal(READER)).toBe('NotReady')
    act(() => setState(READER, 'member'))
    expect(getLensRefusal(READER)).toBeUndefined()
  })

  it('keeps a NotReady that arrives while the state already reads member', () => {
    setState(READER, 'member')
    renderHook(() => useLensServed(READER))
    act(() => recordLensRefusal(READER, 'NotReady'))
    act(() => setState(READER, 'member'))
    expect(getLensRefusal(READER)).toBe('NotReady')
  })
})

describe('the device value (4.2)', () => {
  it('defaults on for a member and off for every other state', () => {
    expect(getThreadLensPreference(READER)).toBe(false)
    for (const state of ['not-member', 'indexing', 'unknown'] as const) {
      setState(READER, state)
      expect(getThreadLensPreference(READER)).toBe(false)
    }
    setState(READER, 'member')
    expect(getThreadLensPreference(READER)).toBe(true)
  })

  it('reads 1, 0, true and false, and garbage as the default', () => {
    expect(parseLensPreference('1')).toBe(true)
    expect(parseLensPreference('0')).toBe(false)
    expect(parseLensPreference('true')).toBe(true)
    expect(parseLensPreference('false')).toBe(false)
    expect(parseLensPreference('yes')).toBeUndefined()
    setState(READER, 'member')
    writeLocal(threadLensPreferenceKey(READER), 'false')
    expect(getThreadLensPreference(READER)).toBe(false)
    writeLocal(threadLensPreferenceKey(READER), 'garbage')
    expect(getThreadLensPreference(READER)).toBe(true)
  })

  it('ignores the old unkeyed device value', () => {
    setState(READER, 'member')
    setState(OTHER_READER, 'not-member')
    writeLocal(LEGACY_KEY, '0')
    expect(getThreadLensPreference(READER)).toBe(true)
    writeLocal(LEGACY_KEY, '1')
    expect(getThreadLensPreference(OTHER_READER)).toBe(false)
  })

  it('keeps one value per account, and writes the default as no value', () => {
    setState(READER, 'member')
    setState(OTHER_READER, 'not-member')
    setThreadLensPreference(READER, false)
    expect(readLocal(threadLensPreferenceKey(READER))).toBe('0')
    expect(readLocal(threadLensPreferenceKey(OTHER_READER))).toBeUndefined()
    expect(getThreadLensPreference(OTHER_READER)).toBe(false)
    setThreadLensPreference(OTHER_READER, true)
    expect(readLocal(threadLensPreferenceKey(OTHER_READER))).toBe('1')
    // A's choice is untouched by B's.
    expect(getThreadLensPreference(READER)).toBe(false)
    setThreadLensPreference(OTHER_READER, false)
    expect(readLocal(threadLensPreferenceKey(OTHER_READER))).toBeUndefined()
    setThreadLensPreference(READER, true)
    expect(readLocal(threadLensPreferenceKey(READER))).toBeUndefined()
  })

  it('check 18: A off, switch to B, B keeps its own value; back to A, still off', () => {
    setState(READER, 'member')
    setState(OTHER_READER, 'member')
    const {result, rerender} = renderHook(
      ({did}: {did?: string}) => useThreadLensPreference(did),
      {initialProps: {did: READER}},
    )
    expect(result.current).toBe(true)
    act(() => setThreadLensPreference(READER, false))
    expect(result.current).toBe(false)
    // B has never chosen: its default (on, as a member).
    rerender({did: OTHER_READER})
    expect(result.current).toBe(true)
    // Back to A: still off.
    rerender({did: READER})
    expect(result.current).toBe(false)
    // B with a choice of its own keeps it across switches, and A's writes
    // do not reach it.
    rerender({did: OTHER_READER})
    act(() => setThreadLensPreference(OTHER_READER, false))
    expect(result.current).toBe(false)
    rerender({did: READER})
    act(() => setThreadLensPreference(READER, true))
    expect(result.current).toBe(true)
    rerender({did: OTHER_READER})
    expect(result.current).toBe(false)
  })

  it('check 18 for a non-member: B keeps its default off after A turns it on', () => {
    setState(READER, 'not-member')
    setState(OTHER_READER, 'not-member')
    const {result, rerender} = renderHook(
      ({did}: {did?: string}) => useThreadLensPreference(did),
      {initialProps: {did: READER}},
    )
    expect(result.current).toBe(false)
    act(() => setThreadLensPreference(READER, true))
    expect(result.current).toBe(true)
    rerender({did: OTHER_READER})
    expect(result.current).toBe(false)
    rerender({did: READER})
    expect(result.current).toBe(true)
  })

  it('turns an unset value on when indexing becomes member, and follows writes', () => {
    setState(READER, 'indexing')
    const {result} = renderHook(() => useThreadLensPreference(READER))
    expect(result.current).toBe(false)
    act(() => setState(READER, 'member'))
    expect(result.current).toBe(true)
    // Another tab's write notifies the same way (`subscribeLocal`).
    act(() => writeLocal(threadLensPreferenceKey(READER), '0'))
    expect(result.current).toBe(false)
    // Another account's write does not.
    act(() => writeLocal(threadLensPreferenceKey(OTHER_READER), '1'))
    expect(result.current).toBe(false)
  })
})

describe('active and lens-only (5.1)', () => {
  it('is active for a served account with the value on, never signed out or private', () => {
    setState(READER, 'member')
    const active = renderHook(
      ({did, anchor}: {did?: string; anchor?: string}) =>
        useThreadLensActive(did, anchor),
      {initialProps: {did: READER, anchor: ANCHOR}},
    )
    expect(active.result.current).toEqual({active: true})
    active.rerender({did: READER, anchor: PRIVATE_ANCHOR})
    expect(active.result.current.active).toBe(false)
    active.rerender({did: undefined, anchor: ANCHOR})
    expect(active.result.current.active).toBe(false)
    active.rerender({did: READER, anchor: ANCHOR})
    act(() => setThreadLensPreference(READER, false))
    expect(active.result.current).toEqual({active: false, reason: 'off'})
    act(() => recordLensRefusal(READER, 'NotEnrolled'))
    expect(active.result.current).toEqual({
      active: false,
      reason: 'not-served',
    })
  })

  it('turns lens-only on the render the registry adds the anchor', () => {
    const {result} = renderHook(() =>
      useIsLensOnlyAnchor(READER, ANCHOR, false),
    )
    expect(result.current).toBe(false)
    act(() => registerLensGaps(READER, [[ANCHOR, 'blocking-you']]))
    expect(result.current).toBe(true)
  })

  it('is lens-only when marked, and never for a private anchor', () => {
    expect(
      renderHook(() => useIsLensOnlyAnchor(READER, ANCHOR, true)).result
        .current,
    ).toBe(true)
    registerLensGaps(READER, [[PRIVATE_ANCHOR, 'tier-hidden']])
    expect(
      renderHook(() => useIsLensOnlyAnchor(READER, PRIVATE_ANCHOR, true)).result
        .current,
    ).toBe(false)
    expect(
      renderHook(() => useIsLensOnlyAnchor(undefined, ANCHOR, true)).result
        .current,
    ).toBe(false)
    // Another account's registry is not this one's.
    registerLensGaps(OTHER_READER, [
      [uriOf('3kother222222', AUTHOR), 'deleted'],
    ])
    expect(
      renderHook(() =>
        useIsLensOnlyAnchor(READER, uriOf('3kother222222', AUTHOR), false),
      ).result.current,
    ).toBe(false)
  })
})

describe('the lens gap mark (8.4, TL-33)', () => {
  it('appends lens=gap once, before a hash', () => {
    expect(withLensGapMark('/profile/did:plc:a/post/3k')).toBe(
      '/profile/did:plc:a/post/3k?lens=gap',
    )
    expect(withLensGapMark('/profile/a/post/3k?x=1')).toBe(
      '/profile/a/post/3k?x=1&lens=gap',
    )
    expect(withLensGapMark('/p?lens=gap')).toBe('/p?lens=gap')
    expect(withLensGapMark('/p#top')).toBe('/p?lens=gap#top')
  })

  it('reads the route param', () => {
    expect(isLensGapMarked({[LENS_GAP_PARAM]: 'gap'})).toBe(true)
    expect(isLensGapMarked({[LENS_GAP_PARAM]: 'other'})).toBe(false)
    expect(isLensGapMarked(undefined)).toBe(false)
  })
})
