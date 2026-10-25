import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Registration (system accounts design 4.3, 4.4, 5.3; 18 "Add", "addingFor",
 * "Popup", "Mismatch", "Step 5's order", "Popup, one at a time", "Completes
 * once", "App password"). The popup, the library's sign-in, prism and the
 * temporary client are fakes; the device stores run on an in-memory map.
 */

jest.mock('#/horizon/system-accounts/device', () => {
  const values = new Map<string, string>()
  return {
    readDevice: (key: string) => values.get(key),
    writeDevice: (key: string, value: string | undefined) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
    subscribeDevice: () => () => {},
    clearForTests: () => values.clear(),
  }
})
const mockRevoke = jest.fn<(did: string) => Promise<void>>(() =>
  Promise.resolve(),
)
jest.mock('#/horizon/session/revoke', () => ({
  revokeOAuthGrant: (did: string) => mockRevoke(did),
  endPasswordSession: () => Promise.resolve(),
  isRevokingOAuthGrant: () => false,
}))
jest.mock('#/state/persisted', () => ({get: () => ({accounts: []})}))
const mockSignInPopup = jest.fn<(did: string, options: unknown) => unknown>(
  () => new Promise(() => {}),
)
jest.mock('#/horizon/session/oauth-client', () => ({
  OAUTH_AVAILABLE: true,
  getOAuthClient: () => ({
    signInPopup: (did: string, options: unknown) =>
      mockSignInPopup(did, options),
    identityResolver: {
      resolve: (did: string) =>
        Promise.resolve({handle: `${did.slice(8, 12)}.test`}),
    },
  }),
}))
jest.mock('#/horizon/posting-as/temp-client', () => ({
  createTemporaryClient: (account: {did: string}) => ({
    clients: {pdsClient: {assertDid: account.did}},
    dispose: () => {},
  }),
}))
let mockCurrent: {did: string; handle: string; pdsClient: unknown} | undefined
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentClients: () => mockCurrent,
}))
type Api = {
  addSystemAccount: jest.Mock<
    (
      pds: unknown,
      did: string,
      mint: () => Promise<string>,
    ) => Promise<{
      rev: string
    }>
  >
  mintProof: jest.Mock<(client: {assertDid: string}) => Promise<string>>
  removeSystemAccount: jest.Mock<
    (pds: unknown, did: string) => Promise<{rev: string}>
  >
}
const mockApi: Api = {
  addSystemAccount: jest.fn(async (_pds, _did, mint) => {
    await mint()
    return {rev: '9'}
  }),
  mintProof: jest.fn(client => Promise.resolve(`proof-${client.assertDid}`)),
  removeSystemAccount: jest.fn(() => Promise.resolve({rev: '10'})),
}
jest.mock('#/horizon/system-accounts/prism', () => ({
  ...jest.requireActual<object>('#/horizon/system-accounts/prism-types'),
  systemAccountsApi: () => mockApi,
}))
const mockReadList = jest.fn<(registrar: string) => Promise<boolean>>(() =>
  Promise.resolve(true),
)
jest.mock('#/horizon/system-accounts/sync', () => ({
  readList: (registrar: string) => mockReadList(registrar),
  reportDropped: () => {},
}))
const mockLogin = jest.fn<(options: unknown) => Promise<unknown>>()
jest.mock('@atproto/lex-password-session', () => ({
  ...jest.requireActual<object>('@atproto/lex-password-session'),
  PasswordSession: {login: (options: unknown) => mockLogin(options)},
}))

import {i18n} from '@lingui/core'

import {type SessionAccount} from '#/state/session/types'
import {OAUTH_SCOPE} from '#/horizon/session/oauth-metadata'
import {resetAnnouncerForTests} from '../announce'
import {applyListAnswer, getList, resetListStoreForTests} from '../list-store'
import {SystemAccountsError} from '../prism-types'
import {
  beginRegistration,
  getRegistration,
  type PopupSession,
  pressSignIn,
  registrationDialogOpened,
  resetRegistrationForTests,
  retryAdd,
  setRegistrationEnvForTests,
  signInWithAppPassword,
  START_AGAIN_AFTER_MS,
  startAgain,
  startAgainAt,
} from '../register'
import {getEntry, putEntry, resetSessionStoreForTests} from '../session-store'
import {resetSweepForTests, setSwitcherAccountsSource} from '../sweep'

