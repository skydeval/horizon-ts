/*
 * The Thread Lens calls sent to prism directly (speed pass, 2026-10-23), as
 * Refract's are (`refract/api.ts`, refract client design 7.1): a per-method
 * `#bsky_appview` service token from `routing/prism-direct.ts`, so a lens
 * read skips the hop through the account's PDS. The PDS-proxied prism
 * client stays the fallback:
 *
 * - when the call is not for the published account's own prism client (a
 *   test client, an account switch mid-read);
 * - when no token can be minted (no session, the PDS refusing or limiting
 *   `getServiceAuth`); direct calls then pause for the account, until the
 *   PDS's own `retryAt` after a 429, else {@link LENS_DIRECT_PAUSE_MS};
 * - when the direct call fails in transport (a network or CORS failure, or
 *   a 401 that survived the fresh-token retry); that call is sent again
 *   through the proxy at once and direct calls pause the same way.
 *
 * prism's own answers (a refusal, a 429, `Reindexing`, `InvalidRequest`)
 * are rethrown as they are: the proxy passes the same answers through, so
 * `api.ts` classifies them, records the refusal and the wait, and reports
 * them through `reportedPrismCall` exactly as before.
 */

import {
  type Client,
  XrpcFetchError,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'
import {type NsidString} from '@atproto/syntax'

import {getCurrentClients} from '#/horizon/routing/current-clients'

/**
 * The direct transport, `routing/prism-direct.ts`'s token and client,
 * installed by `TokenPrefetch.tsx` when it loads (it is mounted in
 * `HorizonHost`). It is installed rather than imported because
 * `prism-direct.ts` reaches the session module, which the lens modules and
 * their suites stay free of. Without it every lens call goes through the
 * proxy.
 */
export type LensDirectTransport = {
  /** Resolves when a token for `lxm` is at hand (cached or minted). */
  token: (pdsClient: Client, lxm: NsidString) => Promise<unknown>
  /** The client that calls prism directly as `pdsClient`'s account. */
  client: (pdsClient: Client) => Client
  /** The PDS's `retryAt` when a mint failed on its 429, else `undefined`. */
  limitedUntil: (error: unknown) => number | undefined
}

let transport: LensDirectTransport | undefined

/** Install (or, with `undefined`, remove) the direct transport. */
export function installLensDirect(next: LensDirectTransport | undefined) {
  transport = next
}

/** `getThread`'s method, the token's `lxm`. */
export const LENS_GET_THREAD_LXM =
  'app.nearhorizon.threadLens.getThread' as NsidString

/** `resolve`'s method, the token's `lxm`. */
export const LENS_RESOLVE_LXM =
  'app.nearhorizon.threadLens.resolve' as NsidString

/** How long direct calls pause for an account after a transport failure. */
export const LENS_DIRECT_PAUSE_MS = 5 * 60_000

/** No direct lens call for the DID before this time. */
const pausedUntil = new Map<string, number>()

function pause(did: string, until: number) {
  pausedUntil.set(did, Math.max(pausedUntil.get(did) ?? 0, until))
}

/** Tests: forget every pause. */
export function resetLensDirect() {
  pausedUntil.clear()
}

/** Whether direct calls are paused for `did`. */
export function isLensDirectPaused(did: string, now = Date.now()): boolean {
  const until = pausedUntil.get(did)
  if (until === undefined) return false
  if (until > now) return true
  pausedUntil.delete(did)
  return false
}

/**
 * The direct client for `did`'s call of `lxm`, or `undefined` when the
 * call goes through `proxy`. Awaits a token mint in flight (the prefetch's,
 * or one this call starts); a cached token answers at once.
 */
async function directClientFor(
  proxy: Client,
  did: string,
  lxm: NsidString,
): Promise<Client | undefined> {
  const direct = transport
  const clients = getCurrentClients()
  if (!direct || !clients) return undefined
  if (clients.did !== did || clients.prismClient !== proxy) return undefined
  if (isLensDirectPaused(did)) return undefined
  try {
    await direct.token(clients.pdsClient, lxm)
  } catch (error) {
    pause(did, direct.limitedUntil(error) ?? Date.now() + LENS_DIRECT_PAUSE_MS)
    return undefined
  }
  return direct.client(clients.pdsClient)
}

/** A direct call's failure that is the transport's, not prism's answer. */
function isTransportFault(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false
  if (error instanceof Error && error.name === 'AbortError') return false
  if (error instanceof XrpcFetchError) return true
  // Includes XrpcAuthenticationError, a 401 subclass.
  if (error instanceof XrpcResponseError) return error.status === 401
  if (error instanceof XrpcInvalidResponseError) return false
  // Anything else: a token mint that failed inside the 401 retry, or a throw.
  return true
}

/**
 * Send one lens call: directly when it can, else (or after a transport
 * failure) through `proxy`. `send` makes the call on the client given.
 */
export async function sendLensCall<T>(
  proxy: Client,
  did: string,
  lxm: NsidString,
  signal: AbortSignal,
  send: (client: Client) => Promise<T>,
): Promise<T> {
  const direct = await directClientFor(proxy, did, lxm)
  if (direct) {
    try {
      return await send(direct)
    } catch (error) {
      if (!isTransportFault(error, signal)) throw error
      pause(did, Date.now() + LENS_DIRECT_PAUSE_MS)
    }
  }
  return send(proxy)
}
