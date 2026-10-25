/*
 * Ending one account's session on this device: the OAuth grant through the
 * library's own `revoke`, and a password session through
 * `com.atproto.server.deleteSession`. Shared by the stock sign-out sequence
 * (`sign-out.ts`) and the system accounts' sweep.
 */

import {PasswordSession} from '@atproto/lex-password-session'

import {logger} from '#/logger'
import {networkAwareFetch} from '#/state/session/network'
import {sessionAccountToSessionData} from '#/state/session/session-data'
import {type SessionAccount} from '#/state/session/types'
import {isAuthError} from '#/horizon/session/auth-errors'
import {getOAuthClient, OAUTH_AVAILABLE} from '#/horizon/session/oauth-client'

function describe(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

const revoking = new Map<string, number>()

/**
 * Whether Horizon itself is revoking `did`'s OAuth grant now. The library
 * reports a revoke of a DID with nothing stored as a same-window refresh
 * failure; listeners use this to tell that apart from a death.
 */
export function isRevokingOAuthGrant(did: string): boolean {
  return (revoking.get(did) ?? 0) > 0
}

/**
 * Revoke the OAuth grant for `did` where the server offers revocation, and
 * delete the stored session and its DPoP key. The library's `revoke` deletes
 * them in a `finally`, so the local session is gone even when the server
 * cannot be reached (system accounts design 6.5, SAR1-L1). A session that is
 * not stored counts as success. Never throws.
 */
export async function revokeOAuthGrant(did: string) {
  if (!OAUTH_AVAILABLE) return
  revoking.set(did, (revoking.get(did) ?? 0) + 1)
  try {
    await getOAuthClient().revoke(did)
  } catch (e) {
    if (!isAuthError(e)) {
      logger.warn('sign-out: OAuth revocation failed', {message: describe(e)})
    }
  } finally {
    const left = (revoking.get(did) ?? 1) - 1
    if (left > 0) revoking.set(did, left)
    else revoking.delete(did)
  }
}

/**
 * End a password session on its server, best effort, with no lifecycle
 * hooks: the tokens are already forgotten on this device. Never throws.
 */
export async function endPasswordSession(account: SessionAccount) {
  if (!account.refreshJwt) return
  try {
    await PasswordSession.delete(sessionAccountToSessionData(account), {
      fetch: networkAwareFetch,
    })
  } catch (e) {
    logger.debug('sign-out: ending a password session failed', {
      message: describe(e),
    })
  }
}
