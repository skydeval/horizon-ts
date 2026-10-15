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
 * Resume a stored OAuth account.
 *
 * A cold start reads the store without refreshing, bounded so a stalled store
 * cannot hold the launch; an offline start still builds the bundle and its
 * requests fail until the network returns.
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
  const session = isSwitchingAccounts
    ? await restoreOAuthSession(did, 'auto')
    : await bounded(
        restoreOAuthSession(did, false),
        OAUTH_WAIT_MS,
        () => new OAuthSessionBusyError(),
      )
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
