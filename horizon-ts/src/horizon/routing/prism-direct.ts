/*
 * Calling prism directly (2K design 3.5, PA-6, PA-36; prism's fast-reads
 * hand-off), not through the account's PDS, so a private read's answer never
 * passes the reader's PDS.
 *
 * - The transport is a plain `fetch` (the network-aware one the signed-out
 *   prism client uses), never the OAuth transport: on web that transport
 *   treats a 401 without `atproto-proxy` as the PDS session dying and can
 *   sign the member out. A prism 401 only drops the token and retries once
 *   with a fresh one.
 * - The token is a service token from `com.atproto.server.getServiceAuth` on
 *   the account's own PDS (that one call goes through the PDS client, as any
 *   PDS call does), with `aud` prism's `#bsky_appview` service, `lxm` the exact
 *   method and `exp` now + 2,700 s on the PDS's clock (learned from the last
 *   token's `iat`).
 * - Tokens are kept in memory per `(did, lxm)` for the token's own
 *   `exp - iat`, counted from receipt, never compared with the device clock;
 *   dropped on an account switch, on sign-out and on a 401. Never persisted
 *   and never logged.
 *
 * 2K uses it for `app.nearhorizon.private.getPosts` (PA-7), and prefetches
 * that token on posting route `encode` only, refreshing it in the background
 * while the app is in the foreground (PA-29, `startDirectTokenPrefetch`).
 * The prefetch takes its methods and routes as parameters, so chainlink #5
 * widens both without restructuring, and moves the other prism methods here.
 *
 * System accounts' writes and proofs (system accounts design SA-18) take the
 * one-shot mode instead (`mintOneShotPrismToken`, `getOneShotPrismClient`):
 * uncached, no `exp`, no same-body resend.
 */

import {type Client, type FetchHandler, XrpcResponseError} from '@atproto/lex'
import {type DidString, type NsidString} from '@atproto/syntax'

import {createLexClient} from '#/lib/lexClient'
import {getServiceAuthToken} from '#/lib/media/video/upload.shared'
import {networkAwareFetch} from '#/state/session/network'
import {
  getCurrentClients,
  PrivateClientUnavailableError,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  ORIGIN_CLOCK_AVAILABLE,
  readOriginClockOffsetSecs,
} from '#/horizon/routing/origin-clock'
import {PRISM_SERVICE, PRISM_URL} from '#/horizon/routing/prism'
import {
  getWriteRoute,
  type PrivateWriteRoute,
  subscribeWriteRoutes,
} from '#/horizon/routing/write-route'

/**
 * prism's own-post read, the method 2K calls directly.
 */
export const PRIVATE_GET_POSTS_LXM =
  'app.nearhorizon.private.getPosts' as NsidString

/**
 * The token lifetime asked for, on the PDS's own clock: under prism's
 * 3,600 s `exp - iat` bound (PR-8) and the PDS's one-hour cap.
 *
 * The device clock never decides an `exp` (2026-10-26, skydeval; a device a
 * minute ahead had `now + 3,540 s` refused with `BadExpiration`, a round
 * trip on every cold open). As the stock proxy path does, it goes by the
 * PDS's clock: the first token for an account asks no `exp` (the PDS's
 * default, about 60 s on its own clock, which cannot be refused), its `iat`
 * gives the PDS's clock against the device's, and later tokens ask
 * `exp` = the PDS's now + this. A `BadExpiration` anyway asks again with no
 * `exp` and learns the clock again.
 */
export const DIRECT_TOKEN_SECS = 3_000

/**
 * The PDS's clock minus the device's, in whole seconds, by account (each
 * account's own PDS), learned from the last token's `iat`: the PDS's time
 * when it signed it. The round trip makes it a little behind, which only
 * errs toward an earlier `exp` and an earlier refresh.
 */
const serverOffsets = new Map<string, number>()

