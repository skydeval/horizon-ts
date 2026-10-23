import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {act, render} from '@testing-library/react-native'

/*
 * The OAuth library's lock, played by an exclusive in-memory lock manager,
 * and a stored-session read that takes it the way the library does. "The
 * other document" (a Horizon page frozen in the back/forward cache) holds the
 * lock until the test releases it.
 */
class FakeLocks {
  private held = new Set<string>()
  private queues = new Map<string, Array<() => void>>()

  request<T>(
    name: string,
    options: {mode?: string; signal?: AbortSignal},
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(name) ?? []
      this.queues.set(name, queue)
      const onAbort = () => {
        const index = queue.indexOf(grant)
        if (index === -1) return
        queue.splice(index, 1)
        reject(new Error('AbortError'))
      }
      const grant = () => {
        options.signal?.removeEventListener('abort', onAbort)
        this.held.add(name)
        void (async () => {
          let failed = false
          let value: T | undefined
          let error: unknown
          try {
            value = await callback()
          } catch (e) {
            failed = true
            error = e
          }
          this.held.delete(name)
          this.next(name)
          if (failed)
            reject(error instanceof Error ? error : new Error(String(error)))
          else resolve(value as T)
        })()
      }
      options.signal?.addEventListener('abort', onAbort)
      queue.push(grant)
      this.next(name)
    })
  }

  /** Drop every holder and waiter (between tests). */
  reset() {
    this.held.clear()
    this.queues.clear()
  }

  private next(name: string) {
    if (this.held.has(name)) return
    this.queues.get(name)?.shift()?.()
  }
}

const locks = new FakeLocks()
const nav: object = (globalThis as {navigator?: object}).navigator ?? {}
Object.defineProperty(nav, 'locks', {value: locks, configurable: true})
if (!(globalThis as {navigator?: object}).navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    value: nav,
    configurable: true,
  })
}

const DID = 'did:plc:busyaaaaaaaaaaaaaaaaaaaa'
const LOCK = `@atproto-oauth-client-${DID}`

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

const session = {
  did: DID,
  serverMetadata: {issuer: 'https://pds.example'},
  getTokenInfo: () =>
    Promise.resolve({aud: 'https://pds.example', scope: 'atproto'}),
  fetchHandler: () =>
    Promise.resolve(json({did: DID, handle: 'alice.test', active: true})),
  signOut: () => Promise.resolve(),
}

const mockRestore = jest.fn((did: string, _refresh?: boolean) =>
  locks.request(
    `@atproto-oauth-client-${did}`,
    {mode: 'exclusive'},
    () => session,
  ),
)
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
const mockToast = jest.fn<(content: unknown, options?: unknown) => void>()
jest.mock('#/components/Toast', () => ({
  show: (content: unknown, options?: unknown) => mockToast(content, options),
}))

/* The account chooser's surroundings. */
let mockSelect: ((account: unknown) => void) | undefined
jest.mock('#/components/AccountList', () => ({
  AccountList: ({
    onSelectAccount,
  }: {
    onSelectAccount: (account: unknown) => void
  }) => {
    mockSelect = onSelectAccount
    return null
  },
}))
jest.mock('#/screens/Login/FormContainer', () => ({
  FormContainer: ({children}: {children: React.ReactNode}) => children,
}))
jest.mock('#/components/Button', () => ({
  Button: () => null,
  ButtonText: () => null,
}))
jest.mock('#/components/forms/TextField', () => ({LabelText: () => null}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  web: () => ({}),
}))
jest.mock('#/analytics', () => ({useAnalytics: () => ({metric: () => {}})}))
jest.mock('@lingui/react', () => ({
  useLingui: () => ({_: (value: {message?: string}) => value.message}),
  Trans: () => null,
}))
const mockResume =
  jest.fn<(account: unknown, switching?: boolean) => Promise<void>>()
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
  useSessionApi: () => ({resumeSession: mockResume}),
}))
jest.mock('#/state/shell/logged-out', () => ({
  useLoggedOutViewControls: () => ({setShowLoggedOut: () => {}}),
}))

import {type SessionAccount} from '#/state/session/types'
import {ChooseAccountForm} from '#/screens/Login/ChooseAccountForm'
import {OAuthSessionBusyError} from '../auth-errors'
import {oauthAccountFrom} from '../oauth-account'
import {
  createOAuthSessionBundleAndResume,
  OAUTH_LAUNCH_WAIT_MS,
} from '../oauth-bundle-factory.web'
import {oauthBusyMessage, OAuthBusyNotice} from '../oauth-busy-notice'
import {resetOAuthBusyReport} from '../oauth-busy-report'
import {oauthLockName} from '../oauth-lock'
import {
  resetOAuthTransportProbes,
  restoreOAuthSession,
} from '../oauth-transport.web'

