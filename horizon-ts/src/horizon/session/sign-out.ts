/*
 * Horizon's sign-out sequence, run after the stock reducer has signed the
 * accounts out locally.
 */

import {PasswordSession} from '@atproto/lex-password-session'

import {createLexClient} from '#/lib/lexClient'
import {unregisterPushToken} from '#/lib/notifications/notifications'
import {logger} from '#/logger'
import {networkAwareFetch} from '#/state/session/network'
import {sessionAccountToSessionData} from '#/state/session/session-data'
import {type SessionAccount} from '#/state/session/types'
import {IS_NATIVE} from '#/env'
import {isOauthAccount, isOAuthSignedOut} from '#/horizon/session/accounts'
import {isAuthError} from '#/horizon/session/auth-errors'
import {
  createOAuthTransport,
  restoreOAuthSession,
} from '#/horizon/session/oauth-transport'
import {THREAD_LENS} from '#/horizon/switches'
import {clearLensRefusals, clearLensWaits} from '#/horizon/thread-lens/api'
import {clearLensRegistry} from '#/horizon/thread-lens/registry'

/**
 * Signing out a password account also ends its session on the server
 * (`com.atproto.server.deleteSession`), best effort, as OAuth sign-out
 * revokes. Provisional (skydeval Q2). `false` keeps Bluesky's behaviour of
 * only forgetting the tokens.
 */
export const END_PASSWORD_SERVER_SESSION: boolean = true

function describe(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Revoke the OAuth grant for `did` where the server offers revocation, and
 * delete the stored session and its DPoP key. A session that is not stored
 * counts as success.
 */
export async function revokeOAuthGrant(did: string) {
  try {
    const session = await restoreOAuthSession(did, false)
    await session.signOut()
  } catch (e) {
    if (!isAuthError(e)) {
      logger.warn('sign-out: OAuth revocation failed', {message: describe(e)})
    }
  }
}

async function signOutOAuthAccount(account: SessionAccount) {
  if (isOAuthSignedOut(account)) return
  // 1. Push, through the account's own session. Returns at once on web.
  await unregisterPushToken([
    {
      client: createLexClient(createOAuthTransport(account.did)),
      service: account.service,
      handle: account.handle,
    },
  ])
  // 2. Revoke and delete.
  await revokeOAuthGrant(account.did)
}

async function signOutPasswordAccount(account: SessionAccount) {
  if (!account.refreshJwt) return
  if (!IS_NATIVE && !END_PASSWORD_SERVER_SESSION) {
    // Push unregistration is native only; nothing else needs a session.
    return
  }
  let session: PasswordSession
  try {
    /*
     * A temporary session without lifecycle hooks, so a rotation it performs
     * neither persists over nor races the stored tokens.
     */
    session = await PasswordSession.resume(
      sessionAccountToSessionData(account),
      {fetch: networkAwareFetch},
    )
  } catch (e) {
    // Definitively dead already: nothing left to end.
    logger.debug('sign-out: password session already ended', {
      message: describe(e),
    })
    return
  }
  // 1. Push, through the account's own session. Returns at once on web.
  await unregisterPushToken([
    {
      client: createLexClient(session),
      service: session.session.service,
      handle: session.session.handle,
    },
  ])
  // 3. End the server session.
  if (END_PASSWORD_SERVER_SESSION) {
    try {
      await session.logout()
    } catch (e) {
      logger.warn('sign-out: ending the password session failed', {
        message: describe(e),
      })
    }
  }
}

/**
 * Sign the accounts out at their servers, each in order: unregister push
 * through the account's own session, then revoke the OAuth grant (OAuth) or
 * end the server session (password). Never throws.
 */
export async function horizonSignOut(accounts: SessionAccount[]) {
  /*
   * Thread Lens's per-account stores (Phase 4 design 8.4, 11.5, 12.1): the
   * gap registry, the refusal record and the 429 wait with its timer.
   * Cleared before the first await, so a quick sign-in again as the same
   * account never has its new session's entries wiped (v9: R7-N5).
   */
  if (THREAD_LENS) {
    const dids = accounts.map(account => account.did)
    clearLensRegistry(dids)
    clearLensRefusals(dids)
    clearLensWaits(dids)
  }
  await Promise.all(
    accounts.map(async account => {
      try {
        if (isOauthAccount(account)) {
          await signOutOAuthAccount(account)
        } else {
          await signOutPasswordAccount(account)
        }
      } catch (e) {
        logger.warn('sign-out: failed', {message: describe(e)})
      }
    }),
  )
}
