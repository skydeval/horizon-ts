import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {render, waitFor} from '@testing-library/react-native'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/** The persisted session accounts a write reads its repo route from. */
let mockAccounts: {did: string; service: string; pdsUrl?: string}[] = []
jest.mock('#/state/persisted', () => ({
  get: (key: string) =>
    key === 'session' ? {accounts: mockAccounts} : undefined,
  write: () => Promise.resolve(),
}))
const mockLocal = new Map<string, string>()
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: (key: string) => mockLocal.get(key),
  writeLocal: (key: string, value: string | undefined) => {
    if (value === undefined) mockLocal.delete(key)
    else mockLocal.set(key, value)
  },
  subscribeLocal: () => () => {},
}))
let mockSessionAccount:
  {did: string; service: string; pdsUrl?: string} | undefined
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: mockSessionAccount}),
}))
const mockResolvePds =
  jest.fn<
    (did: string) => Promise<{did: string; pdsUrl: string | null} | null>
  >()
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: (did: string) => mockResolvePds(did),
}))
/** Whether this platform can run the encoder (web: WebAssembly and a CSRNG). */
let mockEncoderAvailable = true
jest.mock('#/horizon/private/encoder', () => ({
  encoderAvailable: () => mockEncoderAvailable,
}))
let mockAnyPdsSwitch = true
/*
 * A defined getter: a getter in an object literal beside a spread is read
 * once, when the factory runs, by Babel's spread helper.
 */
jest.mock('#/horizon/switches', () =>
  Object.defineProperty(
    {...jest.requireActual<object>('#/horizon/switches')},
    'PRIVATE_POSTING_ANY_PDS',
    {get: () => mockAnyPdsSwitch, enumerable: true},
  ),
)

import {type Client} from '@atproto/lex'

import {logger} from '#/logger'
import {nearhorizon} from '#/horizon/lexicons'
import {
  type Call,
  fakeClient,
  type Reply,
} from '#/horizon/private/__tests__/fixtures'
import {clearCurrentClients, publishCurrentClients} from '../current-clients'
import {resetPrismFeatures, servesFeatureForWrite} from '../features'
import {
  answerCurrent,
  getMembership,
  isMembershipConfirmed,
  membershipStorageKey,
  type ProbeEnvironment,
  reportPrismError,
  resetMembership,
  startMembershipProbe,
} from '../membership'
import {
  getWriteRoute,
  isKryphocronRefusal,
  markKryphocronHost,
  repoRouteForDid,
  repoRouteForUrl,
  resetWriteRoutes,
} from '../write-route'
import {WriteRouteResolver} from '../WriteRouteResolver'

const DID = 'did:plc:routesaaaaaaaaaaaaaaaaaaa'
const OTHER = 'did:plc:otherbbbbbbbbbbbbbbbbbbbb'
/** The jest setup's locus origin (2K T-12). */
const LOCUS = 'https://pds.example'
const BSKY_SHARD = 'https://chalciporus.us-west.host.bsky.network'
const STOCK = 'https://pds.stock.example'

const quietEnv: ProbeEnvironment = {
  setTimeout: () => undefined,
  clearTimeout: () => {},
  isHidden: () => false,
  onVisible: () => () => {},
}

let client: Client

