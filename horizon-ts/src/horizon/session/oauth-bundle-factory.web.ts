/*
 * Build OAuth session bundles: the three stock clients over one OAuth
 * transport, registered in the Horizon side store.
 *
 * Adapted from the Witchsky client (MIT),
 * src/state/session/oauth-session-bundle.ts and
 * src/state/session/oauth-agent.ts (the bounded restore wait).
 */

import {XrpcResponseError} from '@atproto/lex'
import {type OAuthSession} from '@atproto/oauth-client-browser'

import {logger} from '#/logger'
import {
  buildAppviewClient,
  buildChatClient,
  buildPdsClient,
} from '#/state/session/clients'
import {configureModerationForAccount} from '#/state/session/moderation'
import {type PublicSessionBundle} from '#/state/session/session-core'
import {type SessionAccount} from '#/state/session/types'
import {withoutSignedOutMark} from '#/horizon/session/accounts'
import {
  isAuthError,
  isTokenRefusal,
  OAuthSessionBusyError,
  OAuthSessionEndedError,
} from '#/horizon/session/auth-errors'
import {bounded, OAUTH_WAIT_MS} from '#/horizon/session/bounded'
import {oauthAccountFrom} from '#/horizon/session/oauth-account'
import {
  disposeOAuthBundle,
  registerOAuthBundle,
} from '#/horizon/session/oauth-bundles'
import {reportOAuthBusyResume} from '#/horizon/session/oauth-busy-report'
import {waitForOAuthLock} from '#/horizon/session/oauth-lock'
import {
  createOAuthTransport,
  restoreOAuthSession,
} from '#/horizon/session/oauth-transport'
import {com} from '#/lexicons'

/**
 * An OAuth bundle has the public-bundle shape; the side store marks it.
 */
export type OAuthSessionBundle = PublicSessionBundle

/**
 * Build the clients for `account.did` over one OAuth transport and register
 * the bundle. `service` is the account's authorization server.
 */
export function createOAuthBundle(
  account: {did: string; service: string},
  {needsAccountRefresh = false}: {needsAccountRefresh?: boolean} = {},
): OAuthSessionBundle {
  const lifecycle = {killed: false}
  const transport = createOAuthTransport(account.did, lifecycle)
  const bundle: OAuthSessionBundle = {
    session: null,
    appviewClient: buildAppviewClient(transport),
    pdsClient: buildPdsClient(transport),
    chatClient: buildChatClient(transport),
    service: new URL(account.service),
  }
  registerOAuthBundle(bundle, {
    did: account.did,
    kill: () => {
      lifecycle.killed = true
    },
    needsAccountRefresh,
  })
  return bundle
}

function getSession(bundle: OAuthSessionBundle) {
  return bounded(
    bundle.pdsClient.call(com.atproto.server.getSession, {}),
    OAUTH_WAIT_MS,
    () => new OAuthSessionBusyError(),
  )
}

/**
 * The bundle and account for a session that just completed an OAuth sign-in.
 */
export async function createOAuthSessionBundleAndLogin(
  session: OAuthSession,
): Promise<{account: SessionAccount; bundle: OAuthSessionBundle}> {
  const issuer = session.serverMetadata.issuer
  const {aud} = await session.getTokenInfo(false)
  const bundle = createOAuthBundle({did: session.did, service: issuer})
  try {
    const data = await getSession(bundle)
    const account = oauthAccountFrom({issuer, aud}, data)
    configureModerationForAccount(bundle, account)
    return {account, bundle}
  } catch (e) {
    disposeOAuthBundle(bundle)
    throw e
  }
}

/**
 * How long a launch waits in all for a busy stored session before it settles
 * into signed out.
 */
export const OAUTH_LAUNCH_WAIT_MS = 60_000

/**
 * The least time the read after the lock frees gets, however little of the
 * launch wait is left.
 */
const OAUTH_RETRY_MIN_MS = 2_000

