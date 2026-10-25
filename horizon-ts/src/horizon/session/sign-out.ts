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
import {clearMuteCache} from '#/horizon/mutes/cache'
import {isOauthAccount, isOAuthSignedOut} from '#/horizon/session/accounts'
import {createOAuthTransport} from '#/horizon/session/oauth-transport'
import {revokeOAuthGrant} from '#/horizon/session/revoke'
import {THREAD_LENS} from '#/horizon/switches'
import {signOutSystemAccounts} from '#/horizon/system-accounts/sign-out'
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

/*
 * The library's own `revoke` (system accounts design 6.5, SA-H5): it deletes
 * the stored session in a `finally`, so an offline sign-out still forgets
 * the grant. The old restore-then-sign-out deleted nothing when the restore
 * threw.
 */
export {revokeOAuthGrant}

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
 * end the server session (password). `accountsAfter` is the switcher as the
 * stock dispatch left it: the system accounts' seam clears the signed-out
 * accounts' lists and graces first and starts its own revocations alongside
 * the stock ones (system accounts design 6.5). Never throws.
 */
export async function horizonSignOut(
  accounts: SessionAccount[],
  accountsAfter?: readonly SessionAccount[],
) {
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
    // The reader's mutes kept on the device for the lens (`mutes/cache.ts`).
    clearMuteCache(dids)
  }
  // Steps 1 and 2 of the seam, before the first await (SAR2-L3).
  let system: ReturnType<typeof signOutSystemAccounts>
  try {
    system = signOutSystemAccounts(accounts, accountsAfter)
  } catch (e) {
    logger.warn('sign-out: system accounts failed', {message: describe(e)})
    system = {revocations: Promise.resolve(), afterStock: async () => {}}
  }
  const stock = Promise.all(
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
  await Promise.all([stock, system.revocations])
  // Step 3: once more, with the store as it is now.
  await system.afterStock()
}