/**
 * The server clock minus the device's, in whole seconds, from Horizon's own
 * site's `Date` header at app load (web; skydeval, 2026-10-26): a
 * same-origin header script can read, so the first token can already ask a
 * long `exp`. Servers' clocks agree (NTP); a learned PDS offset replaces it.
 */
let originOffsetSecs: number | undefined
let originClock: Promise<void> | undefined

/**
 * Learn the server clock from Horizon's own site, once; resolves when known
 * or given up on (native, a failure, or {@link ORIGIN_CLOCK_WAIT_MS}).
 */
export function learnOriginClock(): Promise<void> {
  originClock ??= Promise.race([
    readOriginClockOffsetSecs().then(
      offset => {
        if (offset !== undefined) originOffsetSecs = offset
      },
      () => {},
    ),
    new Promise<void>(resolve => setTimeout(resolve, ORIGIN_CLOCK_WAIT_MS)),
  ])
  return originClock
}

/** How long the prefetch waits for the site's clock before minting. */
export const ORIGIN_CLOCK_WAIT_MS = 1_500

/** The PDS's clock now for `did`, in seconds, once learned. */
function pdsNowSecs(did: string, now = Date.now()): number | undefined {
  const offset = serverOffsets.get(did) ?? originOffsetSecs
  return offset === undefined ? undefined : Math.floor(now / 1000) + offset
}

/** Learn `did`'s PDS clock from a token it just signed. */
function learnServerClock(did: string, token: string, receivedAt: number) {
  const iat = tokenClaims(token)?.iat
  if (typeof iat !== 'number') return
  serverOffsets.set(did, iat - Math.floor(receivedAt / 1000))
}

/**
 * The wait after a `getServiceAuth` 429 whose headers are missing or not
 * readable from script (PA-36).
 */
export const SERVICE_AUTH_LIMIT_DEFAULT_MS = 60_000

/**
 * A token whose payload cannot be read is used for this long: the PDS's
 * default lifetime.
 */
const UNREADABLE_TOKEN_MS = 60_000

/**
 * A token is not used in the last part of its life, so a request does not
 * reach prism with an expired one.
 */
const EXPIRY_MARGIN_MS = 60_000

/**
 * `getServiceAuth` answered 429; no new token is asked for before
 * `retryAt` (milliseconds since the epoch, device clock).
 */
export class DirectPrismRateLimitedError extends Error {
  readonly retryAt: number

  constructor(retryAt: number) {
    super('The server is limiting service token requests')
    this.name = 'DirectPrismRateLimitedError'
    this.retryAt = retryAt
  }
}

type CachedToken = {
  token: string
  /** The account the token is for, whose PDS clock its `exp` is on. */
  did: string
  receivedAt: number
  lifetimeMs: number
  /** The token's own `exp` (the PDS's clock), when readable. */
  expSecs?: number
  /**
   * Asked with no `exp` (the PDS's clock not yet known): the prefetch
   * replaces it with a long one as soon as the clock is known.
   */
  upgradable?: true
}

/** Tokens by DID, then by method. */
const tokens = new Map<string, Map<string, CachedToken>>()
/** Mints in flight, by `did lxm`. */
const pending = new Map<string, Promise<string>>()
/** No `getServiceAuth` for this DID before this time (PA-36). */
const limitedUntil = new Map<string, number>()
/**
 * Bumped by every drop, so a mint that answers after its account was
 * switched away or signed out is not cached.
 */
let epoch = 0

let unwatch: (() => void) | undefined
let watchedDid: string | undefined

/**
 * Drops every token when the current account changes or signs out. Started
 * on first use, so importing this module subscribes to nothing.
 */
function watchAccount() {
  if (unwatch) return
  watchedDid = getCurrentClients()?.did
  unwatch = subscribeCurrentClients(() => {
    const did = getCurrentClients()?.did
    if (did === watchedDid) return
    watchedDid = did
    dropDirectPrismTokens()
  })
}

/**
 * Drop the cached tokens: every one, or only those of `did`.
 */
