import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * Posting from another signed-in account (Phase 5 design 8.5, PP-16, PA-4;
 * section 13 "Private, switch to an account off locus", "A private write
 * called with an unpicked audience"): the routes the composer hands its
 * blockers for another account, the write path's own refusal behind them,
 * the temporary client, and its rotated tokens stored at once.
 */
jest.mock('#/lib/api/index', () => ({
  resolveEmbed: () => Promise.resolve(undefined),
  resolveReply: () => Promise.reject(new Error('no public reply here')),
}))
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))
jest.mock('#/state/queries/profile', () => ({
  RQKEY: (did: string) => ['profile', did],
}))
jest.mock('#/state/queries/resolve-link', () => ({
  RQKEY_LINK: (url: string) => ['resolve-link', url],
}))
jest.mock('#/state/queries/threadgate', () => ({
  upsertThreadgate: () => Promise.resolve(),
}))
jest.mock('#/state/queries/postgate', () => ({
  upsertPostgate: () => Promise.resolve(),
}))
jest.mock('#/view/com/composer/drafts/state/storage', () => ({
  deleteMediaFromLocal: () => Promise.resolve(),
}))
jest.mock('#/horizon/routing/prism', () => ({
  getPrismClient: (client: unknown) => client,
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => undefined,
}))
jest.mock('#/horizon/private/encoder', () => ({
  ...jest.requireActual<object>('#/horizon/private/encoder/types'),
  encoderAvailable: () => true,
  prewarmEncoder: () => {},
  loadEncoder: () => Promise.reject(new Error('not in tests')),
}))
const mockAccounts: Record<string, unknown>[] = []
jest.mock('#/state/persisted', () => ({
  get: (key: string) =>
    key === 'session' ? {accounts: mockAccounts} : undefined,
  write: () => Promise.resolve(),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: [], currentAccount: undefined}),
  useMaybePdsClient: () => null,
}))
type Fetch = (input: unknown, init?: RequestInit) => Promise<Response>
let mockFetch: Fetch = () => Promise.reject(new Error('no network in tests'))
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: (input: unknown, init?: RequestInit) =>
    mockFetch(input, init),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {type PostOpts} from '#/lib/api/index'
