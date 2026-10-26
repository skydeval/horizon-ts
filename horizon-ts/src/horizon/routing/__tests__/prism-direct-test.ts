import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * 2K design T-3 and T-19's token half: the direct prism client. prism is
 * reached only through the plain network-aware fetch (mocked here); the PDS
 * client is a lex client whose own fetch handler answers getServiceAuth, so
 * anything else reaching the PDS shows in `pdsCalls`.
 */
type Sent = {url: URL; headers: Headers}
const mockPrismCalls: Sent[] = []
let mockPrismAnswer: (call: Sent) => Response = () => json({posts: []})

jest.mock('#/state/session/network', () => ({
  networkAwareFetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers: new Headers(init?.headers),
    }
    mockPrismCalls.push(call)
    return Promise.resolve(mockPrismAnswer(call))
  },
}))

// prism.ts reads the session for its hook only.
jest.mock('#/state/session', () => ({
  useMaybePdsClient: () => null,
}))
// The posting route, for the prefetch (PA-29); the token tests never read it.
let mockPostingRoute = 'encode'
const mockRouteListeners = new Set<() => void>()
jest.mock('#/horizon/routing/write-route', () => ({
  getWriteRoute: () => ({postingRoute: mockPostingRoute}),
  subscribeWriteRoutes: (listener: () => void) => {
    mockRouteListeners.add(listener)
    return () => mockRouteListeners.delete(listener)
  },
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
/** The site's clock (web), as `origin-clock.web.ts` would read it. */
let mockOriginOffset: number | undefined
jest.mock('#/horizon/routing/origin-clock', () => ({
  ORIGIN_CLOCK_AVAILABLE: false,
  readOriginClockOffsetSecs: () => Promise.resolve(mockOriginOffset),
}))

import {type Client} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'

import {createLexClient} from '#/lib/lexClient'
import {nearhorizon} from '#/horizon/lexicons'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {PRISM_URL} from '../prism'
import {
  DIRECT_PREFETCH_2K,
  DirectPrismRateLimitedError,
  dropDirectPrismTokens,
  getDirectPrismClient,
  getDirectPrismToken,
  learnOriginClock,
  PRIVATE_GET_POSTS_LXM,
  rateLimitWaitMs,
  resetDirectPrism,
  SERVICE_AUTH_LIMIT_DEFAULT_MS,
  startDirectTokenPrefetch,
  tokenLifetimeMs,
} from '../prism-direct'

const DID = 'did:plc:directaaaaaaaaaaaaaaaaaa' as DidString
const OTHER_DID = 'did:plc:directbbbbbbbbbbbbbbbbbb' as DidString
const AUD = 'did:web:prism.nearhorizon.app#bsky_appview'
const START_MS = 1_790_000_000_000

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  })
}

function base64url(value: string) {
  return Buffer.from(value).toString('base64url')
}

let minted = 0

/** A service token whose claims say it lives `secs` seconds from `iatSecs`. */
function token({secs = 3540, iatSecs = Math.floor(now / 1000)} = {}) {
  minted++
  return [
    base64url(JSON.stringify({alg: 'ES256K', typ: 'JWT'})),
    base64url(
      JSON.stringify({
        iss: DID,
        aud: AUD,
        lxm: PRIVATE_GET_POSTS_LXM,
        iat: iatSecs,
        exp: iatSecs + secs,
        n: minted,
      }),
    ),
    'sig',
  ].join('.')
}

type PdsCall = {path: string; params: URLSearchParams}
let pdsCalls: PdsCall[] = []
let serviceAuthAnswer: (call: PdsCall) => Response = () =>
  json({token: token()})

function pdsClientFor(did: DidString = DID): Client {
  return createLexClient(
    {
      did,
      fetchHandler: (path: string) => {
        const url = new URL(path, 'https://pds.example')
        const call = {path: url.pathname, params: url.searchParams}
        pdsCalls.push(call)
        if (url.pathname === '/xrpc/com.atproto.server.getServiceAuth') {
          return Promise.resolve(serviceAuthAnswer(call))
        }
        return Promise.resolve(json({error: 'Unexpected'}, 500))
      },
    },
    {appLabelers: null},
  )
}

function serviceAuthCalls() {
  return pdsCalls.filter(
    call => call.path === '/xrpc/com.atproto.server.getServiceAuth',
  )
}

function getPosts(client: Client) {
  return getDirectPrismClient(client).call(nearhorizon.privateGetPosts, {
    uris: [`at://${DID}/tools.kryphocron.feed.postPrivate/3kdirectpost22`],
  })
}

