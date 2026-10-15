import {beforeEach, describe, expect, it, jest} from '@jest/globals'

const mockRestore =
  jest.fn<(did: string, refresh?: boolean) => Promise<unknown>>()
jest.mock('#/horizon/session/oauth-client', () => ({
  getOAuthClient: () => ({
    restore: (did: string, refresh?: boolean) => mockRestore(did, refresh),
  }),
}))
jest.mock('#/horizon/session/oauth-transport', () =>
  jest.requireActual('#/horizon/session/oauth-transport.web'),
)
jest.mock('#/horizon/session/session-death', () => ({
  reportOAuthSessionLost: () => {},
}))
jest.mock('#/state/session/moderation', () => ({
  configureModerationForAccount: () => {},
}))

import {type SessionAccount} from '#/state/session/types'
import {isAuthError} from '../auth-errors'
import {oauthAccountFrom} from '../oauth-account'
import {createOAuthSessionBundleAndResume} from '../oauth-bundle-factory.web'
import {getOAuthBundleInfo} from '../oauth-bundles'
import {resetOAuthTransportProbes} from '../oauth-transport.web'

const DID = 'did:plc:resumeaaaaaaaaaaaaaaaaaa'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

function makeSession(fetchHandler: () => Promise<Response>) {
  return {
    did: DID,
    serverMetadata: {issuer: 'https://pds.example'},
    getTokenInfo: () =>
      Promise.resolve({aud: 'https://pds.example', scope: 'atproto'}),
    fetchHandler: jest.fn(fetchHandler),
    signOut: jest.fn(() => Promise.resolve()),
  }
}

function storedAccount(): SessionAccount {
  return {
    ...oauthAccountFrom(
      {issuer: 'https://pds.example', aud: 'https://pds.example'},
      {did: DID, handle: 'alice.test', active: true},
    ),
    oauthSignedOut: true,
  }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  mockRestore.mockReset()
  resetOAuthTransportProbes()
})

describe('the OAuth resume on a switch', () => {
  it('a refused refresh rejects with an auth error', async () => {
    mockRestore.mockImplementation(() =>
      Promise.reject(new Error('The session was revoked')),
    )
    const error = await failure(
      createOAuthSessionBundleAndResume(storedAccount(), true),
    )
    expect(isAuthError(error)).toBe(true)
    // The switch restores with 'auto' (passed as undefined).
    expect(mockRestore).toHaveBeenCalledWith(DID, undefined)
  })

  it('a 401 token error from getSession deletes the session and rejects with an auth error', async () => {
    const session = makeSession(() =>
      Promise.resolve(
        json({error: 'AuthenticationRequired', message: 'revoked'}, 401),
      ),
    )
    mockRestore.mockResolvedValue(session)
    const error = await failure(
      createOAuthSessionBundleAndResume(storedAccount(), true),
    )
    expect(isAuthError(error)).toBe(true)
    expect(session.signOut).toHaveBeenCalled()
  })

  it('a network failure lets the switch proceed with the stored account', async () => {
    const session = makeSession(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    )
    mockRestore.mockResolvedValue(session)
    const {account, bundle} = await createOAuthSessionBundleAndResume(
      storedAccount(),
      true,
    )
    expect(account.did).toBe(DID)
    expect(account.oauthSignedOut).toBeUndefined()
    expect(getOAuthBundleInfo(bundle)?.did).toBe(DID)
    expect(session.signOut).not.toHaveBeenCalled()
  })

  it('a good session takes the fresh account fields from getSession', async () => {
    const session = makeSession(() =>
      Promise.resolve(json({did: DID, handle: 'renamed.test', active: true})),
    )
    mockRestore.mockResolvedValue(session)
    const {account, bundle} = await createOAuthSessionBundleAndResume(
      storedAccount(),
      true,
    )
    expect(account.handle).toBe('renamed.test')
    expect(account.isOauthSession).toBe(true)
    expect(getOAuthBundleInfo(bundle)?.needsAccountRefresh).toBe(false)
  })
})

describe('the OAuth resume at launch', () => {
  it('reads the store without refreshing and asks the server nothing', async () => {
    const session = makeSession(() => Promise.resolve(json({})))
    mockRestore.mockResolvedValue(session)
    const {account, bundle} = await createOAuthSessionBundleAndResume(
      storedAccount(),
      false,
    )
    expect(mockRestore).toHaveBeenCalledWith(DID, false)
    expect(session.fetchHandler).not.toHaveBeenCalled()
    expect(account.oauthSignedOut).toBeUndefined()
    expect(account.pdsUrl).toBe('https://pds.example/')
    expect(getOAuthBundleInfo(bundle)?.needsAccountRefresh).toBe(true)
  })

  it('a missing session rejects with an auth error', async () => {
    mockRestore.mockImplementation(() =>
      Promise.reject(new Error('The session was deleted by another process')),
    )
    const error = await failure(
      createOAuthSessionBundleAndResume(storedAccount(), false),
    )
    expect(isAuthError(error)).toBe(true)
  })
})