i18n.loadAndActivate({locale: 'en', messages: {}})

const device = jest.requireMock<{clearForTests: () => void}>(
  '#/horizon/system-accounts/device',
)

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const X = 'did:plc:xxxxxxxxxxxxxxxxxxxxxxxx'
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'did:plc:cccccccccccccccccccccccc'

let now = 1_000_000
let names: string[] = []
let popups: {focus: jest.Mock; close: jest.Mock}[] = []
let opens: string[] = []
let results: {
  resolve: (s: PopupSession) => void
  reject: (e: unknown) => void
}[]
let blocked = false
let switcher: SessionAccount[] = []

function popupSession(did: string) {
  return {
    did,
    serverMetadata: {issuer: 'https://auth.example'},
    getTokenInfo: () => Promise.resolve({aud: 'https://pds.example'}),
    signOut: jest.fn(() => Promise.resolve()),
    fetchHandler: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({did, handle: `${did.slice(8, 12)}.test`}),
          {status: 200, headers: {'content-type': 'application/json'}},
        ),
      ),
  } as unknown as PopupSession & {signOut: jest.Mock}
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function useEnv() {
  setRegistrationEnvForTests({
    now: () => now,
    windowName: () => {
      const name = `name-${names.length + 1}`
      names.push(name)
      return name
    },
    openWindow: name => {
      opens.push(name)
      if (blocked) return null
      const popup = {focus: jest.fn(), close: jest.fn()}
      popups.push(popup)
      return popup as unknown as Window
    },
    signIn: () =>
      new Promise<PopupSession>((resolve, reject) =>
        results.push({resolve, reject}),
      ),
    currentDid: () => mockCurrent?.did,
    currentPdsClient: () => mockCurrent?.pdsClient as never,
    revoke: did => mockRevoke(did),
  })
}

beforeEach(() => {
  device.clearForTests()
  resetListStoreForTests()
  resetSessionStoreForTests()
  resetRegistrationForTests()
  resetSweepForTests()
  now = 1_000_000
  names = []
  popups = []
  opens = []
  results = []
  blocked = false
  switcher = [
    {
      did: A,
      handle: 'a.test',
      isOauthSession: true,
    } as unknown as SessionAccount,
  ]
  setSwitcherAccountsSource(() => switcher)
  mockCurrent = {did: A, handle: 'a.test', pdsClient: {assertDid: A}}
  mockRevoke.mockClear()
  mockApi.addSystemAccount.mockClear()
  mockApi.mintProof.mockClear()
  mockReadList.mockClear()
  mockSignInPopup.mockClear()
  mockLogin.mockReset()
  useEnv()
})

afterEach(() => {
  resetAnnouncerForTests()
})

function begin(did = B) {
  return beginRegistration(
    {did, handle: 'lala.test', pdsUrl: 'https://pds.example'},
    'add',
  )!
}

