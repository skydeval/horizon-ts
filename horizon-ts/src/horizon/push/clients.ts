/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * Signed-in clients for the push task, for either kind of account.
 *
 * OAuth: a throwaway bundle over the library's stored session. The library
 * locks each session while it reads or refreshes it, so this can run beside
 * the app's own bundle.
 *
 * Password: the stored tokens rotate on refresh and the app's session must
 * not be left holding a spent refresh token, so:
 * - the app's live bundle for this account is borrowed when there is one;
 * - with the app running on another account, the stored access token is used
 *   only while it is still valid, so nothing refreshes;
 * - with no app running (a runtime started just for the task), the session
 *   may refresh, and the new tokens are saved for the app's next launch.
 */

import {type Client} from '@atproto/lex'

import {isJwtExpired} from '#/lib/jwt'
import * as persisted from '#/state/persisted'
import {
  createSessionBundleFromStoredAccount,
  disposeBundle,
  type OnSessionChange,
  type SessionBundle,
} from '#/state/session/session-core'
import {type SessionAccount} from '#/state/session/types'
import {
  canAccountAct,
  isOauthAccount,
  isOAuthSignedOut,
} from '#/horizon/session/accounts'
import {isAppSessionLive, liveBundleFor} from '#/horizon/session/live'
import {createOAuthBundle} from '#/horizon/session/oauth-bundle-factory'
import {disposeOAuthBundle, isSignedInBundle} from '#/horizon/session/oauth-bundles'
import {passwordRoute} from './route'

export type PushClients = {
  appview: Client
  chat: Client
  /** The account host, through which prism is reached. */
  pds: Client
  dispose: () => void
}

/** Save a password session's rotated tokens into the stored accounts. */
const saveRotatedTokens: OnSessionChange = (_bundle, did, event, data) => {
  if (event !== 'update' || !data?.accessJwt || !data.refreshJwt) return
  const stored = persisted.get('session')
  const patch = <T extends {did: string}>(a: T): T =>
    a.did === did
      ? {...a, accessJwt: data.accessJwt, refreshJwt: data.refreshJwt}
      : a
  void persisted.write('session', {
    accounts: stored.accounts.map(patch),
    currentAccount: stored.currentAccount && patch(stored.currentAccount),
  })
}

const ignoreChanges: OnSessionChange = () => {}

export function openClients(account: SessionAccount): PushClients | undefined {
  if (isOauthAccount(account)) {
    if (isOAuthSignedOut(account) || !account.service) return undefined
    const bundle = createOAuthBundle({did: account.did, service: account.service})
    return {
      appview: bundle.appviewClient,
      chat: bundle.chatClient,
      pds: bundle.pdsClient,
      dispose: () => disposeOAuthBundle(bundle),
    }
  }

  const live = liveBundleFor(account.did) as SessionBundle | undefined
  const route = passwordRoute({
    hasLiveBundle: Boolean(live && isSignedInBundle(live)),
    appRunning: isAppSessionLive(),
    accessValid: Boolean(account.accessJwt) && !isJwtExpired(account.accessJwt!),
    canAct: canAccountAct(account),
  })
  switch (route) {
    case 'live':
      return {
        appview: live!.appviewClient,
        chat: live!.chatClient,
        pds: live!.pdsClient,
        dispose: () => {},
      }
    case 'none':
      return undefined
    case 'stored-access':
    case 'resume': {
      const built = createSessionBundleFromStoredAccount(
        account,
        route === 'resume' ? saveRotatedTokens : ignoreChanges,
      )
      if (!built) return undefined
      const {bundle} = built
      return {
        appview: bundle.appviewClient,
        chat: bundle.chatClient,
        pds: bundle.pdsClient,
        dispose: () => disposeBundle(bundle),
      }
    }
  }
}