let now = START_MS

beforeEach(() => {
  now = START_MS
  mockOriginOffset = undefined
  jest.spyOn(Date, 'now').mockImplementation(() => now)
  mockPrismCalls.length = 0
  pdsCalls = []
  minted = 0
  mockPrismAnswer = () => json({posts: []})
  serviceAuthAnswer = () => json({token: token()})
  resetDirectPrism()
  clearCurrentClients()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('the getPosts token', () => {
  it('is asked of the PDS with prism`s #bsky_appview aud and the exact lxm; the first with no exp', async () => {
    now = START_MS + 456
    await getDirectPrismToken(pdsClientFor(), PRIVATE_GET_POSTS_LXM)
    const [call] = serviceAuthCalls()
    expect(call.params.get('aud')).toBe(AUD)
    expect(call.params.get('lxm')).toBe('app.nearhorizon.private.getPosts')
    // The PDS's clock is not known yet: its own default, never BadExpiration.
    expect(call.params.has('exp')).toBe(false)
  })

  it('asks later exps on the PDS`s clock, learned from the last token`s iat, never the device`s', async () => {
    // The device is 90 s ahead of the PDS: the PDS signs with its own time.
    serviceAuthAnswer = () =>
      json({token: token({iatSecs: Math.floor(now / 1000) - 90})})
    const pds = pdsClientFor()
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    await getDirectPrismToken(pds, 'app.nearhorizon.private.getTimeline')
    const exps = serviceAuthCalls().map(call => call.params.get('exp'))
    expect(exps).toEqual([null, String(START_MS / 1000 - 90 + 3000)])
  })

  it('a device hours off still asks an exp the PDS accepts', async () => {
    // The device is three hours behind the PDS.
    serviceAuthAnswer = () =>
      json({token: token({iatSecs: Math.floor(now / 1000) + 3 * 3600})})
    const pds = pdsClientFor()
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    await getDirectPrismToken(pds, 'app.nearhorizon.private.getTimeline')
    expect(serviceAuthCalls()[1].params.get('exp')).toBe(
      String(START_MS / 1000 + 3 * 3600 + 3000),
    )
  })

  it('with the site`s clock learned at load, even the first token asks a long exp', async () => {
    mockOriginOffset = -120
    await learnOriginClock()
    await getDirectPrismToken(pdsClientFor(), PRIVATE_GET_POSTS_LXM)
    expect(serviceAuthCalls()[0].params.get('exp')).toBe(
      String(START_MS / 1000 - 120 + 3000),
    )
  })

  it('judges a token`s freshness by its own exp on the PDS`s clock', async () => {
    // The PDS is an hour ahead; its token lives 300 s on its clock.
    serviceAuthAnswer = () =>
      json({token: token({secs: 300, iatSecs: Math.floor(now / 1000) + 3600})})
    const pds = pdsClientFor()
    const first = await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    now += 200_000
    expect(await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)).toBe(first)
    // Within its last minute on the PDS's clock: replaced.
    now += 50_000
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    expect(serviceAuthCalls()).toHaveLength(2)
  })

  it('is cached for its own exp - iat from receipt, not against the device clock', async () => {
    // The token's claims are an hour behind the device clock; its life still counts from receipt.
    serviceAuthAnswer = () =>
      json({token: token({iatSecs: Math.floor(now / 1000) - 3600})})
    const pds = pdsClientFor()
    const first = await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    now += 3_000_000
    expect(await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)).toBe(first)
    expect(serviceAuthCalls()).toHaveLength(1)

    // Inside the last minute of its 3,540 s it is replaced.
    now = START_MS + 3_540_000 - 30_000
    expect(await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)).not.toBe(
      first,
    )
    expect(serviceAuthCalls()).toHaveLength(2)
  })

  it('is kept per DID and method', async () => {
    await getDirectPrismToken(pdsClientFor(), PRIVATE_GET_POSTS_LXM)
    await getDirectPrismToken(
      pdsClientFor(),
      'app.nearhorizon.private.getTimeline',
    )
    await getDirectPrismToken(pdsClientFor(OTHER_DID), PRIVATE_GET_POSTS_LXM)
    await getDirectPrismToken(pdsClientFor(), PRIVATE_GET_POSTS_LXM)
    expect(serviceAuthCalls()).toHaveLength(3)
  })

  it('concurrent asks share one getServiceAuth', async () => {
    const pds = pdsClientFor()
    const [a, b] = await Promise.all([
      getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM),
      getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM),
    ])
    expect(a).toBe(b)
    expect(serviceAuthCalls()).toHaveLength(1)
  })

  it('BadExpiration anyway: asks again with no exp and learns the clock again', async () => {
    const pds = pdsClientFor()
    // The first token teaches a clock 100 s ahead of the device.
    serviceAuthAnswer = () =>
      json({token: token({iatSecs: Math.floor(now / 1000) + 100})})
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    // The PDS's clock has since moved: any exp is refused, none is not.
    serviceAuthAnswer = call =>
      call.params.has('exp')
        ? json({error: 'BadExpiration', message: 'skew'}, 400)
        : json({token: token({secs: 60, iatSecs: Math.floor(now / 1000)})})
    await getDirectPrismToken(pds, 'app.nearhorizon.private.getTimeline')
    // The clock learned from the no-exp token: the device's own now.
    await getDirectPrismToken(pds, 'app.nearhorizon.private.getAuthorFeed')
    const exps = serviceAuthCalls().map(call => call.params.get('exp'))
    expect(exps).toEqual([
      null,
      String(START_MS / 1000 + 100 + 3000),
      null,
      String(START_MS / 1000 + 3000),
      null,
    ])
  })

  it('an account switch and a sign-out drop the tokens', async () => {
    const pds = pdsClientFor()
    publishCurrentClients({did: DID} as CurrentClients)
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    publishCurrentClients({did: DID} as CurrentClients)
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    expect(serviceAuthCalls()).toHaveLength(1)

    publishCurrentClients({did: OTHER_DID} as CurrentClients)
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    expect(serviceAuthCalls()).toHaveLength(2)

    clearCurrentClients()
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    expect(serviceAuthCalls()).toHaveLength(3)
  })

  it('a token answered after a drop is not cached', async () => {
    let release: (() => void) | undefined
    serviceAuthAnswer = () => json({token: token()})
    const pds = pdsClientFor()
    const slow = createLexClient(
      {
        did: DID,
        fetchHandler: async (path: string) => {
          await new Promise<void>(resolve => (release = resolve))
          const url = new URL(path, 'https://pds.example')
          pdsCalls.push({path: url.pathname, params: url.searchParams})
          return json({token: token()})
        },
      },
      {appLabelers: null},
    )
    const pendingToken = getDirectPrismToken(slow, PRIVATE_GET_POSTS_LXM)
    await new Promise(resolve => setTimeout(resolve, 0))
    dropDirectPrismTokens()
    release?.()
    await pendingToken
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    expect(serviceAuthCalls()).toHaveLength(2)
  })
})

