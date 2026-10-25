import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The runtime (system accounts design 6.4, SA-H7; 18 "Session death",
 * "Cloned causes" for a system entry's DID): a session reported lost marks
 * its system entry "Sign in again" and a registering account's list
 * `diedAt`; a deletion cloned from another window marks nothing; a sign-in
 * clears both. The real death rule runs over the library's own error
 * classes, loaded from their files.
 */

jest.mock('#/horizon/system-accounts/device', () => {
  const values = new Map<string, string>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    readDevice: (key: string) => values.get(key),
    writeDevice: (key: string, value: string | undefined) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
      listeners.get(key)?.forEach(listener => listener())
    },
    subscribeDevice: (key: string, listener: () => void) => {
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => set.delete(listener)
    },
    clearForTests: () => values.clear(),
  }
})
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
jest.mock('#/state/events', () => ({emitSessionDropped: () => {}}))
jest.mock('#/horizon/session/oauth-bundles', () => ({
  getOAuthBundleDid: () => undefined,
}))
const mockRevoke = jest.fn<(did: string) => Promise<void>>(() =>
  Promise.resolve(),
)
jest.mock('#/horizon/session/revoke', () => ({
  revokeOAuthGrant: (did: string) => mockRevoke(did),
  endPasswordSession: () => Promise.resolve(),
  isRevokingOAuthGrant: () => false,
}))
jest.mock('#/state/persisted', () => ({get: () => ({accounts: []})}))

import {type SessionAccount} from '#/state/session/types'
import {watchOAuthSessionDeath} from '#/horizon/session/session-death'
import {applyListAnswer, getList, resetListStoreForTests} from '../list-store'
import {startSystemAccounts} from '../runtime'
import {getEntry, putEntry, resetSessionStoreForTests} from '../session-store'

const ERRORS = '../../../../node_modules/@atproto/oauth-client/dist/errors'
const {TokenRefreshError} = jest.requireActual<{
  TokenRefreshError: new (sub: string, message: string) => Error
}>(`${ERRORS}/token-refresh-error.js`)
const {TokenRevokedError} = jest.requireActual<{
  TokenRevokedError: new (sub: string) => Error
}>(`${ERRORS}/token-revoked-error.js`)

const device = jest.requireMock<{clearForTests: () => void}>(
  '#/horizon/system-accounts/device',
)

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'

function oauth(did: string, extra: Partial<SessionAccount> = {}) {
  return {
    service: 'https://pds.example/',
    did,
    handle: 'x.test',
    isOauthSession: true,
    ...extra,
  } as unknown as SessionAccount
}

let state: {
  accounts: SessionAccount[]
  currentBundleState: {did: string | undefined; bundle: unknown}
}
const listeners = new Set<() => void>()
const store = {
  getState: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  dispatch: () => {},
}

function setState(next: Partial<typeof state>) {
  state = {...state, ...next}
  listeners.forEach(listener => listener())
}

let stop: () => void = () => {}

beforeEach(() => {
  device.clearForTests()
  resetListStoreForTests()
  resetSessionStoreForTests()
  mockRevoke.mockClear()
  state = {
    accounts: [oauth(A)],
    currentBundleState: {did: A, bundle: {}},
  }
  applyListAnswer(A, {accounts: [{did: B, addedAt: 't'}], rev: '1'})
  putEntry({did: B, kind: 'oauth', service: 'https://pds.example/'})
  const unwatch = watchOAuthSessionDeath(store as never)
  const unstart = startSystemAccounts(store)
  stop = () => {
    unwatch()
    unstart()
  }
})

afterEach(() => {
  stop()
})

describe('session death for system accounts (6.4)', () => {
  it('a same-window refresh failure of a system session marks it "Sign in again"', () => {
    mockDeleted?.(B, new TokenRefreshError(B, 'x'))
    expect(getEntry(B)?.needsSignIn).toBe(true)
    // Still held by A's list: nothing revoked.
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('a cloned cause from another window, or Horizon’s own revocation, marks nothing (SA-25)', () => {
    mockDeleted?.(B, structuredClone(new TokenRefreshError(B, 'x')))
    mockDeleted?.(B, structuredClone(new TokenRevokedError(B)))
    mockDeleted?.(B, new TokenRevokedError(B))
    mockDeleted?.(B, new Error('x'))
    expect(getEntry(B)?.needsSignIn).toBeUndefined()
  })

  it('a registering account’s death sets `diedAt` on its list, and nothing is revoked in that load (SQ-19)', () => {
    mockDeleted?.(A, new TokenRefreshError(A, 'x'))
    expect(getList(A)?.diedAt).toBeDefined()
    // The stock reducer marks the dead current account signed out.
    setState({accounts: [oauth(A, {oauthSignedOut: true})]})
    expect(getList(A)?.diedAt).toBeDefined()
    expect(getEntry(B)).toBeDefined()
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('a sign-in again in the same load clears `diedAt` and the mark', () => {
    setState({accounts: [oauth(A, {oauthSignedOut: true})]})
    expect(getList(A)?.diedAt).toBeDefined()
    setState({accounts: [oauth(A)]})
    expect(getList(A)?.diedAt).toBeUndefined()
  })

  it('a listed switcher account’s mark is cleared when it becomes current with a working session (SAR3-N7)', () => {
    // X lists A; A's switcher entry was marked by a probe in a temporary client.
    const X = 'did:plc:xxxxxxxxxxxxxxxxxxxxxxxx'
    applyListAnswer(X, {accounts: [{did: A, addedAt: 't'}], rev: '1'})
    setState({
      accounts: [oauth(A), oauth(X)],
      currentBundleState: {did: X, bundle: {}},
    })
    putEntry({did: A, kind: 'switcher', needsSignIn: true})
    setState({
      currentBundleState: {did: X, bundle: {}},
      accounts: [oauth(A), oauth(X)],
    })
    expect(getEntry(A)?.needsSignIn).toBe(true)
    setState({currentBundleState: {did: A, bundle: {}}})
    expect(getEntry(A)).toBeDefined()
    expect(getEntry(A)?.needsSignIn).toBeUndefined()
  })
})