describe('the popup (4.3 step 4)', () => {
  it('writes the provisional entry, with `pendingUntil`, before the window opens', () => {
    begin()
    setRegistrationEnvForTests({
      ...{},
      now: () => now,
      windowName: () => 'n1',
      openWindow: () => {
        expect(getEntry(B)).toEqual(
          expect.objectContaining({
            did: B,
            addingFor: A,
            pendingUntil: now + 6 * 60_000,
          }),
        )
        return {focus: jest.fn()} as unknown as Window
      },
      signIn: () => new Promise(() => {}),
      currentDid: () => A,
    })
    expect(pressSignIn()).toBe('started')
  })

  it('a blocked window starts no sign-in, drops the provisional entry and says so', () => {
    blocked = true
    begin()
    expect(pressSignIn()).toBe('blocked')
    expect(results).toHaveLength(0)
    expect(getEntry(B)).toBeUndefined()
    expect(getRegistration()?.outcome.kind).toBe('blocked')
  })

  it('the library is asked with the window name, `prompt: login`, `scope: OAUTH_SCOPE` and no signal (SA-22)', () => {
    setRegistrationEnvForTests({
      now: () => now,
      windowName: () => 'random-name',
      openWindow: () => ({focus: jest.fn()}) as unknown as Window,
      currentDid: () => A,
    })
    begin()
    pressSignIn()
    expect(mockSignInPopup).toHaveBeenCalledWith(B, {
      display: 'popup',
      popupName: 'random-name',
      prompt: 'login',
      scope: OAUTH_SCOPE,
    })
  })

  it('a second press focuses the pending window and starts nothing (SA-23)', () => {
    begin()
    pressSignIn()
    expect(pressSignIn()).toBe('focused')
    expect(popups[0].focus).toHaveBeenCalled()
    expect(results).toHaveLength(1)
  })

  it('Start again is offered 5 seconds after the press, opens a new window with a new name, and never closes the old one', () => {
    const reg = begin()
    pressSignIn()
    expect(startAgainAt(reg)).toBe(now + START_AGAIN_AFTER_MS)
    now += START_AGAIN_AFTER_MS
    startAgain()
    expect(names).toEqual(['name-1', 'name-2'])
    expect(opens).toEqual(['name-1', 'name-2'])
    expect(popups[0].close).not.toHaveBeenCalled()
    expect(results).toHaveLength(2)
  })

  it('a timeout says so; nothing polls `closed`', async () => {
    begin()
    pressSignIn()
    results[0].reject(new Error('Timeout'))
    await settle()
    expect(getRegistration()?.outcome.kind).toBe('timeout')
  })
})

