import {type Client} from '@atproto/lex'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import {type SessionAccount} from '#/state/session/types'

/*
 * The OAuth bundle is built by the web factory over the web transport, with
 * a fake OAuth client in place of the browser library (which needs a real
 * browser). The provider mocks mirror the stock provider tests.
 */
const mockRestore =
  jest.fn<(did: string, refresh?: boolean) => Promise<unknown>>()
jest.mock('#/horizon/session/oauth-client', () => ({
  OAUTH_AVAILABLE: true,
  getOAuthClient: () => ({
    restore: (did: string, refresh?: boolean) => mockRestore(did, refresh),
  }),
  addOAuthSessionDeletedListener: () => () => {},
  isOAuthRevocationCause: () => false,
  isOAuthRefreshFailure: () => false,
}))
// System accounts' runtime and announcer: their own suites cover them.
jest.mock('#/horizon/system-accounts/runtime', () => ({
  startSystemAccounts: () => () => {},
}))
jest.mock('#/horizon/session/oauth-transport', () =>
  jest.requireActual('#/horizon/session/oauth-transport.web'),
)
const mockOAuthLogin = jest.fn<(session: unknown) => Promise<unknown>>()
jest.mock('#/horizon/session/oauth-bundle-factory', () => ({
  ...jest.requireActual<object>('#/horizon/session/oauth-bundle-factory.web'),
  createOAuthSessionBundleAndLogin: (session: unknown) =>
    mockOAuthLogin(session),
}))
jest.mock('#/state/persisted', () => {
  const {
    defaults,
  }: typeof import('#/state/persisted/schema') = require('#/state/persisted/schema')
  return {
    defaults,
    get: (key: keyof typeof defaults) => defaults[key],
    write: () => Promise.resolve(),
    readLatest: (key: keyof typeof defaults) => defaults[key],
    onUpdate: () => () => {},
  }
})
jest.mock('#/state/util', () => ({useCloseAllActiveElements: () => () => {}}))
jest.mock('#/components/dialogs/Context', () => ({
  useGlobalDialogsControlContext: () => ({signinDialogControl: {open() {}}}),
}))
jest.mock('#/analytics', () => ({
  AnalyticsContext: ({children}: {children: React.ReactNode}) => children,
  useAnalyticsBase: () => ({metric() {}, logger: {debug() {}, error() {}}}),
  utils: {accountToSessionMetadata: () => ({}), useMeta: () => undefined},
  features: {refresh: () => Promise.resolve()},
}))
jest.mock('#/state/shell/onboarding', () => ({
  useOnboardingDispatch: () => () => {},
}))
jest.mock('#/ageAssurance/data', () => ({
  clearAgeAssuranceServerDataForAll: () => {},
  clearAgeAssuranceServerDataForDid: () => {},
  prefetchAgeAssuranceServerData: () => Promise.resolve(),
}))
jest.mock('#/lib/persisted-query-storage', () => ({
  clearPersistedQueryStorage: () => Promise.resolve(),
}))
jest.mock('#/lib/notifications/notifications', () => ({
  unregisterPushToken: () => Promise.resolve(),
}))
jest.mock('#/state/session/create-account', () => ({
  createSessionBundleAndCreateAccount: () => new Promise(() => {}),
}))
jest.mock('#/state/session/moderation', () => ({
  configureModerationForAccount: () => {},
  configureModerationForGuest: () => {},
}))
jest.mock('#/state/events', () => ({
  emitSessionDropped: () => {},
  emitNetworkConfirmed: () => {},
  emitNetworkLost: () => {},
}))

import {Provider, useMaybePdsClient} from '#/state/session'
import {createPublicSessionBundle} from '#/state/session/session-core'
import {com} from '#/lexicons'
import {
  type HorizonSessionApi,
  useHorizonSessionApi,
} from '../HorizonSessionProvider'
import {oauthAccountFrom} from '../oauth-account'
import {createOAuthBundle} from '../oauth-bundle-factory.web'
import {disposeOAuthBundle, isSignedInBundle} from '../oauth-bundles'

const DID = 'did:plc:oauthaaaaaaaaaaaaaaaaaaa'

function fakeSession() {
  return {
    did: DID,
    sub: DID,
    serverMetadata: {issuer: 'https://pds.example'},
    getTokenInfo: () =>
      Promise.resolve({aud: 'https://pds.example', scope: 'atproto'}),
    fetchHandler: jest.fn((_path: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({did: DID, handle: 'alice.test'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
      ),
    ),
    signOut: jest.fn(() => Promise.resolve()),
  }
}

function account(): SessionAccount {
  return oauthAccountFrom(
    {issuer: 'https://pds.example', aud: 'https://pds.example'},
    {did: DID, handle: 'alice.test'},
  )
}

beforeEach(() => {
  mockRestore.mockReset()
  mockOAuthLogin.mockReset()
})

describe('OAuth bundles', () => {
  it('isSignedInBundle knows all three kinds', () => {
    const oauth = createOAuthBundle({did: DID, service: 'https://pds.example'})
    expect(isSignedInBundle(oauth)).toBe(true)
    expect(isSignedInBundle(createPublicSessionBundle())).toBe(false)
    expect(isSignedInBundle({session: {}})).toBe(true)
  })

  it('sends a request through the stored session for the DID', async () => {
    const session = fakeSession()
    mockRestore.mockResolvedValue(session)
    const bundle = createOAuthBundle({did: DID, service: 'https://pds.example'})
    const data = await bundle.pdsClient.call(com.atproto.server.getSession, {})
    expect(data.handle).toBe('alice.test')
    // 'auto' is passed to the browser client as `undefined`.
    expect(mockRestore).toHaveBeenCalledWith(DID, undefined)
    expect(session.fetchHandler).toHaveBeenCalledTimes(1)
  })

  it('a disposed bundle throws before any I/O', async () => {
    const session = fakeSession()
    mockRestore.mockResolvedValue(session)
    const bundle = createOAuthBundle({did: DID, service: 'https://pds.example'})
    expect(disposeOAuthBundle(bundle)).toBe(true)
    await expect(
      bundle.pdsClient.call(com.atproto.server.getSession, {}),
    ).rejects.toThrow()
    expect(mockRestore).not.toHaveBeenCalled()
    expect(session.fetchHandler).not.toHaveBeenCalled()
  })

  it('disposeOAuthBundle ignores any other bundle', () => {
    expect(disposeOAuthBundle(createPublicSessionBundle())).toBe(false)
  })

  it('useMaybePdsClient serves the PDS client of an OAuth bundle', async () => {
    let api!: HorizonSessionApi
    let maybePds: Client | null = null
    function Probe() {
      api = useHorizonSessionApi()
      maybePds = useMaybePdsClient()
      return null
    }
    render(
      <Provider>
        <Probe />
      </Provider>,
    )
    expect(maybePds).toBeNull()

    const bundle = createOAuthBundle({did: DID, service: 'https://pds.example'})
    mockOAuthLogin.mockResolvedValueOnce({bundle, account: account()})
    await act(async () => {
      await api.loginWithOAuth(fakeSession() as never)
    })
    expect(maybePds).toBe(bundle.pdsClient)
  })
})