function busy() {
  return new OAuthSessionBusyError()
}

/**
 * Read the stored session at launch, never refreshing. A read normally
 * answers at once. One still waiting after `OAUTH_WAIT_MS` is held up by the
 * library's lock in another document (often a Horizon page frozen in the
 * back/forward cache while holding it): keep the launch's loading state, wait
 * for the lock to be free and read again, all within `OAUTH_LAUNCH_WAIT_MS`.
 * Giving up rejects busy and reports it, so the signed-out launch says why.
 */
async function restoreAtLaunch(did: string): Promise<OAuthSession> {
  const started = Date.now()
  const remaining = () => started + OAUTH_LAUNCH_WAIT_MS - Date.now()
  const first = restoreOAuthSession(did, false)
  try {
    return await bounded(first, OAUTH_WAIT_MS, busy)
  } catch (e) {
    if (!(e instanceof OAuthSessionBusyError)) throw e
  }
  logger.info('oauth resume: the stored session is busy; waiting for its lock')
  try {
    const wait = await waitForOAuthLock(did, Math.max(remaining(), 0))
    if (wait === 'timeout') throw busy()
    if (wait === 'unavailable') {
      return await bounded(first, Math.max(remaining(), 0), busy)
    }
    // The lock was free: read again (the first read may still be finishing).
    return await bounded(
      restoreOAuthSession(did, false),
      Math.max(remaining(), OAUTH_RETRY_MIN_MS),
      busy,
    )
  } catch (e) {
    if (e instanceof OAuthSessionBusyError) reportOAuthBusyResume()
    throw e
  }
}

/**
 * Resume a stored OAuth account.
 *
 * A cold start reads the store without refreshing; a read held up by another
 * document's lock waits for it (see `restoreAtLaunch`), within a bound, so a
 * stalled store cannot hold the launch forever. An offline start still builds
 * the bundle and its requests fail until the network returns.
 *
 * A switch refreshes an expired access token and checks the session with the
 * server before the switch happens, so a session the server ended fails here
 * (and the switcher offers a fresh sign-in) instead of after the switch. A
 * network failure or a slow server lets the switch proceed.
 */
export async function createOAuthSessionBundleAndResume(
  storedAccount: SessionAccount,
  isSwitchingAccounts: boolean,
): Promise<{account: SessionAccount; bundle: OAuthSessionBundle}> {
  const did = storedAccount.did
  /*
   * A switch gives up after the usual wait and rejects busy, so the account
   * chooser can say so; the restore itself still finishes in the background
   * (a refresh it started is stored), and a later click is not queued behind
   * it for longer than that wait.
   */
  const session = isSwitchingAccounts
    ? await bounded(restoreOAuthSession(did, 'auto'), OAUTH_WAIT_MS, busy)
    : await restoreAtLaunch(did)
  const {aud} = await session.getTokenInfo(false)
  let account: SessionAccount = {
    ...withoutSignedOutMark(storedAccount),
    pdsUrl: new URL(aud).toString(),
  }
  const bundle = createOAuthBundle(account, {
    needsAccountRefresh: !isSwitchingAccounts,
  })

  if (isSwitchingAccounts) {
    try {
      const data = await getSession(bundle)
      account = oauthAccountFrom(
        {issuer: session.serverMetadata.issuer, aud},
        data,
      )
    } catch (e) {
      const ended =
        e instanceof XrpcResponseError
          ? isTokenRefusal(e.status, e.error)
          : isAuthError(e)
      if (ended) {
        disposeOAuthBundle(bundle)
        try {
          await session.signOut()
        } catch {
          // Already deleted by the library, or nothing stored: nothing to do.
        }
        throw new OAuthSessionEndedError()
      }
      // A network failure or the wait bound: switch as on a cold start.
    }
  }

  configureModerationForAccount(bundle, account)
  return {account, bundle}
}
