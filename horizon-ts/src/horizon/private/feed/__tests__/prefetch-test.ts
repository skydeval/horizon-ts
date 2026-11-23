import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Following's first kryphocron page, read ahead: used once, only while
 * fresh, never kept after a failure. prism is a fake.
 */

let mockCalls = 0
let mockFail = false
jest.mock('#/horizon/private/api/reads', () => ({
  getPrivateTimelineAnswered: () => {
    mockCalls++
    if (mockFail) return Promise.reject(new Error('down'))
    return Promise.resolve({
      body: {feed: [{post: {uri: `at://did:plc:a/p/${mockCalls}`}}]},
      answer: {call: mockCalls},
    })
  },
}))

import {
  prefetchPrivateTop,
  PRIVATE_PREFETCH_TTL_MS,
  resetPrivatePrefetch,
  takePrefetchedPrivateTop,
} from '../prefetch'

const ME = 'did:plc:me'
const source = {did: ME, prism: {}, appview: {}} as never

beforeEach(() => {
  resetPrivatePrefetch()
  mockCalls = 0
  mockFail = false
})

describe('the kryphocron prefetch', () => {
  it('reads once, and the first fetch from the top takes it', async () => {
    prefetchPrivateTop(source, 1000)
    prefetchPrivateTop(source, 2000)
    expect(mockCalls).toBe(1)
    const page = await takePrefetchedPrivateTop(ME, 3000)
    expect(page?.items).toHaveLength(1)
    expect(page?.answers).toEqual([{call: 1}])
    expect(takePrefetchedPrivateTop(ME, 3000)).toBeUndefined()
  })

  it('is never used once stale, or for another account', () => {
    prefetchPrivateTop(source, 1000)
    expect(takePrefetchedPrivateTop('did:plc:other', 1500)).toBeUndefined()
    prefetchPrivateTop(source, 1000)
    expect(
      takePrefetchedPrivateTop(ME, 1000 + PRIVATE_PREFETCH_TTL_MS),
    ).toBeUndefined()
  })

  it('reads again after the window, and keeps no failure', async () => {
    prefetchPrivateTop(source, 1000)
    prefetchPrivateTop(source, 1000 + PRIVATE_PREFETCH_TTL_MS)
    expect(mockCalls).toBe(2)
    resetPrivatePrefetch()
    mockFail = true
    prefetchPrivateTop(source, 5000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(takePrefetchedPrivateTop(ME, 5001)).toBeUndefined()
  })
})
