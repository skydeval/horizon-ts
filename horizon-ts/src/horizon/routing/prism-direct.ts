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
 *   method and `exp` now + 3,540 s.
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
 */

import {type Client, type FetchHandler, XrpcResponseError} from '@atproto/lex'
import {type DidString, type NsidString} from '@atproto/syntax'

import {createLexClient} from '#/lib/lexClient'
import {
  getServiceAuthToken,
  serviceAuthExp,
} from '#/lib/media/video/upload.shared'
import {networkAwareFetch} from '#/state/session/network'
import {
  getCurrentClients,
  PrivateClientUnavailableError,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
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
 * The token lifetime asked for: under prism's 3,600 s bound (PR-8).
 */
export const DIRECT_TOKEN_SECS = 3_540

/**
 * The lifetime asked for after a `BadExpiration` (a skewed device clock);
 * after a second one, the PDS's default.
 */
export const DIRECT_TOKEN_FALLBACK_SECS = 1_800

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
  receivedAt: number
  lifetimeMs: number
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

function usable(entry: CachedToken | undefined, now: number): boolean {
  if (!entry) return false
  const margin = Math.min(EXPIRY_MARGIN_MS, entry.lifetimeMs / 2)
  return now - entry.receivedAt < entry.lifetimeMs - margin
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
  try {
    const payload = token.split('.')[1]
    if (!payload) return UNREADABLE_TOKEN_MS
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const claims: unknown = JSON.parse(atob(padded))
    if (typeof claims !== 'object' || claims === null)
      return UNREADABLE_TOKEN_MS
    const {exp, iat} = claims as {exp?: unknown; iat?: unknown}
    if (typeof exp !== 'number' || typeof iat !== 'number' || exp <= iat) {
      return UNREADABLE_TOKEN_MS
    }
    return (exp - iat) * 1000
  } catch {
    return UNREADABLE_TOKEN_MS
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

async function mint(pdsClient: Client, did: string, lxm: NsidString) {
  // now + 3,540 s; after a BadExpiration now + 1,800 s; then the PDS's default.
  const lifetimes = [DIRECT_TOKEN_SECS, DIRECT_TOKEN_FALLBACK_SECS, undefined]
  for (let i = 0; ; i++) {
    const secs = lifetimes[i]
    try {
      return await getServiceAuthToken({
        client: pdsClient,
        aud: PRISM_SERVICE,
        lxm,
        exp: secs === undefined ? undefined : serviceAuthExp(secs),
      })
    } catch (error) {
      if (error instanceof XrpcResponseError) {
        if (error.error === 'BadExpiration' && i < lifetimes.length - 1) {
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
  {fresh = false}: {fresh?: boolean} = {},
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
    .then(token => {
      if (epoch === startedIn) {
        let byMethod = tokens.get(did)
        if (!byMethod) {
          byMethod = new Map()
          tokens.set(did, byMethod)
        }
        byMethod.set(lxm, {
          token,
          receivedAt: Date.now(),
          lifetimeMs: tokenLifetimeMs(token),
        })
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
    for (const lxm of options.methods) {
      const cached = tokens.get(did)?.get(lxm)
      if (!cached) continue
      const at =
        cached.receivedAt +
        cached.lifetimeMs -
        Math.min(DIRECT_REFRESH_BEFORE_MS, cached.lifetimeMs / 2)
      next = Math.min(next, at)
    }
    if (next === Number.POSITIVE_INFINITY) return
    timer = setTimeout(
      () => tick({refresh: true}),
      Math.max(0, next - Date.now()),
    )
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
      const due =
        !cached ||
        !usable(cached, now) ||
        (refresh &&
          now - cached.receivedAt >=
            cached.lifetimeMs -
              Math.min(DIRECT_REFRESH_BEFORE_MS, cached.lifetimeMs / 2))
      if (!due) return Promise.resolve()
      return getDirectPrismToken(current.pdsClient, lxm, {
        fresh: !!cached,
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
  tick()
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
  unwatch?.()
  unwatch = undefined
  watchedDid = undefined
}