describe('getServiceAuth 429 (PA-36)', () => {
  it('waits until ratelimit-reset before asking again', async () => {
    const resetSecs = START_MS / 1000 + 120
    serviceAuthAnswer = () =>
      json({error: 'RateLimitExceeded'}, 429, {
        'ratelimit-reset': String(resetSecs),
      })
    const pds = pdsClientFor()
    const failure = await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(DirectPrismRateLimitedError)
    expect((failure as DirectPrismRateLimitedError).retryAt).toBe(
      resetSecs * 1000,
    )

    serviceAuthAnswer = () => json({token: token()})
    now += 60_000
    await expect(
      getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM),
    ).rejects.toBeInstanceOf(DirectPrismRateLimitedError)
    expect(serviceAuthCalls()).toHaveLength(1)

    now = resetSecs * 1000
    await expect(
      getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM),
    ).resolves.toEqual(expect.any(String))
    expect(serviceAuthCalls()).toHaveLength(2)
  })

  it('uses Retry-After, and 1 minute when neither header is readable', async () => {
    serviceAuthAnswer = () =>
      json({error: 'RateLimitExceeded'}, 429, {'retry-after': '30'})
    await expect(
      getDirectPrismToken(pdsClientFor(), PRIVATE_GET_POSTS_LXM),
    ).rejects.toMatchObject({retryAt: START_MS + 30_000})

    resetDirectPrism()
    serviceAuthAnswer = () => json({error: 'RateLimitExceeded'}, 429)
    await expect(
      getDirectPrismToken(pdsClientFor(), PRIVATE_GET_POSTS_LXM),
    ).rejects.toMatchObject({retryAt: START_MS + SERVICE_AUTH_LIMIT_DEFAULT_MS})
  })

  it('reads the headers, with the default for missing, past or junk values', () => {
    const at = START_MS
    const headers = (values: Record<string, string>) => new Headers(values)
    expect(rateLimitWaitMs(undefined, 5, at)).toBe(5)
    expect(rateLimitWaitMs(headers({}), 5, at)).toBe(5)
    expect(
      rateLimitWaitMs(
        headers({'ratelimit-reset': String(at / 1000 + 10)}),
        5,
        at,
      ),
    ).toBe(10_000)
    expect(
      rateLimitWaitMs(
        headers({'ratelimit-reset': String(at / 1000 - 10)}),
        5,
        at,
      ),
    ).toBe(5)
    expect(rateLimitWaitMs(headers({'retry-after': '7'}), 5, at)).toBe(7_000)
    expect(
      rateLimitWaitMs(
        headers({'retry-after': new Date(at + 9_000).toUTCString()}),
        5,
        at,
      ),
    ).toBe(9_000)
    expect(rateLimitWaitMs(headers({'retry-after': 'soon'}), 5, at)).toBe(5)
  })
})