describe('when the popup returns (4.3 step 5)', () => {
  it('the expected account: the entry is completed and one add is sent with the added account’s proof', async () => {
    const close = registrationDialogOpened()
    begin()
    pressSignIn()
    results[0].resolve(popupSession(B))
    await settle()
    expect(mockApi.addSystemAccount).toHaveBeenCalledTimes(1)
    expect(mockApi.addSystemAccount.mock.calls[0][1]).toBe(B)
    expect(mockApi.mintProof).toHaveBeenCalledWith({assertDid: B})
    expect(getRegistration()?.outcome.kind).toBe('added')
    expect(getList(A)?.accounts.map(a => a.did)).toEqual([B])
    expect(getEntry(B)).toEqual(
      expect.objectContaining({kind: 'oauth', handle: 'bbbb.test'}),
    )
    // Confirmed by the add's own answer: out of its grace.
    expect(getEntry(B)?.addingFor).toBeUndefined()
    close()
  })

  it('completes once: two attempts both returning the expected account send one add', async () => {
    begin()
    pressSignIn()
    now += START_AGAIN_AFTER_MS
    startAgain()
    results[1].resolve(popupSession(B))
    await settle()
    results[0].resolve(popupSession(B))
    await settle()
    expect(mockApi.addSystemAccount).toHaveBeenCalledTimes(1)
  })

  it('another account Horizon does not hold: its new session is signed out and no entry is left; the entry existed before the check (SAR3-L3, L4)', async () => {
    begin()
    pressSignIn()
    const session = popupSession(C)
    let entryAtSignOut: unknown
    session.signOut.mockImplementation(() => {
      entryAtSignOut = getEntry(C)
      return Promise.resolve()
    })
    results[0].resolve(session)
    await settle()
    expect(entryAtSignOut).toEqual(
      expect.objectContaining({did: C, kind: 'oauth'}),
    )
    expect(session.signOut).toHaveBeenCalled()
    expect(getEntry(C)).toBeUndefined()
    // No session came back for the expected DID: its provisional entry goes.
    expect(getEntry(B)).toBeUndefined()
    expect(getRegistration()?.outcome).toEqual({
      kind: 'mismatch',
      got: '@cccc.test',
    })
    expect(mockApi.addSystemAccount).not.toHaveBeenCalled()
  })

  it('another account Horizon holds (a complete `oauth` entry, or the browsing account) keeps its session', async () => {
    // Held for A's list, so the sweep keeps it too.
    applyListAnswer(A, {accounts: [{did: C, addedAt: 't'}], rev: '1'})
    putEntry({did: C, kind: 'oauth', service: 'https://auth.example/'})
    begin()
    pressSignIn()
    const held = popupSession(C)
    results[0].resolve(held)
    await settle()
    expect(held.signOut).not.toHaveBeenCalled()
    expect(getEntry(C)).toEqual(expect.objectContaining({kind: 'oauth'}))
    expect(getRegistration()?.outcome.kind).toBe('mismatch')

    // The browsing account itself (SAR2-B2): kept, nothing written for it.
    resetRegistrationForTests()
    useEnv()
    results = []
    begin()
    pressSignIn()
    const browsing = popupSession(A)
    results[0].resolve(browsing)
    await settle()
    expect(browsing.signOut).not.toHaveBeenCalled()
    expect(getEntry(A)).toBeUndefined()
  })

  it('a password switcher account is not held: the new OAuth session is signed out (SAR3-L3)', async () => {
    switcher = [
      ...switcher,
      {did: C, handle: 'c.test', refreshJwt: 'r'} as unknown as SessionAccount,
    ]
    begin()
    pressSignIn()
    const session = popupSession(C)
    results[0].resolve(session)
    await settle()
    expect(session.signOut).toHaveBeenCalled()
    expect(getEntry(C)).toBeUndefined()
  })

  it('the current account changed: no add, a new grant revoked, the message; switching back sends nothing (SA-24)', async () => {
    begin()
    pressSignIn()
    mockCurrent = {did: X, handle: 'x.test', pdsClient: {assertDid: X}}
    results[0].resolve(popupSession(B))
    await settle()
    expect(mockApi.addSystemAccount).not.toHaveBeenCalled()
    expect(mockRevoke).toHaveBeenCalledWith(B)
    expect(getEntry(B)).toBeUndefined()
    expect(getRegistration()?.outcome.kind).toBe('switched')
    mockCurrent = {did: A, handle: 'a.test', pdsClient: {assertDid: A}}
    await settle()
    expect(mockApi.addSystemAccount).not.toHaveBeenCalled()
  })

  it('a registration abandoned by signing out discards a late result and revokes the new grant (6.5 step 1)', async () => {
    const reg = begin()
    pressSignIn()
    reg.abandoned = true
    results[0].resolve(popupSession(B))
    await settle()
    expect(mockApi.addSystemAccount).not.toHaveBeenCalled()
    expect(mockRevoke).toHaveBeenCalledWith(B)
    expect(getEntry(B)).toBeUndefined()
  })
})

