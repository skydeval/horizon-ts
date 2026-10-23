import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The sign-out clears (Phase 4 design 8.4, 11.5, 12.1; test 13 "Errors":
 * `horizonSignOut` clears the account's wait before its first await, and
 * leaves no timer): the gap registry, the refusal record and the 429 wait
 * of the signed-out accounts, synchronously, before the network sign-out.
 */

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))
let mockRelease: () => void = () => {}
jest.mock('#/horizon/session/accounts', () => ({
  isOauthAccount: () => true,
  isOAuthSignedOut: () => false,
}))
jest.mock('#/lib/notifications/notifications', () => ({
  // The network sign-out is held until the test releases it.
  unregisterPushToken: () =>
    new Promise<void>(resolve => {
      mockRelease = resolve
    }),
}))
jest.mock('#/horizon/session/oauth-transport', () => ({
  createOAuthTransport: () => ({}),
  restoreOAuthSession: () => Promise.resolve({signOut: async () => {}}),
}))
jest.mock('#/lib/lexClient', () => ({createLexClient: () => ({})}))
jest.mock('#/state/session/network', () => ({networkAwareFetch: fetch}))

import {type SessionAccount} from '#/state/session/types'
import {horizonSignOut} from '#/horizon/session/sign-out'
import {
  getLensRefusal,
  isLensWaiting,
  pendingLensTimerCount,
  recordLensRefusal,
  recordLensWait,
  resetLensRefusals,
  resetLensWaits,
} from '#/horizon/thread-lens/api'
import {
  hasLensGap,
  registerLensGaps,
  resetLensRegistry,
} from '#/horizon/thread-lens/registry'
import {OTHER_READER, READER, uriOf} from './harness'

const GAP = uriOf('3kgap22222222')

beforeEach(() => {
  resetLensWaits()
  resetLensRefusals()
  resetLensRegistry()
})

describe('horizonSignOut', () => {
  it("clears the signed-out account's lens stores before its first await", async () => {
    for (const did of [READER, OTHER_READER]) {
      registerLensGaps(did, [[GAP, 'blocking-you']])
      recordLensRefusal(did, 'NotEnrolled')
      recordLensWait(did, Date.now() + 60_000)
    }
    const done = horizonSignOut([{did: READER} as unknown as SessionAccount])
    // The network sign-out is still held here.
    expect(hasLensGap(READER, GAP)).toBe(false)
    expect(getLensRefusal(READER)).toBeUndefined()
    expect(isLensWaiting(READER)).toBe(false)
    // Another account's stores are its own.
    expect(hasLensGap(OTHER_READER, GAP)).toBe(true)
    expect(getLensRefusal(OTHER_READER)).toBe('NotEnrolled')
    expect(isLensWaiting(OTHER_READER)).toBe(true)
    expect(pendingLensTimerCount()).toBe(1)
    mockRelease()
    await done
    resetLensWaits()
    expect(pendingLensTimerCount()).toBe(0)
  })
})
