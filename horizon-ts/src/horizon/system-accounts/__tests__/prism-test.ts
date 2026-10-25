import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; lex input checks need the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * The system-account calls' transport (system accounts design SA-18, 5.2;
 * 18 "Transport"): every call goes direct to prism, never with
 * `atproto-proxy`; writes and the proof take one-shot tokens (no `exp`,
 * never cached); in the one-shot mode a 401 is not resent with the same
 * body, and the add's retry carries a newly minted proof (SAR3-N5).
 */
type Sent = {url: URL; headers: Headers; body: string}
const mockPrismCalls: Sent[] = []
let mockPrismAnswer: (call: Sent) => Response = () => json({rev: 1})

jest.mock('#/state/session/network', () => ({
  networkAwareFetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    }
    mockPrismCalls.push(call)
    return Promise.resolve(mockPrismAnswer(call))
  },
}))
jest.mock('#/state/session', () => ({useMaybePdsClient: () => null}))
jest.mock('#/horizon/routing/write-route', () => ({
  getWriteRoute: () => ({postingRoute: 'none'}),
  subscribeWriteRoutes: () => () => {},
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))

import {type Client} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'

import {createLexClient} from '#/lib/lexClient'
import {PRISM_URL} from '#/horizon/routing/prism'
import {resetDirectPrism} from '#/horizon/routing/prism-direct'
import {
  CONFIRM_SYSTEM_ACCOUNT_LXM,
  resetSystemAccountsLimits,
  systemAccountsApi,
  SystemAccountsError,
} from '../prism'

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' as DidString
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' as DidString

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

type Mint = {did: string; lxm: string | null; exp: string | null}
let mints: Mint[] = []

function pdsClientFor(did: DidString): Client {
  return createLexClient(
    {
      did,
      fetchHandler: (path: string) => {
        const url = new URL(path, 'https://pds.example')
        if (url.pathname !== '/xrpc/com.atproto.server.getServiceAuth') {
          return Promise.resolve(json({error: 'Unexpected'}, 500))
        }
        mints.push({
          did,
          lxm: url.searchParams.get('lxm'),
          exp: url.searchParams.get('exp'),
        })
        return Promise.resolve(json({token: `token-${did}-${mints.length}`}))
      },
    },
    {appLabelers: null},
  )
}

beforeEach(() => {
  mockPrismCalls.length = 0
  mints = []
  mockPrismAnswer = () => json({rev: 1})
  resetDirectPrism()
  resetSystemAccountsLimits()
})

describe('the system-account transport', () => {
  it('the add goes direct to prism with a one-shot bearer and the added account’s proof, neither with `exp`', async () => {
    const api = systemAccountsApi()
    const a = pdsClientFor(A)
    const b = pdsClientFor(B)
    await api.addSystemAccount(a, B, () => api.mintProof(b))
    expect(mints).toEqual([
      {did: B, lxm: CONFIRM_SYSTEM_ACCOUNT_LXM, exp: null},
      {did: A, lxm: 'app.nearhorizon.account.addSystemAccount', exp: null},
    ])
    expect(mockPrismCalls).toHaveLength(1)
    const [call] = mockPrismCalls
    expect(call.url.origin).toBe(new URL(PRISM_URL).origin)
    expect(call.url.pathname).toBe(
      '/xrpc/app.nearhorizon.account.addSystemAccount',
    )
    expect(call.headers.has('atproto-proxy')).toBe(false)
    expect(call.headers.get('authorization')).toBe(`Bearer token-${A}-2`)
    expect(JSON.parse(call.body)).toEqual({account: B, proof: `token-${B}-1`})
  })

  it('write tokens are never cached: two removes mint twice', async () => {
    const api = systemAccountsApi()
    const a = pdsClientFor(A)
    await api.removeSystemAccount(a, B)
    await api.removeSystemAccount(a, B)
    expect(mints.map(m => m.lxm)).toEqual([
      'app.nearhorizon.account.removeSystemAccount',
      'app.nearhorizon.account.removeSystemAccount',
    ])
  })

  it('a 401 on the add is not resent with the same body: both tokens are minted again (SAR3-N5)', async () => {
    let answered = 0
    mockPrismAnswer = () =>
      answered++ === 0
        ? json({error: 'AuthenticationRequired', message: 'x'}, 401)
        : json({rev: 2})
    const api = systemAccountsApi()
    const b = pdsClientFor(B)
    const {rev} = await api.addSystemAccount(pdsClientFor(A), B, () =>
      api.mintProof(b),
    )
    expect(rev).toBe('2')
    expect(mockPrismCalls).toHaveLength(2)
    const proofs = mockPrismCalls.map(
      c => (JSON.parse(c.body) as {proof: string}).proof,
    )
    expect(proofs[0]).not.toBe(proofs[1])
    expect(mints.filter(m => m.did === B)).toHaveLength(2)
  })

  it('maps prism’s refusals to the dialog’s reasons, and no answer to unknown', async () => {
    const api = systemAccountsApi()
    const b = pdsClientFor(B)
    mockPrismAnswer = () => json({error: 'InvalidProof', message: 'x'}, 400)
    await expect(
      api.addSystemAccount(pdsClientFor(A), B, () => api.mintProof(b)),
    ).rejects.toEqual(new SystemAccountsError('proof'))
    mockPrismAnswer = () => json({error: 'ListFull', message: 'x'}, 400)
    await expect(
      api.addSystemAccount(pdsClientFor(A), B, () => api.mintProof(b)),
    ).rejects.toEqual(new SystemAccountsError('full'))
    mockPrismAnswer = () => json({error: 'InternalServerError'}, 502)
    await expect(api.removeSystemAccount(pdsClientFor(A), B)).rejects.toEqual(
      new SystemAccountsError('unknown'),
    )
  })

  it('prism’s 501 MethodNotImplemented reads as unavailable, not a crash (prism’s reply)', async () => {
    mockPrismAnswer = () =>
      json({error: 'MethodNotImplemented', message: 'x'}, 501)
    await expect(
      systemAccountsApi().getSystemAccounts(pdsClientFor(A)),
    ).rejects.toEqual(new SystemAccountsError('unavailable'))
  })

  it('a 429 holds every call for that caller until Retry-After, so no retry spends the rate class', async () => {
    let now = 1_000_000
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    mockPrismAnswer = () =>
      new Response(JSON.stringify({error: 'RateLimitExceeded', message: 'x'}), {
        status: 429,
        headers: {'content-type': 'application/json', 'retry-after': '4'},
      })
    const api = systemAccountsApi()
    const a = pdsClientFor(A)
    await expect(api.removeSystemAccount(a, B)).rejects.toEqual(
      new SystemAccountsError('limited', now + 4_000),
    )
    expect(mockPrismCalls).toHaveLength(1)
    // Held: nothing is sent, no token is minted, reads included.
    const mintsBefore = mints.length
    await expect(api.removeSystemAccount(a, B)).rejects.toMatchObject({
      reason: 'limited',
    })
    await expect(api.getSystemAccounts(a)).rejects.toMatchObject({
      reason: 'limited',
    })
    expect(mockPrismCalls).toHaveLength(1)
    expect(mints.length).toBe(mintsBefore)
    // Another caller is not held.
    mockPrismAnswer = () => json({rev: 3})
    await api.removeSystemAccount(pdsClientFor(B), A)
    expect(mockPrismCalls).toHaveLength(2)
    // After the wait, calls go again.
    now += 4_001
    await api.removeSystemAccount(a, B)
    expect(mockPrismCalls).toHaveLength(3)
    spy.mockRestore()
  })

  it('the list read goes direct too, with no `atproto-proxy`', async () => {
    mockPrismAnswer = () =>
      json({accounts: [{did: B, addedAt: '2026-10-24T00:00:00Z'}], rev: 4})
    const answer = await systemAccountsApi().getSystemAccounts(pdsClientFor(A))
    expect(answer).toEqual({
      accounts: [{did: B, addedAt: '2026-10-24T00:00:00Z'}],
      rev: '4',
    })
    expect(mockPrismCalls[0].headers.has('atproto-proxy')).toBe(false)
    expect(mockPrismCalls[0].url.pathname).toBe(
      '/xrpc/app.nearhorizon.account.getSystemAccounts',
    )
  })
})
