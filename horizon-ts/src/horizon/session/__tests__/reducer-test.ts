import {type SessionData} from '@atproto/lex-password-session'
import {describe, expect, it, jest} from '@jest/globals'

import {
  type Action,
  getInitialState,
  reducer,
  type State,
} from '#/state/session/reducer'
import {sessionDataToSessionAccount} from '#/state/session/session-core'
import {type SessionAccount} from '#/state/session/types'
import {isSignedInAccount} from '../accounts'
import {oauthAccountFrom} from '../oauth-account'

jest.mock('jwt-decode', () => ({
  jwtDecode(_token: string) {
    return {}
  },
}))
jest.mock('#/state/birthdate')
jest.mock('#/ageAssurance/data')
jest.mock('#/ageAssurance/state', () => ({
  unsafeGetAndComputeAgeAssurance: () => ({state: {}}),
}))
jest.mock('#/lib/notifications/notifications', () => ({
  unregisterPushToken(_clients: unknown[]) {
    return Promise.resolve()
  },
}))
jest.mock('#/state/session/util', () => ({
  createTemporaryClientsAndResume: () => Promise.resolve([]),
}))

function passwordAccount(did: string): SessionAccount {
  const account = sessionDataToSessionAccount(
    {
      did,
      handle: `${did.slice(8)}.test`,
      accessJwt: `${did}-access`,
      refreshJwt: `${did}-refresh`,
      active: true,
    } as unknown as SessionData,
    'https://pds.example',
  )
  if (!account) throw new Error('Expected an account')
  return account
}

function oauthAccount(did: string): SessionAccount {
  return oauthAccountFrom(
    {issuer: 'https://pds.example', aud: 'https://pds.example'},
    {did, handle: `${did.slice(8)}.test`, active: true},
  )
}

function run(state: State, actions: Action[]): State {
  return actions.reduce((s, a) => reducer(s, a), state)
}

const bundleA = {service: new URL('https://pds.example')}
const bundleB = {service: new URL('https://pds.example')}

describe('withOAuthSignOutMarks', () => {
  it('logged-out-current-account marks the current OAuth account only', () => {
    const oauth = oauthAccount('did:plc:oauthaaaa')
    const other = oauthAccount('did:plc:otherbbbb')
    const state = run(getInitialState([]), [
      {type: 'switched-to-account', newBundle: bundleB, newAccount: other},
      {type: 'switched-to-account', newBundle: bundleA, newAccount: oauth},
      {type: 'logged-out-current-account'},
    ])
    const marked = state.accounts.find(a => a.did === oauth.did)
    const untouched = state.accounts.find(a => a.did === other.did)
    expect(marked?.oauthSignedOut).toBe(true)
    expect(untouched?.oauthSignedOut).toBeUndefined()
    expect(isSignedInAccount(marked!, true)).toBe(false)
    expect(state.needsPersist).toBe(true)
  })

  it('logged-out-current-account never marks a password account', () => {
    const password = passwordAccount('did:plc:pwdaaaaaa')
    const state = run(getInitialState([]), [
      {type: 'switched-to-account', newBundle: bundleA, newAccount: password},
      {type: 'logged-out-current-account'},
    ])
    expect(state.accounts[0].oauthSignedOut).toBeUndefined()
    expect(state.accounts[0].refreshJwt).toBeUndefined()
  })

  it('logged-out-every-account marks every OAuth account and no password account', () => {
    const oauth1 = oauthAccount('did:plc:oauthaaaa')
    const oauth2 = oauthAccount('did:plc:oauthbbbb')
    const password = passwordAccount('did:plc:pwdaaaaaa')
    const state = run(getInitialState([oauth1, oauth2, password]), [
      {type: 'logged-out-every-account'},
    ])
    expect(state.accounts.map(a => a.oauthSignedOut)).toEqual([
      true,
      true,
      undefined,
    ])
  })

  it('an expired event from the live bundle marks that OAuth account', () => {
    const oauth = oauthAccount('did:plc:oauthaaaa')
    const state = run(getInitialState([]), [
      {type: 'switched-to-account', newBundle: bundleA, newAccount: oauth},
      {
        type: 'received-session-event',
        bundle: bundleA,
        accountDid: oauth.did,
        refreshedAccount: undefined,
        sessionEvent: 'expired',
      },
    ])
    expect(state.accounts[0].oauthSignedOut).toBe(true)
    expect(state.currentBundleState.did).toBeUndefined()
  })

  it('an expired event from a stale bundle, or an update, marks nothing', () => {
    const oauth = oauthAccount('did:plc:oauthaaaa')
    const stale = run(getInitialState([]), [
      {type: 'switched-to-account', newBundle: bundleA, newAccount: oauth},
      {
        type: 'received-session-event',
        bundle: bundleB,
        accountDid: oauth.did,
        refreshedAccount: undefined,
        sessionEvent: 'expired',
      },
    ])
    expect(stale.accounts[0].oauthSignedOut).toBeUndefined()
    expect(stale.currentBundleState.did).toBe(oauth.did)

    const updated = run(stale, [
      {
        type: 'received-session-event',
        bundle: bundleA,
        accountDid: oauth.did,
        refreshedAccount: {...oauth, handle: 'renamed.test'},
        sessionEvent: 'update',
      },
    ])
    expect(updated.accounts[0].oauthSignedOut).toBeUndefined()
    expect(updated.accounts[0].handle).toBe('renamed.test')
  })

  it('a fresh OAuth login clears the mark', () => {
    const oauth = oauthAccount('did:plc:oauthaaaa')
    const signedOut = run(getInitialState([]), [
      {type: 'switched-to-account', newBundle: bundleA, newAccount: oauth},
      {type: 'logged-out-current-account'},
    ])
    expect(signedOut.accounts[0].oauthSignedOut).toBe(true)
    const again = run(signedOut, [
      {
        type: 'switched-to-account',
        newBundle: bundleB,
        newAccount: oauthAccount('did:plc:oauthaaaa'),
      },
    ])
    expect(again.accounts[0].oauthSignedOut).toBeUndefined()
    expect(isSignedInAccount(again.accounts[0], false)).toBe(true)
  })

  it('keeps a stable field order in the persisted output', () => {
    const oauth = oauthAccount('did:plc:oauthaaaa')
    const passwordKeys = Object.keys(passwordAccount('did:plc:pwdaaaaaa'))
    // The OAuth account has the password account's order, plus its kind.
    expect(Object.keys(oauth)).toEqual([...passwordKeys, 'isOauthSession'])
    const state = run(getInitialState([oauth]), [
      {type: 'logged-out-every-account'},
    ])
    expect(Object.keys(state.accounts[0])).toEqual([
      ...Object.keys(oauth),
      'oauthSignedOut',
    ])
    // Marking twice changes nothing, so the reducer's JSON comparison holds.
    const twice = run(state, [{type: 'logged-out-every-account'}])
    expect(JSON.stringify(twice.accounts)).toBe(JSON.stringify(state.accounts))
  })
})