describe('the direct client', () => {
  it('calls prism itself with the bearer token and no atproto-proxy', async () => {
    const pds = pdsClientFor()
    await getPosts(pds)
    expect(mockPrismCalls).toHaveLength(1)
    const [call] = mockPrismCalls
    expect(call.url.origin).toBe(new URL(PRISM_URL).origin)
    expect(call.url.pathname).toBe('/xrpc/app.nearhorizon.private.getPosts')
    expect(call.headers.has('atproto-proxy')).toBe(false)
    const auth = call.headers.get('authorization')
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.sig$/)
    // The PDS was asked for the token only; the read never went through it.
    expect(pdsCalls.map(c => c.path)).toEqual([
      '/xrpc/com.atproto.server.getServiceAuth',
    ])
    expect(getDirectPrismClient(pds)).toBe(getDirectPrismClient(pds))
  })

  it('a read with a cached token makes one request', async () => {
    const pds = pdsClientFor()
    await getDirectPrismToken(pds, PRIVATE_GET_POSTS_LXM)
    pdsCalls = []
    await getPosts(pds)
    expect(pdsCalls).toEqual([])
    expect(mockPrismCalls).toHaveLength(1)
  })

  it('a prism 401 drops the token and retries once with a fresh one; the session is not touched', async () => {
    mockPrismAnswer = () => json({error: 'InvalidToken'}, 401)
    const pds = pdsClientFor()
    await expect(getPosts(pds)).rejects.toMatchObject({status: 401})
    expect(mockPrismCalls).toHaveLength(2)
    expect(mockPrismCalls[0].headers.get('authorization')).not.toBe(
      mockPrismCalls[1].headers.get('authorization'),
    )
    expect(serviceAuthCalls()).toHaveLength(2)
    // Nothing but getServiceAuth reached the PDS client: no refresh, no session call.
    expect(
      pdsCalls.every(c => c.path === '/xrpc/com.atproto.server.getServiceAuth'),
    ).toBe(true)

    mockPrismAnswer = () => json({posts: []})
    await getPosts(pds)
    expect(serviceAuthCalls()).toHaveLength(2)
  })

  it('a 401 cured by the fresh token answers', async () => {
    let first = true
    mockPrismAnswer = () => {
      if (first) {
        first = false
        return json({error: 'InvalidToken'}, 401)
      }
      return json({posts: []})
    }
    await expect(getPosts(pdsClientFor())).resolves.toBeDefined()
    expect(mockPrismCalls).toHaveLength(2)
  })
})

describe('token claims', () => {
  it('reads exp - iat, and 60 s for an unreadable token', () => {
    expect(tokenLifetimeMs(token({secs: 1800}))).toBe(1_800_000)
    expect(tokenLifetimeMs('not-a-token')).toBe(60_000)
    expect(tokenLifetimeMs(`a.${base64url('{"exp":5}')}.c`)).toBe(60_000)
  })
})

