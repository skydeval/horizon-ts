import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The death rule (system accounts design SA-25, 18 "Cloned causes"). The
 * real `isOAuthRefreshFailure` of the web client is used, over the library's
 * own error classes, loaded from their files (the browser library, which
 * re-exports them, needs a real browser to load). Each clone goes through
 * `structuredClone`, so the test fails if a later library release makes
 * clones keep their class.
 */
const ERRORS = '../../../../node_modules/@atproto/oauth-client/dist/errors'
const {TokenRefreshError} = jest.requireActual<{
  TokenRefreshError: new (sub: string, message: string) => Error
}>(`${ERRORS}/token-refresh-error.js`)
const {TokenInvalidError} = jest.requireActual<{
  TokenInvalidError: new (sub: string, message?: string) => Error
}>(`${ERRORS}/token-invalid-error.js`)
const {TokenRevokedError} = jest.requireActual<{
  TokenRevokedError: new (sub: string) => Error
}>(`${ERRORS}/token-revoked-error.js`)
jest.mock('@atproto/oauth-client-browser', () => {
  const dir = '../../../../node_modules/@atproto/oauth-client/dist/errors'
  return {
    ...jest.requireActual<object>(`${dir}/token-refresh-error.js`),
    ...jest.requireActual<object>(`${dir}/token-invalid-error.js`),
    ...jest.requireActual<object>(`${dir}/token-revoked-error.js`),
  }
})
type Deleted = (did: string, cause: unknown) => void
let mockDeleted: Deleted | undefined
jest.mock('#/horizon/session/oauth-client', () => ({
  ...jest.requireActual<object>('#/horizon/session/oauth-client.web'),
  addOAuthSessionDeletedListener: (listener: Deleted) => {
    mockDeleted = listener
    return () => {
      mockDeleted = undefined
    }
  },
}))
const mockDropped = jest.fn()
jest.mock('#/state/events', () => ({emitSessionDropped: () => mockDropped()}))
const CURRENT = 'did:plc:currentaaaaaaaaaaaaaaaaa'
const SYSTEM = 'did:plc:systemaaaaaaaaaaaaaaaaaa'
jest.mock('#/horizon/session/oauth-bundles', () => ({
  getOAuthBundleDid: (bundle: {did?: string}) => bundle.did,
}))

import {
  addOAuthSessionLostListener,
  watchOAuthSessionDeath,
} from '../session-death'

const dispatch = jest.fn()
const store = {
  getState: () =>
    ({currentBundleState: {bundle: {did: CURRENT}, did: CURRENT}}) as never,
  dispatch,
}

let lost: string[] = []
let stop: () => void = () => {}

beforeEach(() => {
  stop()
  dispatch.mockReset()
  mockDropped.mockReset()
  lost = []
  const unwatch = watchOAuthSessionDeath(store)
  const unlisten = addOAuthSessionLostListener(did => lost.push(did))
  stop = () => {
    unwatch()
    unlisten()
  }
})

function clone<T>(value: T): unknown {
  return structuredClone(value)
}

describe('a deletion from another window is never a death (SA-25)', () => {
  const cloned: [string, (did: string) => unknown][] = [
    ['a cloned TokenRevokedError', did => clone(new TokenRevokedError(did))],
    [
      'a cloned TokenRefreshError',
      did => clone(new TokenRefreshError(did, 'x')),
    ],
    [
      'a cloned TokenInvalidError',
      did => clone(new TokenInvalidError(did, 'x')),
    ],
    ['a plain Error', () => new Error('x')],
    ['a same-window TokenRevokedError', did => new TokenRevokedError(did)],
  ]

  it('clones arrive as plain errors in this environment', () => {
    const copy = clone(new TokenRefreshError(CURRENT, 'x'))
    expect(copy).toBeInstanceOf(Error)
    expect(copy).not.toBeInstanceOf(TokenRefreshError)
  })

  it.each(cloned)('%s drops nothing and marks nothing', (_name, make) => {
    mockDeleted?.(CURRENT, make(CURRENT))
    mockDeleted?.(SYSTEM, make(SYSTEM))
    expect(dispatch).not.toHaveBeenCalled()
    expect(mockDropped).not.toHaveBeenCalled()
    expect(lost).toEqual([])
  })
})

describe('a same-window refresh failure is a death', () => {
  it.each([
    ['TokenRefreshError', (did: string) => new TokenRefreshError(did, 'x')],
    ['TokenInvalidError', (did: string) => new TokenInvalidError(did)],
  ])('%s drops the current bundle, as before', (_name, make) => {
    mockDeleted?.(CURRENT, make(CURRENT))
    expect(mockDropped).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'received-session-event',
        accountDid: CURRENT,
        sessionEvent: 'expired',
      }),
    )
    expect(lost).toEqual([CURRENT])
  })

  it('reaches the lost listeners for another DID, without touching the current bundle', () => {
    mockDeleted?.(SYSTEM, new TokenRefreshError(SYSTEM, 'x'))
    expect(lost).toEqual([SYSTEM])
    expect(dispatch).not.toHaveBeenCalled()
    expect(mockDropped).not.toHaveBeenCalled()
  })
})
