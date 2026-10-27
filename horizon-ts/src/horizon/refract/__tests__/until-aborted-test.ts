import {describe, expect, it, jest} from '@jest/globals'

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

import {untilAborted} from '#/horizon/refract/api'

/*
 * 2026-10-27: a refract call's deadline aborts its signal, but the token
 * mint before the call ignored it, so a mint that never answered held the
 * call, and one of the batcher's two in-flight places, past the deadline.
 */
describe('untilAborted', () => {
  it('rejects when the signal aborts before the promise settles', async () => {
    const controller = new AbortController()
    const never = new Promise<string>(() => {})
    const waiting = untilAborted(never, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow('aborted')
  })

  it('passes a value or an error through', async () => {
    const controller = new AbortController()
    await expect(
      untilAborted(Promise.resolve('token'), controller.signal),
    ).resolves.toBe('token')
    await expect(
      untilAborted(Promise.reject(new Error('mint failed')), controller.signal),
    ).rejects.toThrow('mint failed')
  })

  it('rejects at once for a signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      untilAborted(Promise.resolve('token'), controller.signal),
    ).rejects.toThrow('aborted')
  })
})