function publish(did: string, pdsUrl: string | undefined) {
  clearCurrentClients()
  publishCurrentClients({
    did,
    handle: 'alice.test',
    pdsUrl,
    pdsClient: client,
    prismClient: client,
    appviewClient: client,
  })
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Answer one `getMembership` with `body` and let it settle. */
async function answerMembership(body: Record<string, unknown>) {
  const prism = fakeClient(DID, () => ({status: 200, body}))
  const cancel = startMembershipProbe(DID, prism.client, quietEnv)
  await settle()
  cancel()
}

/** An XRPC error as a private read gets it. */
async function readError(reply: Reply): Promise<unknown> {
  const prism = fakeClient(DID, (_call: Call) => reply)
  return prism.client
    .call(nearhorizon.privateGetTimeline, {limit: 1})
    .catch((error: unknown) => error)
}

beforeEach(() => {
  mockAccounts = []
  mockLocal.clear()
  mockSessionAccount = undefined
  mockResolvePds.mockReset()
  mockEncoderAvailable = true
  mockAnyPdsSwitch = true
  resetMembership()
  resetPrismFeatures()
  resetWriteRoutes()
  client = fakeClient(DID, () => ({status: 500, body: {}})).client
  clearCurrentClients()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('the repo route (2K PA-4, T-1)', () => {
  it('defaults to locus’s origin, and EXPO_PUBLIC_LOCUS_PDS_ORIGINS replaces the list', () => {
    const saved = process.env.EXPO_PUBLIC_LOCUS_PDS_ORIGINS
    try {
      delete process.env.EXPO_PUBLIC_LOCUS_PDS_ORIGINS
      jest.isolateModules(() => {
        const route =
          jest.requireActual<typeof import('../write-route')>('../write-route')
        expect(route.LOCUS_PDS_ORIGINS).toEqual([
          'https://locus.nearhorizon.app',
        ])
        expect(route.repoRouteForUrl('https://locus.nearhorizon.app')).toBe(
          'locus',
        )
        expect(route.repoRouteForUrl(LOCUS)).toBe('stock')
      })
      process.env.EXPO_PUBLIC_LOCUS_PDS_ORIGINS =
        'https://a.example, https://b.example/xrpc,not a url'
      jest.isolateModules(() => {
        const route =
          jest.requireActual<typeof import('../write-route')>('../write-route')
        expect(route.LOCUS_PDS_ORIGINS).toEqual([
          'https://a.example',
          'https://b.example',
        ])
      })
    } finally {
      process.env.EXPO_PUBLIC_LOCUS_PDS_ORIGINS = saved
    }
  })

  it('compares origins: a locus origin is locus, Bluesky’s PDS and a stock PDS are stock', () => {
    expect(repoRouteForUrl(LOCUS)).toBe('locus')
    expect(repoRouteForUrl(`${LOCUS}/`)).toBe('locus')
    expect(repoRouteForUrl('https://pds.example:443')).toBe('locus')
    expect(repoRouteForUrl(BSKY_SHARD)).toBe('stock')
    expect(repoRouteForUrl(STOCK)).toBe('stock')
    expect(repoRouteForUrl(undefined)).toBe('stock')
    expect(repoRouteForUrl('not a url')).toBe('stock')
  })

  it('a write’s repo route comes from the persisted session account of its DID, then the published clients, then stock', () => {
    mockAccounts = [{did: DID, service: BSKY_SHARD, pdsUrl: LOCUS}]
    publish(DID, STOCK)
    // The persisted account wins, `pdsUrl` over `service`.
    expect(repoRouteForDid(DID)).toBe('locus')
    mockAccounts = [{did: DID, service: LOCUS}]
    expect(repoRouteForDid(DID)).toBe('locus')
    mockAccounts = []
    // No such account: the published clients, when they are for that DID.
    publish(DID, LOCUS)
    expect(repoRouteForDid(DID)).toBe('locus')
    publish(OTHER, LOCUS)
    expect(repoRouteForDid(DID)).toBe('stock')
    clearCurrentClients()
    expect(repoRouteForDid(DID)).toBe('stock')
    expect(repoRouteForDid(undefined)).toBe('stock')
  })
})

describe('the posting route (2K 2.1, PA-1a, T-1)', () => {
  it('on a locus origin it is locus at once, with nothing answered (never checking)', () => {
    publish(DID, LOCUS)
    expect(getWriteRoute(DID)).toMatchObject({
      repoRoute: 'locus',
      postingRoute: 'locus',
    })
  })

  it('on a stock PDS it is checking while nothing is answered, also with a persisted member record', () => {
    publish(DID, STOCK)
    expect(getWriteRoute(DID).postingRoute).toBe('checking')
    mockLocal.set(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private']}),
    )
    resetMembership()
    resetPrismFeatures()
    expect(getMembership(DID)).toBe('member')
    expect(getWriteRoute(DID)).toMatchObject({
      repoRoute: 'stock',
      postingRoute: 'checking',
    })
  })

  it('an answer with an unknown status (features, no membership) stays checking; servesFeatureForWrite is unchanged', async () => {
    publish(DID, STOCK)
    await answerMembership({status: 'somethingNew', features: ['private']})
    expect(answerCurrent(DID)).toEqual({membership: false, features: true})
    expect(isMembershipConfirmed(DID)).toBe(false)
    expect(servesFeatureForWrite('private', DID)).toBe(true)
    expect(getWriteRoute(DID).postingRoute).toBe('checking')
  })

  it('a member answered with private.anyPds is encode (2K-3)', async () => {
    publish(DID, STOCK)
    await answerMembership({
      status: 'member',
      features: ['private', 'private.anyPds'],
    })
    expect(answerCurrent(DID)).toEqual({membership: true, features: true})
    expect(getWriteRoute(DID)).toEqual({
      repoRoute: 'stock',
      postingRoute: 'encode',
      reason: undefined,
      indexing: false,
    })
  })

  it('on Bluesky’s PDS too; on locus it stays locus', async () => {
    publish(DID, BSKY_SHARD)
    await answerMembership({
      status: 'member',
      features: ['private', 'private.anyPds'],
    })
    expect(getWriteRoute(DID).postingRoute).toBe('encode')
    publish(DID, LOCUS)
    expect(getWriteRoute(DID).postingRoute).toBe('locus')
  })

  it('a member answered without private.anyPds is none, with no reason', async () => {
    publish(DID, STOCK)
    await answerMembership({status: 'member', features: ['private']})
    expect(getWriteRoute(DID)).toMatchObject({
      postingRoute: 'none',
      reason: undefined,
    })
  })

  it('without an encoder on this platform it is none with reason no-encoder (D-0.13)', async () => {
    mockEncoderAvailable = false
    publish(DID, STOCK)
    await answerMembership({
      status: 'member',
      features: ['private', 'private.anyPds'],
    })
    expect(getWriteRoute(DID)).toMatchObject({
      postingRoute: 'none',
      reason: 'no-encoder',
    })
  })

  it('with PRIVATE_POSTING_ANY_PDS off it is none, as in 2K-1 (10)', async () => {
    mockAnyPdsSwitch = false
    publish(DID, STOCK)
    await answerMembership({
      status: 'member',
      features: ['private', 'private.anyPds'],
    })
    expect(getWriteRoute(DID)).toMatchObject({
      repoRoute: 'stock',
      postingRoute: 'none',
      reason: undefined,
    })
  })

  it('with permissions, privateIndexed decides: false is none for a member, true is encode while indexing (PA-1a)', async () => {
    publish(DID, STOCK)
    await answerMembership({
      status: 'member',
      features: ['private', 'private.anyPds'],
      permissions: {privateRead: true, privateIndexed: false},
    })
    expect(getWriteRoute(DID).postingRoute).toBe('none')
    await answerMembership({
      status: 'indexing',
      features: ['private', 'private.anyPds'],
      permissions: {privateRead: false, privateIndexed: true},
    })
    expect(getWriteRoute(DID)).toMatchObject({
      postingRoute: 'encode',
      indexing: true,
    })
    // A value that is not a boolean is ignored: the status decides.
    await answerMembership({
      status: 'indexing',
      features: ['private', 'private.anyPds'],
      permissions: {privateIndexed: 'yes'},
    })
    expect(getWriteRoute(DID).postingRoute).toBe('none')
  })

  it('a NotEnrolled from a read after privateIndexed forgets it: not encode', async () => {
    publish(DID, STOCK)
    await answerMembership({
      status: 'member',
      features: ['private', 'private.anyPds'],
      permissions: {privateIndexed: true},
    })
    expect(getWriteRoute(DID).postingRoute).toBe('encode')
    reportPrismError(
      DID,
      await readError({status: 400, body: {error: 'NotEnrolled'}}),
    )
    expect(getWriteRoute(DID).postingRoute).toBe('none')
  })

  it('indexing in this run is none with the indexing wording', async () => {
    publish(DID, STOCK)
    await answerMembership({status: 'indexing', features: ['private']})
    expect(getWriteRoute(DID)).toMatchObject({
      postingRoute: 'none',
      indexing: true,
    })
  })

  it('NotReady and NotEnrolled from a read (membership, no features) are none', async () => {
    publish(DID, STOCK)
    reportPrismError(
      DID,
      await readError({status: 400, body: {error: 'NotReady'}}),
    )
    expect(answerCurrent(DID)).toEqual({membership: true, features: false})
    expect(getWriteRoute(DID)).toMatchObject({
      postingRoute: 'none',
      indexing: true,
    })
    reportPrismError(
      DID,
      await readError({status: 400, body: {error: 'NotEnrolled'}}),
    )
    expect(getWriteRoute(DID)).toMatchObject({
      postingRoute: 'none',
      indexing: false,
    })
  })

  it('a snapshot is shared until a route changes', async () => {
    publish(DID, STOCK)
    const first = getWriteRoute(DID)
    expect(getWriteRoute(DID)).toBe(first)
    await answerMembership({status: 'member', features: ['private']})
    expect(getWriteRoute(DID)).not.toBe(first)
  })
})

describe('PA-5: locus’s refusal of a raw write (T-8)', () => {
  it('matches a 400 with either name, and nothing else', async () => {
    const error = (status: number, name: string) =>
      readError({status, body: {error: name, message: 'refused'}})
    expect(
      isKryphocronRefusal(
        await error(400, 'KryphocronRecordRequiresDedicatedEndpoint'),
      ),
    ).toBe(true)
    expect(
      isKryphocronRefusal(await error(400, 'KryphocronRecordNotYetSupported')),
    ).toBe(true)
    expect(isKryphocronRefusal(await error(400, 'InvalidRequest'))).toBe(false)
    expect(
      isKryphocronRefusal(
        await error(409, 'KryphocronRecordRequiresDedicatedEndpoint'),
      ),
    ).toBe(false)
    expect(isKryphocronRefusal(new Error('offline'))).toBe(false)
  })

  it('a match makes the account’s routes locus for the run', () => {
    publish(DID, STOCK)
    expect(getWriteRoute(DID).postingRoute).toBe('checking')
    markKryphocronHost(DID)
    expect(getWriteRoute(DID)).toMatchObject({
      repoRoute: 'locus',
      postingRoute: 'locus',
    })
    // Not stored: the next run resolves again.
    resetWriteRoutes()
    expect(repoRouteForDid(DID)).toBe('stock')
  })
})

describe('the DID-document cross-check (PA-4)', () => {
  function mount() {
    return render(<WriteRouteResolver />)
  }

  it('logs a mismatch by origin and changes no route', async () => {
    const info = jest.spyOn(logger, 'info')
    mockSessionAccount = {did: DID, service: STOCK}
    publish(DID, STOCK)
    mockResolvePds.mockResolvedValue({did: DID, pdsUrl: `${LOCUS}/`})
    const screen = mount()
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith('write-route: pds mismatch', {
        did: DID,
        sessionOrigin: STOCK,
        didDocOrigin: LOCUS,
      }),
    )
    expect(getWriteRoute(DID).repoRoute).toBe('stock')
    screen.unmount()
  })

  it('a null answer, a null PDS and an error are logged the same way; a match logs nothing', async () => {
    const info = jest.spyOn(logger, 'info')
    mockSessionAccount = {did: DID, service: STOCK}
    for (const answer of [
      () => Promise.resolve(null),
      () => Promise.resolve({did: DID, pdsUrl: null}),
      () => Promise.reject(new Error('offline')),
    ]) {
      info.mockClear()
      mockResolvePds.mockImplementation(answer)
      const screen = mount()
      await waitFor(() =>
        expect(info).toHaveBeenCalledWith('write-route: pds mismatch', {
          did: DID,
          sessionOrigin: STOCK,
          didDocOrigin: null,
        }),
      )
      screen.unmount()
    }
    info.mockClear()
    mockResolvePds.mockResolvedValue({did: DID, pdsUrl: STOCK})
    const screen = mount()
    await settle()
    expect(info).not.toHaveBeenCalledWith(
      'write-route: pds mismatch',
      expect.anything(),
    )
    screen.unmount()
  })
})