describe('the getPosts token prefetch and refresh (PA-29, T-25)', () => {
  let foreground = true
  const foregroundListeners = new Set<() => void>()
  const env = {
    isForeground: () => foreground,
    subscribe: (listener: () => void) => {
      foregroundListeners.add(listener)
      return () => {
        foregroundListeners.delete(listener)
      }
    },
  }
  const setForeground = (next: boolean) => {
    foreground = next
    foregroundListeners.forEach(listener => listener())
  }
  // Lets a mint's whole chain settle (setImmediate is never faked here).
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
  }

  function publishAccount(pdsClient: Client) {
    publishCurrentClients({
      did: DID,
      handle: 'direct.test',
      pdsUrl: 'https://pds.example',
      pdsClient,
      prismClient: pdsClient,
      appviewClient: pdsClient,
    })
  }

  beforeEach(() => {
    foreground = true
    foregroundListeners.clear()
    mockRouteListeners.clear()
    mockPostingRoute = 'encode'
  })

  it('on posting route encode, mints a getPosts token at sign-in at once, its long one after it, and none again while it lasts', async () => {
    publishAccount(pdsClientFor())
    const stop = startDirectTokenPrefetch(DIRECT_PREFETCH_2K, env)
    await flush()
    // Nothing waits on the clock: a short token now, then the long one.
    expect(serviceAuthCalls().map(call => call.params.get('exp'))).toEqual([
      null,
      String(START_MS / 1000 + 3000),
    ])
    expect(serviceAuthCalls()[0].params.get('lxm')).toBe(
      'app.nearhorizon.private.getPosts',
    )
    setForeground(false)
    setForeground(true)
    mockRouteListeners.forEach(listener => listener())
    await flush()
    expect(serviceAuthCalls()).toHaveLength(2)
    stop()
  })

  it('upgrades a short token once: a second short answer stays until its refresh', async () => {
    // The PDS answers only with its default lifetime.
    serviceAuthAnswer = call =>
      call.params.has('exp')
        ? json({error: 'BadExpiration', message: 'skew'}, 400)
        : json({token: token({secs: 60})})
    publishAccount(pdsClientFor())
    const stop = startDirectTokenPrefetch(DIRECT_PREFETCH_2K, env)
    await flush()
    await flush()
    await flush()
    // Short; the upgrade (refused, then short again); no third round.
    expect(serviceAuthCalls().map(call => call.params.get('exp'))).toEqual([
      null,
      String(START_MS / 1000 + 3000),
      null,
    ])
    stop()
  })

  it.each(['locus', 'checking', 'none'])(
    'on posting route %s, mints nothing over sign-in, a foreground return and an hour',
    async route => {
      mockPostingRoute = route
      publishAccount(pdsClientFor())
      const stop = startDirectTokenPrefetch(DIRECT_PREFETCH_2K, env)
      await flush()
      now += 3_600_000
      setForeground(false)
      setForeground(true)
      await flush()
      expect(serviceAuthCalls()).toEqual([])
      stop()
    },
  )

  it('mints once when the route becomes encode', async () => {
    mockPostingRoute = 'checking'
    publishAccount(pdsClientFor())
    const stop = startDirectTokenPrefetch(DIRECT_PREFETCH_2K, env)
    await flush()
    expect(serviceAuthCalls()).toEqual([])
    mockPostingRoute = 'encode'
    mockRouteListeners.forEach(listener => listener())
    await flush()
    expect(serviceAuthCalls()).toHaveLength(1)
    stop()
  })

  it('mints nothing in the background or with no current account; an expired token is refreshed at once on return to the foreground', async () => {
    const stopSignedOut = startDirectTokenPrefetch(DIRECT_PREFETCH_2K, env)
    await flush()
    expect(serviceAuthCalls()).toEqual([])
    stopSignedOut()

    foreground = false
    publishAccount(pdsClientFor())
    const stop = startDirectTokenPrefetch(DIRECT_PREFETCH_2K, env)
    await flush()
    expect(serviceAuthCalls()).toEqual([])
    setForeground(true)
    await flush()
    expect(serviceAuthCalls()).toHaveLength(1)
    setForeground(false)
    now += 3_600_000
    setForeground(true)
    await flush()
    expect(serviceAuthCalls()).toHaveLength(2)
    stop()
  })

  it('refreshes in the background when 5 minutes are left, while in the foreground', async () => {
    jest.useFakeTimers({doNotFake: ['Date', 'setImmediate', 'nextTick']})
    try {
      publishAccount(pdsClientFor())
      const stop = startDirectTokenPrefetch(DIRECT_PREFETCH_2K, env)
      await flush()
      expect(serviceAuthCalls()).toHaveLength(1)
      now += 3_540_000 - 5 * 60_000
      jest.advanceTimersByTime(3_540_000 - 5 * 60_000)
      await flush()
      expect(serviceAuthCalls()).toHaveLength(2)
      stop()
    } finally {
      jest.useRealTimers()
    }
  })
})