i18n.loadAndActivate({locale: 'en', messages: {}})

function storedAccount(): SessionAccount {
  return oauthAccountFrom(
    {issuer: 'https://pds.example', aud: 'https://pds.example'},
    {did: DID, handle: 'alice.test', active: true},
  )
}

/** The other document takes the lock; returns its release. */
function holdLockElsewhere() {
  let release: () => void = () => {}
  void locks.request(LOCK, {mode: 'exclusive'}, () => {
    return new Promise<void>(resolve => {
      release = resolve
    })
  })
  return () => release()
}

/** Track a promise's outcome without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: {done: boolean; value?: T; error?: unknown} = {done: false}
  promise.then(
    value => {
      state.done = true
      state.value = value
    },
    error => {
      state.done = true
      state.error = error
    },
  )
  return state
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockRestore.mockClear()
  mockToast.mockReset()
  mockResume.mockReset()
  mockResume.mockImplementation(async (account, switching) => {
    await createOAuthSessionBundleAndResume(
      account as SessionAccount,
      !!switching,
    )
  })
  mockSelect = undefined
  resetOAuthBusyReport()
  locks.reset()
  resetOAuthTransportProbes()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('the OAuth library lock', () => {
  it('is the name the library takes', () => {
    expect(oauthLockName(DID)).toBe(LOCK)
  })
})

describe('a restore queued behind a stuck one', () => {
  it('moves on after the wait instead of queueing forever', async () => {
    const release = holdLockElsewhere()
    const first = track(restoreOAuthSession(DID, false))
    await advance(0)
    expect(mockRestore).toHaveBeenCalledTimes(1)
    const second = track(restoreOAuthSession(DID, false))
    await advance(9_000)
    expect(mockRestore).toHaveBeenCalledTimes(1)
    await advance(1_000)
    // The second reached the library, where its lock serializes it.
    expect(mockRestore).toHaveBeenCalledTimes(2)
    expect(first.done || second.done).toBe(false)
    release()
    await advance(0)
    expect(first.value).toBe(session)
    expect(second.value).toBe(session)
  })
})

describe('a launch that finds the session busy', () => {
  it('keeps waiting, then resumes when the lock frees', async () => {
    const release = holdLockElsewhere()
    const launch = track(
      createOAuthSessionBundleAndResume(storedAccount(), false),
    )
    await advance(10_000)
    // Past the usual wait: not settled into signed out.
    expect(launch.done).toBe(false)
    await advance(20_000)
    expect(launch.done).toBe(false)
    release()
    await advance(0)
    expect(launch.error).toBeUndefined()
    expect(launch.value?.account.did).toBe(DID)
    expect(
      mockRestore.mock.calls.every(([, refresh]) => refresh === false),
    ).toBe(true)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('gives up busy after the launch wait and says why once the app shows', async () => {
    holdLockElsewhere()
    const launch = track(
      createOAuthSessionBundleAndResume(storedAccount(), false),
    )
    await advance(OAUTH_LAUNCH_WAIT_MS - 1_000)
    expect(launch.done).toBe(false)
    await advance(1_000)
    expect(launch.error).toBeInstanceOf(OAuthSessionBusyError)
    expect(mockToast).not.toHaveBeenCalled()
    render(<OAuthBusyNotice />)
    expect(mockToast).toHaveBeenCalledWith(oauthBusyMessage(), {
      type: 'warning',
    })
  })
})

describe('the account chooser with a busy session', () => {
  it('says the session is busy, stays put, and a retry signs in once the lock frees', async () => {
    const release = holdLockElsewhere()
    const onSelectAccount = jest.fn()
    render(
      <ChooseAccountForm
        onSelectAccount={onSelectAccount}
        onPressBack={() => {}}
      />,
    )
    expect(mockSelect).toBeDefined()

    act(() => {
      mockSelect?.(storedAccount())
    })
    await advance(10_000)
    expect(mockToast).toHaveBeenCalledWith(oauthBusyMessage(), {
      type: 'warning',
    })
    // Not dropped to the login form.
    expect(onSelectAccount).not.toHaveBeenCalled()

    release()
    await advance(0)
    mockToast.mockReset()
    act(() => {
      mockSelect?.(storedAccount())
    })
    await advance(0)
    expect(mockResume).toHaveBeenCalledTimes(2)
    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(String(mockToast.mock.calls[0][0])).toContain('Signed in as')
    expect(onSelectAccount).not.toHaveBeenCalled()
  })
})