import {type State} from '#/state/session/reducer'
import {type SessionAccount} from '#/state/session/types'
import {type ThreadDraft} from '#/view/com/composer/state/composer'
import {ownClientFor, resetIdentityReads} from '#/horizon/identity/reads'
import {fakeClient} from '#/horizon/private/__tests__/fixtures'
import {PrivateAudienceUnpickedError} from '#/horizon/private/api/audiences'
import {PrivateRouteUnavailableError} from '#/horizon/private/api/writer'
import {postPrivate} from '#/horizon/private/api/writes'
import {
  privateComposeAllows,
  privateComposeBlocker,
} from '#/horizon/private/composer/blockers'
import {
  PUBLIC_COMPOSE,
  setComposeVisibility,
} from '#/horizon/private/composer/state'
import {listOutboxRecords} from '#/horizon/private/outbox/record'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {
  type ProbeEnvironment,
  resetMembership,
  startMembershipProbe,
} from '#/horizon/routing/membership'
import {
  getWriteRoute,
  resetWriteRoutes,
  type WriteRoutes,
} from '#/horizon/routing/write-route'
import {
  registerStoredAccountSink,
  updatedStoredAccount,
} from '#/horizon/session/stored-account'
import {com} from '#/lexicons'
import {postingRoutesFor} from '../routes'
import {
  acquireTemporaryClient,
  canActAs,
  releaseTemporaryClient,
  resetTemporaryClients,
  TemporaryClientUnavailableError,
} from '../temp-client'
import {
  fakeAccount,
  jwt,
  LOCUS_URL,
  MAIN,
  OTHER,
  publishCurrent,
  settle,
  STOCK_URL,
  STOCKY,
  storedAccount,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const thread = {
  posts: [
    {
      id: 'p',
      richtext: {text: 'hello'},
      labels: [],
      embed: {quote: undefined, media: undefined, link: undefined},
      shortenedGraphemeLength: 5,
    },
  ],
  postgate: {},
  threadgate: [{type: 'everybody'}],
} as unknown as ThreadDraft

const quietEnv: ProbeEnvironment = {
  setTimeout: () => undefined,
  clearTimeout: () => {},
  isHidden: () => false,
  onVisible: () => () => {},
}

async function answerMembership(did: string) {
  const probe = fakeClient(did, () => ({
    status: 200,
    body: {status: 'member', features: ['private', 'private.anyPds']},
  }))
  const cancel = startMembershipProbe(did, probe.client, quietEnv)
  await settle()
  cancel()
}

beforeEach(() => {
  resetIdentityReads()
  resetTemporaryClients()
  resetWriteRoutes()
  resetMembership()
  resetPrismFeatures()
  mockAccounts.length = 0
  mockAccounts.push(
    storedAccount(MAIN, LOCUS_URL, 'main.test'),
    storedAccount(OTHER, LOCUS_URL, 'other.test'),
    storedAccount(STOCKY, STOCK_URL, 'stocky.test'),
  )
  mockFetch = () => Promise.reject(new Error('no network in tests'))
  setComposeVisibility(PUBLIC_COMPOSE)
})

describe('another account’s routes (8.5, P5R7-N2)', () => {
  it('off locus, an account with posting route encode is handed none, other-account, and Post stays off after a pick', async () => {
    publishCurrent(fakeAccount(MAIN), LOCUS_URL, 'main.test')
    await answerMembership(STOCKY)
    // On its own it would post through the encoder.
    expect(getWriteRoute(STOCKY).postingRoute).toBe('encode')
    const own = getWriteRoute(MAIN)
    const routes = postingRoutesFor(STOCKY, MAIN, own)
    expect(routes).toMatchObject({
      postingRoute: 'none',
      reason: 'other-account',
      repoRoute: 'stock',
    })
    const picked = {kind: 'mode' as const, mode: 'followers' as const}
    expect(privateComposeAllows(thread, true, routes, picked)).toBe(false)
    expect(privateComposeBlocker(thread, routes, picked, 'stocky.test')).toBe(
      'Switch to @stocky.test to post privately.',
    )
    // The note comes before the switch's own note.
    expect(
      privateComposeBlocker(
        thread,
        routes,
        {kind: 'unpicked', why: 'switch'},
        'stocky.test',
      ),
    ).toBe('Switch to @stocky.test to post privately.')
    // Public is the way out.
    expect(privateComposeAllows(thread, false, routes, picked)).toBe(true)
  })

  it('off locus with posting route none or checking: the same', () => {
    publishCurrent(fakeAccount(MAIN), LOCUS_URL, 'main.test')
    expect(getWriteRoute(STOCKY).postingRoute).toBe('checking')
    expect(postingRoutesFor(STOCKY, MAIN, getWriteRoute(MAIN))).toMatchObject({
      postingRoute: 'none',
      reason: 'other-account',
    })
  })

  it('on locus another account’s routes pass unchanged, and the current account’s own routes always do', () => {
    publishCurrent(fakeAccount(MAIN), LOCUS_URL, 'main.test')
    expect(
      postingRoutesFor(OTHER, MAIN, getWriteRoute(MAIN)).postingRoute,
    ).toBe('locus')
    const own: WriteRoutes = {
      repoRoute: 'stock',
      postingRoute: 'encode',
      reason: undefined,
      indexing: false,
    }
    expect(postingRoutesFor(MAIN, MAIN, own)).toBe(own)
  })
})

describe('the private write path refuses behind the composer (8.5, P5R6-N3)', () => {
  function opts(pdsClient: PostOpts['pdsClient']): PostOpts {
    return {
      thread,
      appviewClient: pdsClient,
      chatClient: pdsClient,
      pdsClient,
    }
  }

  it('another account off locus never takes the encode route: nothing is sent and no outbox record is saved under either DID', async () => {
    publishCurrent(fakeAccount(MAIN), LOCUS_URL, 'main.test')
    await answerMembership(STOCKY)
    expect(getWriteRoute(STOCKY).postingRoute).toBe('encode')
    const stocky = fakeAccount(STOCKY)
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
    await expect(
      postPrivate(new QueryClient(), opts(stocky.client)),
    ).rejects.toBeInstanceOf(PrivateRouteUnavailableError)
    expect(stocky.calls).toEqual([])
    expect(listOutboxRecords(STOCKY)).toEqual([])
    expect(listOutboxRecords(MAIN)).toEqual([])
  })

  it('an audience left unpicked by an account change is refused first, before any request', async () => {
    const main = fakeAccount(MAIN)
    publishCurrent(main, LOCUS_URL, 'main.test')
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'switch'},
      locked: false,
    })
    const error = await postPrivate(new QueryClient(), opts(main.client)).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(PrivateAudienceUnpickedError)
    expect((error as Error).message).toBe('Choose who can see this post.')
    expect(main.calls).toEqual([])
  })
})

