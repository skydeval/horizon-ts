/*
 * The lex `Agent` an OAuth bundle's clients send through.
 *
 * Adapted from the Witchsky client (MIT),
 * src/state/session/oauth-client-adapter.ts.
 */

import {type Agent} from '@atproto/lex'
import {type OAuthSession} from '@atproto/oauth-client-browser'

import {logger} from '#/logger'
import {
  isAuthError,
  isTokenRefusal,
  OAuthSessionBusyError,
} from '#/horizon/session/auth-errors'
import {bounded, OAUTH_WAIT_MS} from '#/horizon/session/bounded'
import {getOAuthClient} from '#/horizon/session/oauth-client'
import {reportOAuthSessionLost} from '#/horizon/session/session-death'

/**
 * How long one forced refresh covers: at most one per DID in this window, and
 * a 401 after a successful forced refresh counts only inside it.
 */
export const PROBE_WINDOW_MS = 60_000

/**
 * The transport's lifecycle, owned by the bundle: once `killed`, every request
 * throws before any I/O, as the stock kill switch does for password bundles.
 */
export type OAuthTransportLifecycle = {killed: boolean}

const restoreChains = new Map<string, Promise<unknown>>()

/**
 * Restore the stored OAuth session for `did`, one restore per DID at a time.
 *
 * - `false`: read the store, never refresh.
 * - `'auto'`: refresh only when the access token has (nearly) expired.
 * - `true`: force a refresh.
 *
 * A restore waits for the one before it, but at most `OAUTH_WAIT_MS`: one
 * stuck on the library's lock (held by a frozen document) must not queue
 * every later restore behind it forever. Moving on cannot start a second
 * refresh: the library reads and refreshes only inside its exclusive Web Lock
 * (see `oauth-lock.ts`), so the next restore waits there and then reads what
 * the earlier one stored. Nothing here cancels a restore: callers may stop
 * waiting (`bounded`), but an exchange in flight still completes and is
 * stored, so a single-use refresh token is never lost.
 */
export function restoreOAuthSession(
  did: string,
  refresh: boolean | 'auto',
): Promise<OAuthSession> {
  const client = getOAuthClient()
  const previous = restoreChains.get(did)
  const turn = previous
    ? bounded(previous, OAUTH_WAIT_MS, () => new OAuthSessionBusyError()).catch(
        () => {},
      )
    : Promise.resolve()
  const result = turn.then(() =>
    client.restore(did, refresh === 'auto' ? undefined : refresh),
  )
  const chain = result.catch(() => {})
  restoreChains.set(did, chain)
  void chain.then(() => {
    if (restoreChains.get(did) === chain) restoreChains.delete(did)
  })
  return result
}

type ProbeState = {
  /** When the last forced refresh started. */
  forcedAt: number
  /** When the last forced refresh succeeded, if it did. */
  refreshedAt: number | undefined
}

const probes = new Map<string, ProbeState>()

/**
 * Forget the 401 probe bookkeeping and the restore queue (tests).
 */
export function resetOAuthTransportProbes() {
  probes.clear()
  restoreChains.clear()
}

async function readXrpcError(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json()
    if (body && typeof body === 'object' && 'error' in body) {
      const {error} = body
      return typeof error === 'string' ? error : undefined
    }
  } catch {
    // Not a JSON body.
  }
  return undefined
}

/**
 * A 401 straight from the PDS (no `atproto-proxy`, so not from an upstream
 * service). aurora-locus sends no `WWW-Authenticate`, so the library cannot
 * see a dead token by itself:
 *
 * 1. If no forced refresh ran for this DID in the last minute, force one. A
 *    definitive refusal deletes the session, which the library reports.
 * 2. If a forced refresh already succeeded in this window and this request
 *    was sent after it, a token error means the server refuses the refreshed
 *    token too (aurora-locus refreshes revoked grants): the session is dead.
 */
async function onPdsUnauthorized(
  did: string,
  response: Response,
  restoredAt: number,
) {
  const now = Date.now()
  const probe = probes.get(did)

  if (
    probe?.refreshedAt !== undefined &&
    restoredAt >= probe.refreshedAt &&
    now - probe.refreshedAt < PROBE_WINDOW_MS
  ) {
    const error = await readXrpcError(response)
    if (isTokenRefusal(response.status, error)) {
      probes.delete(did)
      try {
        const session = await restoreOAuthSession(did, false)
        await session.signOut()
      } catch (e) {
        logger.warn('oauth transport: deleting a dead session failed', {
          message: e instanceof Error ? e.message : String(e),
        })
      }
      reportOAuthSessionLost(did)
    }
    return
  }

  if (probe && now - probe.forcedAt < PROBE_WINDOW_MS) return

  const next: ProbeState = {forcedAt: now, refreshedAt: undefined}
  probes.set(did, next)
  try {
    await restoreOAuthSession(did, true)
    next.refreshedAt = Date.now()
  } catch (e) {
    if (isAuthError(e)) {
      reportOAuthSessionLost(did)
    }
  }
}

/**
 * Resolves when the page is shown again, while it is going into the
 * back/forward cache; undefined otherwise.
 */
let pageShown: Promise<void> | undefined
let showPage: (() => void) | undefined

/**
 * Once the page is leaving for the back/forward cache, new requests wait for
 * it to be shown again before they restore: a restore started now could take
 * the library's lock and then be frozen holding it, which stalls every other
 * Horizon page's restore of this account (the back/forward-cache sign-in
 * hang). Requests already past their restore are not affected.
 */
function watchPageCache() {
  if (typeof window === 'undefined' || !window.addEventListener) return
  window.addEventListener('pagehide', event => {
    if (!event.persisted || pageShown) return
    pageShown = new Promise(resolve => {
      showPage = resolve
    })
  })
  window.addEventListener('pageshow', () => {
    showPage?.()
    pageShown = undefined
    showPage = undefined
  })
}
watchPageCache()

/**
 * Build the transport for `did`. Each request restores the session from the
 * shared store first, so a tab always signs with the DPoP key the store holds
 * now (a re-authorization in another tab is honoured), then hands the request
 * to that session.
 */
export function createOAuthTransport(
  did: string,
  lifecycle: OAuthTransportLifecycle = {killed: false},
): Agent {
  return {
    get did() {
      return did as Agent['did']
    },
    async fetchHandler(path, init) {
      if (lifecycle.killed) {
        throw new Error('session disposed')
      }
      if (pageShown) {
        await pageShown
        if (lifecycle.killed) {
          throw new Error('session disposed')
        }
      }
      let session: OAuthSession
      try {
        session = await restoreOAuthSession(did, 'auto')
      } catch (e) {
        if (isAuthError(e)) {
          reportOAuthSessionLost(did)
        }
        throw e
      }
      if (lifecycle.killed) {
        throw new Error('session disposed')
      }
      const restoredAt = Date.now()
      const proxied = new Headers(init.headers).has('atproto-proxy')
      const response = await session.fetchHandler(path, init)
      if (response.status === 401 && !proxied) {
        await onPdsUnauthorized(did, response, restoredAt)
      }
      return response
    },
  }
}
