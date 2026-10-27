import {describe, expect, it, jest} from '@jest/globals'

/*
 * 2026-10-27: on a cold page load the quote card rendered before prism's
 * membership answer listed `refract`, picked stock's "Deleted", and never
 * looked again (a plain store read in render, which React Compiler caches).
 * Reached in-app, warm, the same quote showed the restored post.
 */

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

import {act, renderHook} from '@testing-library/react-native'

import {RF_READER_DID, rfUri} from '#/horizon/refract/fixtures'
import {
  restoredQuoteSlotActive,
  useRestoredQuoteSlots,
} from '#/horizon/refract/RestoredQuote'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {setupRefract} from './harness'

describe('the quote slot on a cold load', () => {
  it('turns on when prism’s answer lists refract after the first render', () => {
    setupRefract()
    resetPrismFeatures()
    const {result} = renderHook(() => useRestoredQuoteSlots())
    expect(result.current).toBe(false)
    expect(restoredQuoteSlotActive(rfUri('rf1'), result.current)).toBe(false)
    act(() => {
      answerPrismFeatures(RF_READER_DID, ['private', 'refract'])
    })
    expect(result.current).toBe(true)
    expect(restoredQuoteSlotActive(rfUri('rf1'), result.current)).toBe(true)
  })
})
