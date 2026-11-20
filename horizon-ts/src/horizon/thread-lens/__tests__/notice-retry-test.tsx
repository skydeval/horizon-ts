import {describe, expect, it, jest} from '@jest/globals'

/*
 * Thread Lens's notice never shows (skydeval, 2026-11-20): it renders
 * nothing, and while the lens is failing it reads the thread again every few
 * seconds, quietly, and never during the account's 429 wait.
 */

jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: 'did:plc:me'}}),
}))
let mockWaiting = false
jest.mock('#/horizon/thread-lens/api', () => ({
  useLensWaiting: () => mockWaiting,
}))
jest.mock('#/horizon/switches', () => ({THREAD_LENS: true}))
jest.mock('#/horizon/thread-lens/notice', () => ({
  lensNoticeLines: (lens: {failing: boolean}) =>
    lens.failing ? [{text: {id: 'x'}, retry: true}] : [],
}))

import {act, render} from '@testing-library/react-native'

import {LENS_RETRY_MS, ThreadLensNotice} from '../LensNotice'

describe('ThreadLensNotice', () => {
  it('shows nothing, and retries quietly while the lens fails', () => {
    jest.useFakeTimers()
    const onRetry = jest.fn()
    const view = render(
      <ThreadLensNotice lens={{failing: true} as never} onRetry={onRetry} />,
    )
    expect(view.toJSON()).toBeNull()
    act(() => {
      jest.advanceTimersByTime(LENS_RETRY_MS * 2)
    })
    expect(onRetry).toHaveBeenCalledTimes(2)
    view.unmount()
    jest.useRealTimers()
  })

  it('does not retry when the lens is fine, or during the 429 wait', () => {
    jest.useFakeTimers()
    const onRetry = jest.fn()
    const fine = render(
      <ThreadLensNotice lens={{failing: false} as never} onRetry={onRetry} />,
    )
    act(() => {
      jest.advanceTimersByTime(LENS_RETRY_MS * 3)
    })
    fine.unmount()
    mockWaiting = true
    const waiting = render(
      <ThreadLensNotice lens={{failing: true} as never} onRetry={onRetry} />,
    )
    act(() => {
      jest.advanceTimersByTime(LENS_RETRY_MS * 3)
    })
    waiting.unmount()
    mockWaiting = false
    expect(onRetry).not.toHaveBeenCalled()
    jest.useRealTimers()
  })
})
