/*
 * Resume a stored account by its session kind.
 */

import {
  createSessionBundleAndResume,
  type OnSessionChange,
  type PublicSessionBundle,
  type SessionBundle,
} from '#/state/session/session-core'
import {type SessionAccount} from '#/state/session/types'
import {isOauthAccount} from '#/horizon/session/accounts'
import {createOAuthSessionBundleAndResume} from '#/horizon/session/oauth-bundle-factory'

/**
 * Build the bundle for a stored account: the stock password resume for a
 * password account, the OAuth resume for an OAuth account. `isSwitchingAccounts`
 * makes the OAuth resume check the session with the server first.
 */
export function resumeAccountBundle(
  storedAccount: SessionAccount,
  onSessionChange: OnSessionChange,
  isSwitchingAccounts: boolean,
): Promise<{
  account: SessionAccount
  bundle: SessionBundle | PublicSessionBundle
}> {
  if (isOauthAccount(storedAccount)) {
    return createOAuthSessionBundleAndResume(storedAccount, isSwitchingAccounts)
  }
  return createSessionBundleAndResume(storedAccount, onSessionChange)
}
