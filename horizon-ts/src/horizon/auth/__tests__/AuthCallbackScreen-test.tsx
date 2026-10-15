import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

/*
 * A page and its history on `window`, and every collaborator of the screen
 * mocked, so the test sees only the order of URL replacement and login.
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

const events: string[] = []
const storage = new MemoryStorage()
const page = {
  origin: 'http://127.0.0.1:8081',
  pathname: '/auth/web/callback',
  search: '',
  hash: '',
  href: 'http://127.0.0.1:8081/auth/web/callback',
}
const fakeHistory = {
  replaceState: (_data: unknown, _unused: string, url: string) => {
    events.push(`url:${url}`)
  },
}
const host: object = (globalThis as {window?: object}).window ?? globalThis
Object.defineProperty(host, 'sessionStorage', {
  value: storage,
  configurable: true,
})
Object.defineProperty(host, 'location', {value: page, configurable: true})
Object.defineProperty(globalThis, 'history', {
  value: fakeHistory,
  configurable: true,
})

jest.mock('#/horizon/session/oauth-return-url', () =>
  jest.requireActual('#/horizon/session/oauth-return-url.web'),
)
jest.mock('#/horizon/session/oauth-callback', () =>
  jest.requireActual('#/horizon/session/oauth-callback.web'),
)
const mockInitCallback =
  jest.fn<(params: URLSearchParams) => Promise<unknown>>()
jest.mock('#/horizon/session/oauth-client', () => ({
  getOAuthClient: () => ({
    initCallback: (params: URLSearchParams) => mockInitCallback(params),
  }),
}))
const mockLoginWithOAuth = jest.fn<(session: unknown) => Promise<void>>()
jest.mock('#/horizon/session/HorizonSessionProvider', () => ({
  useHorizonSessionApi: () => ({loginWithOAuth: mockLoginWithOAuth}),
}))
const mockNavigation = {replace: jest.fn(), dispatch: jest.fn()}
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  StackActions: {replace: (name: string, params: unknown) => ({name, params})},
}))
const mockResume = jest.fn<(account: unknown) => Promise<void>>()
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: []}),
  useSessionApi: () => ({resumeSession: mockResume}),
}))
jest.mock('#/state/session/util', () => ({
  readLastActiveAccount: () => undefined,
}))
const mockShowLoggedOut = jest.fn()
const mockRequestSwitch = jest.fn()
jest.mock('#/state/shell/logged-out', () => ({
  useLoggedOutViewControls: () => ({
    setShowLoggedOut: mockShowLoggedOut,
    requestSwitchToAccount: mockRequestSwitch,
  }),
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
}))
jest.mock('#/components/Loader', () => ({Loader: () => null}))
jest.mock('#/components/Typography', () => ({Text: () => null}))
jest.mock('@lingui/react', () => ({
  useLingui: () => ({_: (value: {message?: string}) => value.message}),
  Trans: () => null,
}))

import {AuthCallbackScreen} from '../AuthCallbackScreen'

/** Mount the screen and let its effect run to completion. */
async function renderScreen() {
  render(<AuthCallbackScreen />)
  await act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
}

beforeEach(() => {
  events.length = 0
  storage.clear()
  page.pathname = '/auth/web/callback'
  page.hash = ''
  mockInitCallback.mockReset()
  mockLoginWithOAuth.mockReset()
  mockNavigation.replace.mockReset()
  mockNavigation.dispatch.mockReset()
  mockResume.mockReset()
  mockShowLoggedOut.mockReset()
  mockRequestSwitch.mockReset()
})

describe('AuthCallbackScreen', () => {
  it('replaces the URL with the saved return URL before logging in', async () => {
    storage.setItem(
      'horizon.oauth.returnUrl',
      'http://127.0.0.1:8081/profile/alice.test',
    )
    page.hash = '#state=abc&code=def'
    const session = {did: 'did:plc:aaaa'}
    mockInitCallback.mockImplementation(() => {
      page.hash = '' // the library clears the parameters
      return Promise.resolve({session, state: null})
    })
    mockLoginWithOAuth.mockImplementation(() => {
      events.push('login')
      return Promise.resolve()
    })

    await renderScreen()

    expect(events).toEqual(['url:/profile/alice.test', 'login'])
    expect(mockLoginWithOAuth).toHaveBeenCalledWith(session)
    expect(mockShowLoggedOut).toHaveBeenCalledWith(false)
  })

  it('goes to / when no return URL was saved', async () => {
    page.hash = '#state=abc&code=def'
    mockInitCallback.mockResolvedValue({session: {}, state: null})
    mockLoginWithOAuth.mockImplementation(() => {
      events.push('login')
      return Promise.resolve()
    })
    await renderScreen()
    expect(events).toEqual(['url:/', 'login'])
  })

  it('a remount without callback parameters goes Home and does not log in again', async () => {
    page.hash = '#state=abc&code=def'
    mockInitCallback.mockImplementation(() => {
      page.hash = ''
      return Promise.resolve({session: {}, state: null})
    })
    mockLoginWithOAuth.mockResolvedValue()
    await renderScreen()
    await renderScreen()
    expect(mockLoginWithOAuth).toHaveBeenCalledTimes(1)
    expect(mockInitCallback).toHaveBeenCalledTimes(1)
    expect(mockNavigation.replace).toHaveBeenCalledWith('Home')
  })

  it('ignores the popup hand-off', async () => {
    page.hash = '#state=abc&code=def'
    mockInitCallback.mockRejectedValue(
      Object.assign(new Error('done'), {
        code: 'LOGIN_CONTINUED_IN_PARENT_WINDOW',
      }),
    )
    await renderScreen()
    expect(mockLoginWithOAuth).not.toHaveBeenCalled()
    expect(mockRequestSwitch).not.toHaveBeenCalled()
    expect(storage.getItem('horizon.oauth.callbackError')).toBeNull()
  })

  it('on failure keeps the error for the form and opens the sign-in form', async () => {
    page.hash = '#state=abc&error=access_denied'
    mockInitCallback.mockRejectedValue(new Error('Access denied'))
    await renderScreen()
    expect(mockLoginWithOAuth).not.toHaveBeenCalled()
    // A cancel at the server (`access_denied`) reads as a cancelled sign-in.
    expect(storage.getItem('horizon.oauth.callbackError')).toBe(
      'Sign-in was cancelled.',
    )
    expect(mockRequestSwitch).toHaveBeenCalledWith({requestedAccount: 'none'})
    expect(mockNavigation.dispatch).toHaveBeenCalled()
  })
})
