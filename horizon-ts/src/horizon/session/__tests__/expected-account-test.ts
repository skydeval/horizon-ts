import {type OAuthSession} from '@atproto/oauth-client-browser'

import {
  AccountMismatchError,
  assertExpectedAccount,
  decodeExpectedDidState,
  encodeExpectedDidState,
  resolveExpectedDid,
} from '#/horizon/session/expected-account'

const mockResolve = jest.fn()

jest.mock('#/horizon/session/oauth-client', () => ({
  getOAuthClient: () => ({identityResolver: {resolve: mockResolve}}),
}))

const ASKED = 'did:plc:asked'
const OTHER = 'did:plc:other'

function fakeSession(did: string) {
  const signOut = jest.fn(() => Promise.resolve())
  return {session: {did, signOut} as unknown as OAuthSession, signOut}
}

beforeEach(() => {
  mockResolve.mockReset()
  mockResolve.mockImplementation((value: string) =>
    Promise.resolve({
      did: value.startsWith('did:') ? value : ASKED,
      handle: value === OTHER ? 'other.test' : 'asked.test',
    }),
  )
})

describe('resolveExpectedDid', () => {
  it('resolves a handle to its DID', async () => {
    await expect(resolveExpectedDid('asked.test')).resolves.toBe(ASKED)
  })

  it('takes a DID as it is', async () => {
    await expect(resolveExpectedDid(OTHER)).resolves.toBe(OTHER)
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('expects no account for a server address', async () => {
    await expect(
      resolveExpectedDid('https://locus.example'),
    ).resolves.toBeUndefined()
  })

  it('expects no account when resolution fails', async () => {
    mockResolve.mockRejectedValueOnce(new Error('nope'))
    await expect(resolveExpectedDid('missing.test')).resolves.toBeUndefined()
  })
})

describe('the expected-DID state', () => {
  it('round-trips', () => {
    expect(decodeExpectedDidState(encodeExpectedDidState(ASKED))).toBe(ASKED)
  })

  it('carries nothing without an expectation', () => {
    expect(encodeExpectedDidState(undefined)).toBeUndefined()
    expect(decodeExpectedDidState(null)).toBeUndefined()
    expect(decodeExpectedDidState('not json')).toBeUndefined()
  })
})

describe('assertExpectedAccount', () => {
  it('accepts the account that was asked for', async () => {
    const {session, signOut} = fakeSession(ASKED)
    await expect(
      assertExpectedAccount(session, ASKED, () => false),
    ).resolves.toBeUndefined()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('accepts any account when none was asked for', async () => {
    const {session} = fakeSession(OTHER)
    await expect(
      assertExpectedAccount(session, undefined, () => false),
    ).resolves.toBeUndefined()
  })

  it('refuses a different account and signs its session out', async () => {
    const {session, signOut} = fakeSession(OTHER)
    const error = await assertExpectedAccount(session, ASKED, () => false).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AccountMismatchError)
    expect(error).toMatchObject({
      expectedDid: ASKED,
      actualDid: OTHER,
      expectedHandle: 'asked.test',
      actualHandle: 'other.test',
    })
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('keeps the session of an account Horizon already holds', async () => {
    const {session, signOut} = fakeSession(OTHER)
    await expect(
      assertExpectedAccount(session, ASKED, did => did === OTHER),
    ).rejects.toBeInstanceOf(AccountMismatchError)
    expect(signOut).not.toHaveBeenCalled()
  })
})
