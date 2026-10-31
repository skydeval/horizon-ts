import {describe, expect, it, jest} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {isAnchoredFollowingKey} from '#/horizon/private/feed/keys'
import {
  useActiveGate,
  useQueryInvalidated,
  useRescrollAfterCoveredChange,
  useStaleFollowingRefresh,
} from '#/horizon/private/feed/on-screen'

const KEY = ['post-feed', 'v2|following', {}, {horizonPrivate: 'did:plc:me'}]

describe('isAnchoredFollowingKey', () => {
  it("matches Following v2's key only", () => {
    expect(isAnchoredFollowingKey(KEY)).toBe(true)
    expect(isAnchoredFollowingKey(['post-feed', 'following', {}])).toBe(false)
    expect(
      isAnchoredFollowingKey(['post-feed', 'author|did:plc:me|posts', {}]),
    ).toBe(false)
    expect(isAnchoredFollowingKey(['profile', 'v2|following'])).toBe(false)
  })
})

describe('useActiveGate', () => {
  it('resolves at once while active, and otherwise once active again', async () => {
    const {result, rerender} = renderHook(
      ({active}: {active: boolean}) => useActiveGate(active),
      {initialProps: {active: false}},
    )
    let passed = false
    const waiting = result.current().then(() => {
      passed = true
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(passed).toBe(false)
    rerender({active: true})
    await act(async () => {
      await waiting
    })
    expect(passed).toBe(true)
    // Active now: no wait
    await expect(result.current()).resolves.toBeUndefined()
  })
})

describe('useQueryInvalidated', () => {
  it('follows invalidation of the query', async () => {
    const qc = new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}})
    qc.setQueryData(KEY, {pages: [], pageParams: []})
    const {result} = renderHook(() => useQueryInvalidated(KEY), {
      wrapper: ({children}) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    })
    expect(result.current).toBe(false)
    await act(async () => {
      await qc.invalidateQueries({queryKey: KEY, refetchType: 'none'})
    })
    expect(result.current).toBe(true)
    act(() => {
      qc.setQueryData(KEY, {pages: [], pageParams: []})
    })
    expect(result.current).toBe(false)
  })
})

describe('useStaleFollowingRefresh', () => {
  type Props = {isActive: boolean; isInvalidated: boolean; down: boolean}
  function setup(initial: Props) {
    const refreshToTop = jest.fn()
    const onHasNew = jest.fn()
    const hook = renderHook(
      ({isActive, isInvalidated, down}: Props) =>
        useStaleFollowingRefresh({
          enabled: true,
          isActive,
          isInvalidated,
          isFetching: false,
          isScrolledDown: () => down,
          refreshToTop,
          onHasNew,
        }),
      {initialProps: initial},
    )
    return {...hook, refreshToTop, onHasNew}
  }

  it('waits for the screen, then refreshes from the top once', () => {
    const {rerender, refreshToTop, onHasNew} = setup({
      isActive: false,
      isInvalidated: true,
      down: false,
    })
    expect(refreshToTop).not.toHaveBeenCalled()
    rerender({isActive: true, isInvalidated: true, down: false})
    rerender({isActive: true, isInvalidated: true, down: false})
    expect(refreshToTop).toHaveBeenCalledTimes(1)
    expect(onHasNew).not.toHaveBeenCalled()
  })

  it('scrolled down, keeps the place and lights the Home dot', () => {
    const {rerender, refreshToTop, onHasNew} = setup({
      isActive: false,
      isInvalidated: true,
      down: true,
    })
    rerender({isActive: true, isInvalidated: true, down: true})
    expect(refreshToTop).not.toHaveBeenCalled()
    expect(onHasNew).toHaveBeenCalledWith(true)
  })

  it('does nothing for a fresh query', () => {
    const {refreshToTop, onHasNew} = setup({
      isActive: true,
      isInvalidated: false,
      down: false,
    })
    expect(refreshToTop).not.toHaveBeenCalled()
    expect(onHasNew).not.toHaveBeenCalled()
  })
})

describe('useRescrollAfterCoveredChange', () => {
  type Props = {isActive: boolean; dataVersion: number}
  function setup() {
    const rescroll = jest.fn()
    const hook = renderHook(
      ({isActive, dataVersion}: Props) =>
        useRescrollAfterCoveredChange({
          enabled: true,
          isActive,
          dataVersion,
          rescroll,
        }),
      {initialProps: {isActive: true, dataVersion: 1}},
    )
    return {...hook, rescroll}
  }

  it('rescrolls once after a change made while covered', () => {
    jest.useFakeTimers()
    const {rerender, rescroll} = setup()
    rerender({isActive: false, dataVersion: 1})
    rerender({isActive: false, dataVersion: 2})
    act(() => {
      jest.runAllTimers()
    })
    expect(rescroll).not.toHaveBeenCalled()
    rerender({isActive: true, dataVersion: 2})
    act(() => {
      jest.runAllTimers()
    })
    expect(rescroll).toHaveBeenCalledTimes(1)
    rerender({isActive: false, dataVersion: 2})
    rerender({isActive: true, dataVersion: 2})
    act(() => {
      jest.runAllTimers()
    })
    expect(rescroll).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it('leaves a change made on screen alone', () => {
    jest.useFakeTimers()
    const {rerender, rescroll} = setup()
    rerender({isActive: true, dataVersion: 2})
    act(() => {
      jest.runAllTimers()
    })
    expect(rescroll).not.toHaveBeenCalled()
    jest.useRealTimers()
  })
})
