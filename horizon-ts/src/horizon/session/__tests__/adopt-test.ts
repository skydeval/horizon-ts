import {beforeEach, describe, expect, it, jest} from '@jest/globals'

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
  unregisterPushToken: () => Promise.resolve(),
}))
jest.mock('#/state/session/util', () => ({
  createTemporaryClientsAndResume: () => Promise.resolve([]),
}))
const mockOAuthResume =
  jest.fn<(account: unknown, isSwitching: boolean) => Promise<unknown>>()
jest.mock('#/horizon/session/oauth-bundle-factory', () => ({
  createOAuthSessionBundleAndResume: (account: unknown, isSwitching: boolean) =>
    mockOAuthResume(account, isSwitching),
}))

import {
  type Action,
  getInitialState,
  reducer,
  type State,
} from '#/state/session/reducer'
import {type SessionAccount} from '#/state/session/types'
import {adoptOAuthAccount} from '../adopt'
import {oauthAccountFrom} from '../oauth-account'
import {registerOAuthBundle} from '../oauth-bundles'

const DID = 'did:plc:adoptaaaaaaaaaaaaaaaaaaa'

function oauthAccount(): SessionAccount {
  return oauthAccountFrom(
    {issuer: 'https://pds.example', aud: 'https://pds.example'},
    {did: DID, handle: 'alice.test'},
  )
}

function makeStore(initial: State) {
  let state = initial
  const dispatched: Action[] = []
  return {
    dispatched,
    getState: () => state,
    dispatch: (action: Action) => {
      dispatched.push(action)
      state = reducer(state, action)
    },
  }
}

function oauthBundle() {
  const bundle = {session: null, service: new URL('https://pds.example')}
  registerOAuthBundle(bundle, {
    did: DID,
    kill: () => {},
    needsAccountRefresh: false,
  })
  return bundle
}

beforeEach(() => {
  mockOAuthResume.mockReset()
})

describe('adoptOAuthAccount', () => {
  it('a tab on a password bundle for the DID adopts the OAuth account without a persisted write', async () => {
    const passwordBundle = {
      session: {},
      service: new URL('https://pds.example'),
    }
    const passwordAccount = {
      ...oauthAccount(),
      isOauthSession: undefined,
      refreshJwt: 'r',
      accessJwt: 'a',
    }
    const store = makeStore(
      reducer(getInitialState([]), {
        type: 'switched-to-account',
        newBundle: passwordBundle,
        newAccount: passwordAccount,
      }),
    )
    const adopted = oauthBundle()
    mockOAuthResume.mockResolvedValue({
      bundle: adopted,
      account: oauthAccount(),
    })

    await adoptOAuthAccount(store, oauthAccount(), () => {})

    expect(mockOAuthResume).toHaveBeenCalledWith(
      expect.objectContaining({did: DID}),
      false,
    )
    expect(store.dispatched).toHaveLength(1)
    expect(store.dispatched[0].type).toBe('replaced-current-bundle')
    expect(store.getState().currentBundleState.bundle).toBe(adopted)
    expect(store.getState().needsPersist).toBe(false)
    expect(store.getState().accounts[0].isOauthSession).toBe(true)
  })

  it('a tab already on an OAuth bundle for the DID does nothing', async () => {
    const current = oauthBundle()
    const store = makeStore(
      reducer(getInitialState([]), {
        type: 'switched-to-account',
        newBundle: current,
        newAccount: oauthAccount(),
      }),
    )
    store.dispatched.length = 0

    await adoptOAuthAccount(store, oauthAccount(), () => {})

    expect(mockOAuthResume).not.toHaveBeenCalled()
    expect(store.dispatched).toHaveLength(0)
  })

  it('a failed restore leaves the tab as it is', async () => {
    const passwordBundle = {
      session: {},
      service: new URL('https://pds.example'),
    }
    const store = makeStore(
      reducer(getInitialState([]), {
        type: 'switched-to-account',
        newBundle: passwordBundle,
        newAccount: {...oauthAccount(), isOauthSession: undefined},
      }),
    )
    store.dispatched.length = 0
    mockOAuthResume.mockRejectedValue(new Error('Failed to fetch'))

    await adoptOAuthAccount(store, oauthAccount(), () => {})

    expect(store.dispatched).toHaveLength(0)
    expect(store.getState().currentBundleState.bundle).toBe(passwordBundle)
  })
})
