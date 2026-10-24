import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {render} from '@testing-library/react-native'

/*
 * The pending sign-in record lives in the web `sessionStorage`; a small
 * in-memory stand-in and a page URL are installed on `window` here.
 */
class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  clear() {
    this.values.clear()
  }
}

const storage = new MemoryStorage()
const page = {
  origin: 'http://127.0.0.1:8081',
  pathname: '/',
  search: '',
  hash: '',
  href: 'http://127.0.0.1:8081/',
}
const host: object = (globalThis as {window?: object}).window ?? globalThis
Object.defineProperty(host, 'sessionStorage', {
  value: storage,
  configurable: true,
})
Object.defineProperty(host, 'location', {value: page, configurable: true})

jest.mock('#/horizon/session/oauth-return-url', () =>
  jest.requireActual('#/horizon/session/oauth-return-url.web'),
)
const mockInitCallback =
  jest.fn<(params: URLSearchParams) => Promise<unknown>>()
jest.mock('#/horizon/session/oauth-client', () => ({
  getOAuthClient: () => ({
    initCallback: (params: URLSearchParams) => mockInitCallback(params),
  }),
}))
jest.mock('#/horizon/session/oauth-callback', () => ({
  isOAuthCallbackLoad: () => false,
}))
const mockRequestSwitch =
  jest.fn<(props: {requestedAccount?: string}) => void>()
jest.mock('#/state/shell/logged-out', () => ({
  useLoggedOutViewControls: () => ({requestSwitchToAccount: mockRequestSwitch}),
}))
const mockSession = {
  accounts: [] as {did: string; handle: string}[],
  hasSession: false,
}
jest.mock('#/state/session', () => ({
  useSession: () => mockSession,
}))
const mockToast = jest.fn()
jest.mock('#/components/Toast', () => ({
  show: (...args: unknown[]) => mockToast(...args),
  Outer: () => null,
  Icon: () => null,
  Text: () => null,
  Action: () => null,
}))
jest.mock('@lingui/react', () => ({
  useLingui: () => ({
    _: (value: {message?: string; id?: string}) => value.message ?? value.id,
  }),
  Trans: () => null,
}))

import {
  getStalledSignIn,
  setStalledSignIn,
} from '#/horizon/auth/sign-in-notices'
import {
  resetStalledSignInCheck,
  StalledSignInCheck,
} from '#/horizon/auth/StalledSignInCheck'
import {completeWebOAuth} from '../oauth-callback.web'
import {
  PENDING_SIGN_IN_MAX_AGE_MS,
  savePendingSignIn,
  takePendingSignIn,
} from '../oauth-return-url.web'

beforeEach(() => {
  storage.clear()
  page.pathname = '/'
  page.hash = ''
  page.search = ''
  resetStalledSignInCheck()
  setStalledSignIn(undefined)
  mockRequestSwitch.mockReset()
  mockToast.mockReset()
  mockInitCallback.mockReset()
  mockSession.accounts = []
  mockSession.hasSession = false
})

describe('the pending sign-in record', () => {
  it('is returned while fresh, and only once', () => {
    savePendingSignIn('alice.test', 1_000)
    expect(takePendingSignIn(1_000 + 5 * 60_000)).toEqual({
      identifier: 'alice.test',
      startedAt: 1_000,
    })
    expect(takePendingSignIn(1_000 + 5 * 60_000)).toBeUndefined()
  })

  it('an old record is dropped', () => {
    savePendingSignIn('alice.test', 1_000)
    expect(
      takePendingSignIn(1_000 + PENDING_SIGN_IN_MAX_AGE_MS + 1),
    ).toBeUndefined()
    expect(storage.getItem('horizon.oauth.pendingSignIn')).toBeNull()
  })

  it('a callback clears it', async () => {
    savePendingSignIn('alice.test')
    page.pathname = '/auth/web/callback'
    page.hash = '#state=abc&code=def'
    const session = {did: 'did:plc:aaaa'}
    mockInitCallback.mockResolvedValue({session, state: null})
    const login = jest.fn((_session: unknown, _state?: unknown) =>
      Promise.resolve(),
    )
    await expect(completeWebOAuth(login)).resolves.toBe(true)
    expect(login).toHaveBeenCalledWith(session, null)
    expect(storage.getItem('horizon.oauth.pendingSignIn')).toBeNull()
  })

  it('a failed callback clears it too', async () => {
    savePendingSignIn('alice.test')
    page.pathname = '/auth/web/callback'
    page.hash = '#state=abc&error=access_denied'
    mockInitCallback.mockRejectedValue(new Error('access_denied'))
    await expect(completeWebOAuth(() => Promise.resolve())).rejects.toThrow()
    expect(storage.getItem('horizon.oauth.pendingSignIn')).toBeNull()
  })
})

describe('the launch check', () => {
  it('signed out with a fresh record, opens the sign-in form with the notice', () => {
    savePendingSignIn('alice.test')
    render(<StalledSignInCheck />)
    expect(mockRequestSwitch).toHaveBeenCalledWith({requestedAccount: 'none'})
    expect(getStalledSignIn()?.identifier).toBe('alice.test')
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('opens the form for a known account when the identifier matches it', () => {
    mockSession.accounts = [{did: 'did:plc:alice', handle: 'alice.test'}]
    savePendingSignIn('alice.test')
    render(<StalledSignInCheck />)
    expect(mockRequestSwitch).toHaveBeenCalledWith({
      requestedAccount: 'did:plc:alice',
    })
  })

  it('signed in, shows a toast instead', () => {
    mockSession.hasSession = true
    savePendingSignIn('alice.test')
    render(<StalledSignInCheck />)
    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(mockRequestSwitch).not.toHaveBeenCalled()
  })

  it('an old record does nothing', () => {
    savePendingSignIn('alice.test', Date.now() - PENDING_SIGN_IN_MAX_AGE_MS - 1)
    render(<StalledSignInCheck />)
    expect(mockRequestSwitch).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
    expect(getStalledSignIn()).toBeUndefined()
  })

  it('runs once per page load', () => {
    savePendingSignIn('alice.test')
    render(<StalledSignInCheck />)
    savePendingSignIn('alice.test')
    render(<StalledSignInCheck />)
    expect(mockRequestSwitch).toHaveBeenCalledTimes(1)
  })
})