export function dropDirectPrismTokens(did?: string) {
  epoch++
  if (did === undefined) {
    tokens.clear()
    pending.clear()
    limitedUntil.clear()
  } else {
    tokens.delete(did)
    for (const key of pending.keys()) {
      if (key.startsWith(`${did} `)) pending.delete(key)
    }
    limitedUntil.delete(did)
  }
}

function dropToken(did: string, lxm: string) {
  tokens.get(did)?.delete(lxm)
}

/**
 * How much of `entry`'s life is left: its own `exp` against the PDS's clock
 * now, never the device's; for a token whose claims cannot be read, its
 * lifetime counted from receipt.
 */
function remainingMs(entry: CachedToken, now: number): number {
  const pdsNow = pdsNowSecs(entry.did, now)
  if (entry.expSecs !== undefined && pdsNow !== undefined) {
    return (entry.expSecs - pdsNow) * 1000
  }
  return entry.receivedAt + entry.lifetimeMs - now
}

/** A short token the prefetch can now replace with a long one. */
function upgradeDue(entry: CachedToken): boolean {
  return !!entry.upgradable && pdsNowSecs(entry.did) !== undefined
}

function usable(entry: CachedToken | undefined, now: number): boolean {
  if (!entry) return false
  const margin = Math.min(EXPIRY_MARGIN_MS, entry.lifetimeMs / 2)
  return remainingMs(entry, now) > margin
}

function didOf(pdsClient: Client): string {
  try {
    return pdsClient.assertDid
  } catch {
    throw new PrivateClientUnavailableError()
  }
}

/**
 * The token's lifetime from its own claims, `exp - iat`; the payload is read,
 * not verified (prism verifies it).
 */
export function tokenLifetimeMs(token: string): number {
  const claims = tokenClaims(token)
  if (!claims) return UNREADABLE_TOKEN_MS
  const {exp, iat} = claims
  if (typeof exp !== 'number' || typeof iat !== 'number' || exp <= iat) {
    return UNREADABLE_TOKEN_MS
  }
  return (exp - iat) * 1000
}

/** A token's claims, read, not verified; `undefined` when unreadable. */
function tokenClaims(
  token: string,
): {exp?: unknown; iat?: unknown} | undefined {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const claims: unknown = JSON.parse(atob(padded))
    if (typeof claims !== 'object' || claims === null) return undefined
    return claims
  } catch {
    return undefined
  }
}

/**
 * How long to wait after a 429, from its headers when script can read them:
 * `ratelimit-reset` (epoch seconds), else `Retry-After` (seconds or an HTTP
 * date), else `defaultMs`. A missing or unreadable header is not an error
 * (PA-36).
 */
export function rateLimitWaitMs(
  headers: Headers | undefined,
  defaultMs: number,
  now: number = Date.now(),
): number {
  const reset = headers?.get('ratelimit-reset')?.trim()
  if (reset && /^\d+$/.test(reset)) {
    const wait = Number(reset) * 1000 - now
    if (wait > 0) return wait
  }
  const retryAfter = headers?.get('retry-after')?.trim()
  if (retryAfter) {
    const wait = /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000
      : new Date(retryAfter).getTime() - now
    if (wait > 0) return wait
  }
  return defaultMs
}

/**
 * A new token for `lxm`: with `exp` the PDS's now + {@link DIRECT_TOKEN_SECS}
 * once its clock is known, else (and after a `BadExpiration`) with no `exp`.
 * `long` says the `exp` was asked for. A short one is replaced by a long one
 * when the prefetch refreshes it, at half its life, or by the next ask.
 */