describe('the add (5.3)', () => {
  it('a refusal keeps the entry’s grace; Try again refreshes it and mints a new proof', async () => {
    mockApi.addSystemAccount.mockImplementationOnce(async (_p, _d, mint) => {
      await mint()
      throw new SystemAccountsError('proof')
    })
    begin()
    pressSignIn()
    results[0].resolve(popupSession(B))
    await settle()
    expect(getRegistration()?.outcome).toEqual({
      kind: 'addFailed',
      reason: 'proof',
    })
    expect(getEntry(B)?.addingFor).toBe(A)
    const since = getEntry(B)?.addingSince
    now += 30_000
    await retryAdd()
    expect(getEntry(B)?.addingSince).toBeUndefined()
    expect(since).toBeDefined()
    expect(mockApi.mintProof).toHaveBeenCalledTimes(2)
    expect(getRegistration()?.outcome.kind).toBe('added')
  })

  it('Try again goes back to the sign-in step if the session was swept meanwhile', async () => {
    mockApi.addSystemAccount.mockImplementationOnce(() =>
      Promise.reject(new SystemAccountsError('refused')),
    )
    begin()
    pressSignIn()
    results[0].resolve(popupSession(B))
    await settle()
    putEntry({...getEntry(B)!, needsSignIn: true})
    expect(await retryAdd()).toBe('signIn')
  })

  it('no answer is unknown: a read that has the account is a success', async () => {
    mockApi.addSystemAccount.mockImplementationOnce(() =>
      Promise.reject(new SystemAccountsError('unknown')),
    )
    mockReadList.mockImplementationOnce(registrar => {
      applyListAnswer(registrar, {accounts: [{did: B, addedAt: 't'}], rev: '9'})
      return Promise.resolve(true)
    })
    begin()
    pressSignIn()
    results[0].resolve(popupSession(B))
    await settle()
    expect(getRegistration()?.outcome.kind).toBe('added')
  })

  it('no answer and a read without it: "Couldn’t reach Horizon’s server."', async () => {
    mockApi.addSystemAccount.mockImplementationOnce(() =>
      Promise.reject(new SystemAccountsError('unknown')),
    )
    begin()
    pressSignIn()
    results[0].resolve(popupSession(B))
    await settle()
    expect(getRegistration()?.outcome).toEqual({
      kind: 'addFailed',
      reason: 'unreachable',
    })
  })
})

function token(scope: string) {
  const body = btoa(JSON.stringify({scope, exp: 9_999_999_999})).replace(
    /=+$/,
    '',
  )
  return `x.${body}.y`
}

function passwordSession(did: string, scope = 'com.atproto.appPass') {
  return {
    session: {
      did,
      handle: `${did.slice(8, 12)}.test`,
      accessJwt: token(scope),
      refreshJwt: token('com.atproto.refresh'),
      service: 'https://pds.example',
    },
    logout: jest.fn(() => Promise.resolve()),
  }
}

describe('the app password form (4.3 step 6)', () => {
  it('logs in at the account’s own PDS and stores the session in the system store only', async () => {
    const session = passwordSession(B)
    mockLogin.mockResolvedValueOnce(session)
    begin()
    await signInWithAppPassword({password: 'app-pass'})
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'https://pds.example',
        identifier: 'lala.test',
      }),
    )
    expect(getEntry(B)).toEqual(expect.objectContaining({kind: 'password'}))
    expect(mockApi.addSystemAccount).toHaveBeenCalledTimes(1)
  })

  it('a mismatched account stores nothing', async () => {
    const session = passwordSession(C)
    mockLogin.mockResolvedValueOnce(session)
    begin()
    await signInWithAppPassword({password: 'app-pass'})
    expect(session.logout).toHaveBeenCalled()
    expect(getEntry(C)).toBeUndefined()
    expect(getEntry(B)).toBeUndefined()
    expect(getRegistration()?.outcome.kind).toBe('mismatch')
  })

  it('a full-access token is refused as the account password', async () => {
    const session = passwordSession(B, 'com.atproto.access')
    mockLogin.mockResolvedValueOnce(session)
    begin()
    await signInWithAppPassword({password: 'main'})
    expect(session.logout).toHaveBeenCalled()
    expect(getEntry(B)).toBeUndefined()
    expect(getRegistration()?.outcome.kind).toBe('mainPassword')
  })

  it('after a switch the new tokens are discarded (SA-24)', async () => {
    const session = passwordSession(B)
    mockLogin.mockResolvedValueOnce(session)
    begin()
    mockCurrent = {did: X, handle: 'x.test', pdsClient: {assertDid: X}}
    await signInWithAppPassword({password: 'app-pass'})
    expect(session.logout).toHaveBeenCalled()
    expect(getEntry(B)).toBeUndefined()
    expect(getRegistration()?.outcome.kind).toBe('switched')
  })
})