describe('the temporary client (PP-16)', () => {
  it('writes as the chosen account and reads its identity from its own PDS while held', () => {
    const clients = acquireTemporaryClient(OTHER)
    expect(clients.did).toBe(OTHER)
    expect(clients.pdsClient.assertDid).toBe(OTHER)
    expect(ownClientFor(OTHER)).toBe(clients.pdsClient)
    // One client per account, counted.
    expect(acquireTemporaryClient(OTHER)).toBe(clients)
    releaseTemporaryClient(OTHER)
    expect(ownClientFor(OTHER)).toBe(clients.pdsClient)
    releaseTemporaryClient(OTHER)
    expect(ownClientFor(OTHER)).toBeUndefined()
  })

  it('an account that cannot act is refused', () => {
    const signedOut = {
      ...storedAccount(OTHER, LOCUS_URL, 'other.test'),
      refreshJwt: undefined,
    }
    expect(canActAs(signedOut as never)).toBe(false)
    expect(
      canActAs({
        ...signedOut,
        isOauthSession: true,
        oauthSignedOut: true,
      } as never),
    ).toBe(false)
    expect(() =>
      acquireTemporaryClient('did:plc:nobodyaaaaaaaaaaaaaaaaaa'),
    ).toThrow(TemporaryClientUnavailableError)
  })

  it('a password session’s rotated tokens are stored at once (PA-4), and dropping the client signs nothing out', async () => {
    mockAccounts[1] = {
      ...storedAccount(OTHER, LOCUS_URL, 'other.test'),
      accessJwt: jwt(OTHER, -60),
    }
    const stored: SessionAccount[] = []
    const stop = registerStoredAccountSink(account => stored.push(account))
    const newRefresh = jwt(OTHER, 60 * 24 * 3600, 'com.atproto.refresh')
    const paths: string[] = []
    mockFetch = (input, init) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url,
      )
      paths.push(url.pathname)
      void init
      if (url.pathname === '/xrpc/com.atproto.server.refreshSession') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              did: OTHER,
              handle: 'other.test',
              accessJwt: jwt(OTHER, 3600),
              refreshJwt: newRefresh,
            }),
            {status: 200, headers: {'content-type': 'application/json'}},
          ),
        )
      }
      if (paths.filter(p => p === url.pathname).length === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({error: 'ExpiredToken', message: 'expired'}),
            {status: 400, headers: {'content-type': 'application/json'}},
          ),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
      )
    }
    const clients = acquireTemporaryClient(OTHER)
    await clients.pdsClient
      .call(com.atproto.server.getSession, {})
      .catch(() => {})
    await settle()
    expect(paths).toContain('/xrpc/com.atproto.server.refreshSession')
    expect(stored.map(account => account.refreshJwt)).toContain(newRefresh)
    expect(paths).not.toContain('/xrpc/com.atproto.server.deleteSession')
    releaseTemporaryClient(OTHER)
    expect(paths).not.toContain('/xrpc/com.atproto.server.deleteSession')
    stop()
  })
})

describe('updated-stored-account (PA-4)', () => {
  function state(current: string | undefined): State {
    return {
      accounts: [
        storedAccount(MAIN, LOCUS_URL, 'main.test'),
        storedAccount(OTHER, LOCUS_URL, 'other.test'),
      ] as never,
      currentBundleState: {bundle: {service: new URL(LOCUS_URL)}, did: current},
      needsPersist: false,
    }
  }

  it('stores another account’s rotated tokens and persists them', () => {
    const next = updatedStoredAccount(state(MAIN), {
      ...storedAccount(OTHER, LOCUS_URL, 'other.test'),
      refreshJwt: 'rotated',
    } as never)
    expect(next.accounts[1].refreshJwt).toBe('rotated')
    expect(next.needsPersist).toBe(true)
  })

  it('never touches the current account’s tokens, nor adds an account', () => {
    const before = state(OTHER)
    expect(
      updatedStoredAccount(before, {
        ...storedAccount(OTHER, LOCUS_URL, 'other.test'),
        refreshJwt: 'rotated',
      } as never),
    ).toBe(before)
    expect(
      updatedStoredAccount(
        before,
        storedAccount(STOCKY, STOCK_URL, 's') as never,
      ),
    ).toBe(before)
  })
})