async function mint(
  pdsClient: Client,
  did: string,
  lxm: NsidString,
): Promise<{token: string; long: boolean}> {
  const pdsNow = pdsNowSecs(did)
  const exps =
    pdsNow === undefined ? [undefined] : [pdsNow + DIRECT_TOKEN_SECS, undefined]
  for (let i = 0; ; i++) {
    const exp = exps[i]
    try {
      const token = await getServiceAuthToken({
        client: pdsClient,
        aud: PRISM_SERVICE,
        lxm,
        exp,
      })
      learnServerClock(did, token, Date.now())
      return {token, long: exp !== undefined}
    } catch (error) {
      if (error instanceof XrpcResponseError) {
        if (error.error === 'BadExpiration' && i < exps.length - 1) {
          continue
        }
        if (error.status === 429) {
          const retryAt =
            Date.now() +
            rateLimitWaitMs(error.headers, SERVICE_AUTH_LIMIT_DEFAULT_MS)
          limitedUntil.set(did, retryAt)
          throw new DirectPrismRateLimitedError(retryAt)
        }
      }
      throw error
    }
  }
}

function cacheToken(
  did: string,
  lxm: string,
  token: string,
  {short, upgraded}: {short: boolean; upgraded: boolean},
) {
  let byMethod = tokens.get(did)
  if (!byMethod) {
    byMethod = new Map()
    tokens.set(did, byMethod)
  }
  const exp = tokenClaims(token)?.exp
  byMethod.set(lxm, {
    token,
    did,
    receivedAt: Date.now(),
    lifetimeMs: tokenLifetimeMs(token),
    ...(typeof exp === 'number' ? {expSecs: exp} : {}),
    // A short token from an upgrade stays until its natural refresh: no loop.
    ...(short && !upgraded ? {upgradable: true} : {}),
  })
}

/**
 * The service token for calling `lxm` on prism directly as the account of
 * `pdsClient`: the cached one while it lasts, else a new one. Concurrent
 * asks for the same token share one `getServiceAuth`. `fresh` skips the
 * cache (after a 401).
 *
 * Throws `PrivateClientUnavailableError` for a client without a session,
 * `DirectPrismRateLimitedError` while the PDS is limiting token requests, and
 * the PDS's error otherwise.
 */
export function getDirectPrismToken(
  pdsClient: Client,
  lxm: NsidString,
  {fresh = false, upgrade = false}: {fresh?: boolean; upgrade?: boolean} = {},
): Promise<string> {
  watchAccount()
  const did = didOf(pdsClient)
  const now = Date.now()
  const cached = tokens.get(did)?.get(lxm)
  if (!fresh && cached && usable(cached, now)) {
    return Promise.resolve(cached.token)
  }
  const retryAt = limitedUntil.get(did)
  if (retryAt !== undefined) {
    if (retryAt > now) {
      return Promise.reject(new DirectPrismRateLimitedError(retryAt))
    }
    limitedUntil.delete(did)
  }
  const key = `${did} ${lxm}`
  const inFlight = pending.get(key)
  if (inFlight) return inFlight

  const startedIn = epoch
  const request = mint(pdsClient, did, lxm)
    .then(({token, long}) => {
      if (epoch === startedIn) {
        cacheToken(did, lxm, token, {short: !long, upgraded: upgrade})
      }
      return token
    })
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key)
    })
  pending.set(key, request)
  return request
}

function methodOf(path: string): NsidString {
  const match = /^\/xrpc\/([^/?#]+)/.exec(path)
  if (!match) throw new TypeError('Not an XRPC path')
  return match[1] as NsidString
}

/** Whether a request body can be sent a second time. */
function canResend(body: RequestInit['body']): boolean {
  return !(
    typeof ReadableStream !== 'undefined' && body instanceof ReadableStream
  )
}

function directFetchHandler(pdsClient: Client, did: string): FetchHandler {
  return async (path, init) => {
    const lxm = methodOf(path)
    const url = new URL(path, PRISM_URL)
    const send = (token: string) => {
      const headers = new Headers(init.headers)
      headers.delete('atproto-proxy')
      headers.set('authorization', `Bearer ${token}`)
      return networkAwareFetch(url, {...init, headers})
    }
    const response = await send(await getDirectPrismToken(pdsClient, lxm))
    if (response.status !== 401 || !canResend(init.body)) return response
    // One retry with a fresh token; the session is never touched.
    dropToken(did, lxm)
    return send(await getDirectPrismToken(pdsClient, lxm, {fresh: true}))
  }
}

const directClients = new WeakMap<Client, Client>()

/**
 * The client that calls prism directly as the account of `pdsClient`, with
 * a service token per method and no `atproto-proxy` header. Cached against
 * the PDS client, so it lives and dies with the bundle; its tokens are kept
 * per DID.
 */
export function getDirectPrismClient(pdsClient: Client): Client {
  let client = directClients.get(pdsClient)
  if (!client) {
    const did = didOf(pdsClient)
    client = createLexClient(
      {did: did as DidString, fetchHandler: directFetchHandler(pdsClient, did)},
      {appLabelers: null},
    )
    directClients.set(pdsClient, client)
  }
  return client
}

/**
 * A one-shot service token for calling (or proving) `lxm` on prism as the
 * account of `pdsClient` (system accounts design SA-18, 5.2, SA-H8): minted
 * with no `exp`, so the PDS's own default lifetime applies (60 s on the
 * PDSes in use) and a skewed device clock cannot cause a `BadExpiration`;
 * never taken from or put in the token cache, and never the 1,800 s
 * fallback. Any account's PDS client may mint, not only the current one's.
 * A 429 is honoured as for cached tokens (PA-36).
 */
export async function mintOneShotPrismToken(
  pdsClient: Client,
  lxm: NsidString,
): Promise<string> {
  const did = didOf(pdsClient)
  const retryAt = limitedUntil.get(did)
  if (retryAt !== undefined) {
    if (retryAt > Date.now()) throw new DirectPrismRateLimitedError(retryAt)
    limitedUntil.delete(did)
  }
  try {
    return await getServiceAuthToken({
      client: pdsClient,
      aud: PRISM_SERVICE,
      lxm,
    })
  } catch (error) {
    if (error instanceof XrpcResponseError && error.status === 429) {
      const at =
        Date.now() +
        rateLimitWaitMs(error.headers, SERVICE_AUTH_LIMIT_DEFAULT_MS)
      limitedUntil.set(did, at)
      throw new DirectPrismRateLimitedError(at)
    }
    throw error
  }
}

const oneShotClients = new WeakMap<Client, Client>()

/**
 * The client that calls prism directly as the account of `pdsClient` with a
 * fresh one-shot token on every request (SA-H8): no `atproto-proxy`, no
 * token cache, and no resend on a 401 (the generic handler resends the same
 * body, which would replay a one-shot proof; the caller re-mints instead,
 * SAR3-N5).
 */
export function getOneShotPrismClient(pdsClient: Client): Client {
  let client = oneShotClients.get(pdsClient)
  if (!client) {
    const did = didOf(pdsClient)
    const fetchHandler: FetchHandler = async (path, init) => {
      const lxm = methodOf(path)
      const token = await mintOneShotPrismToken(pdsClient, lxm)
      const headers = new Headers(init.headers)
      headers.delete('atproto-proxy')
      headers.set('authorization', `Bearer ${token}`)
      return networkAwareFetch(new URL(path, PRISM_URL), {...init, headers})
    }
    client = createLexClient(
      {did: did as DidString, fetchHandler},
      {appLabelers: null},
    )
    oneShotClients.set(pdsClient, client)
  }
  return client
}

/**
 * What the prefetch mints, and on which posting routes (PA-29). 2K's: the
 * `getPosts` token on `encode` only, so the locus route has nothing new on
 * the wire (D-0.10).
 */
export type DirectPrefetchOptions = {
  methods: readonly NsidString[]
  /**
   * The posting routes the prefetch runs on, or `'any'` for every route
   * (refract client design 7.1: Refract's tokens serve non-members too).
   */
  routes: readonly PrivateWriteRoute[] | 'any'
}

export const DIRECT_PREFETCH_2K: DirectPrefetchOptions = {
  methods: [PRIVATE_GET_POSTS_LXM],
  routes: ['encode'],
}

/**
 * A token is refreshed in the background when this much of its life is
 * left (PA-29).
 */
export const DIRECT_REFRESH_BEFORE_MS = 5 * 60_000

/**
 * The app's foreground state, as the prefetch needs it.
 */
export type ForegroundEnv = {
  isForeground(): boolean
  /** Calls the listener on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

/**
 * Prefetch and refresh the current account's tokens for `options.methods`
 * while its posting route is one of `options.routes` and the app is in the
 * foreground (PA-29): at sign-in, at resume and when the route becomes one
 * of them (each a change this listens to), a missing or expired token is
 * minted at once; a cached one is refreshed when
 * {@link DIRECT_REFRESH_BEFORE_MS} of its life is left. Nothing is minted in
 * the background or for an account that is not current. A failure is
 * dropped: the read that needs the token mints it then. Returns the stop
 * function.
 */
export function startDirectTokenPrefetch(
  options: DirectPrefetchOptions,
  env: ForegroundEnv,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  const active = () => {
    const current = getCurrentClients()
    if (!current || !env.isForeground()) return undefined
    if (options.routes === 'any') return current
    const route = getWriteRoute(current.did).postingRoute
    return options.routes.includes(route) ? current : undefined
  }

  const schedule = (did: string) => {
    clear()
    if (stopped) return
    let next = Number.POSITIVE_INFINITY
    const now = Date.now()
    for (const lxm of options.methods) {
      const cached = tokens.get(did)?.get(lxm)
      if (!cached) continue
      const at = upgradeDue(cached)
        ? now
        : now +
          remainingMs(cached, now) -
          Math.min(DIRECT_REFRESH_BEFORE_MS, cached.lifetimeMs / 2)
      next = Math.min(next, at)
    }
    if (next === Number.POSITIVE_INFINITY) return
    timer = setTimeout(() => tick({refresh: true}), Math.max(0, next - now))
  }

  const tick = ({refresh = false}: {refresh?: boolean} = {}) => {
    if (stopped) return
    const current = active()
    if (!current) {
      clear()
      return
    }
    const now = Date.now()
    const asks = options.methods.map(lxm => {
      const cached = tokens.get(current.did)?.get(lxm)
      const upgrade = !!cached && upgradeDue(cached)
      const due =
        !cached ||
        !usable(cached, now) ||
        upgrade ||
        (refresh &&
          remainingMs(cached, now) <=
            Math.min(DIRECT_REFRESH_BEFORE_MS, cached.lifetimeMs / 2))
      if (!due) return Promise.resolve()
      return getDirectPrismToken(current.pdsClient, lxm, {
        fresh: !!cached,
        upgrade,
      }).then(
        () => undefined,
        () => undefined,
      )
    })
    void Promise.all(asks).then(() => {
      if (getCurrentClients()?.did === current.did) schedule(current.did)
    })
  }

  const unsubscribes = [
    subscribeWriteRoutes(() => tick()),
    env.subscribe(() => tick()),
  ]
  /*
   * Nothing waits on the clock (2026-10-26, round 4): the first mint goes
   * now (no exp while the clock is unknown, so a short token), the site's
   * clock is read beside it on web, and the short token is replaced with a
   * long one as soon as either clock answers.
   */
  tick()
  if (ORIGIN_CLOCK_AVAILABLE && originOffsetSecs === undefined) {
    void learnOriginClock().then(() => {
      const did = getCurrentClients()?.did
      if (did && !stopped) schedule(did)
    })
  }
  return () => {
    stopped = true
    clear()
    unsubscribes.forEach(unsubscribe => unsubscribe())
  }
}

/**
 * Test-only: forget every token, mint and watch.
 */
export function resetDirectPrism() {
  dropDirectPrismTokens()
  serverOffsets.clear()
  originOffsetSecs = undefined
  originClock = undefined
  unwatch?.()
  unwatch = undefined
  watchedDid = undefined
}
