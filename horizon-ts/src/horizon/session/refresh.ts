/*
 * The explicit refresh (`refreshSession`) for an OAuth bundle.
 */

import {type PublicSessionBundle} from '#/state/session/session-core'
import {type SessionAccount} from '#/state/session/types'
import {oauthAccountFrom} from '#/horizon/session/oauth-account'
import {getOAuthBundleInfo} from '#/horizon/session/oauth-bundles'
import {restoreOAuthSession} from '#/horizon/session/oauth-transport'
import {
  currentBundle,
  type HorizonSessionStore,
} from '#/horizon/session/session-store'
import {com} from '#/lexicons'

/**
 * Rotate an OAuth bundle's tokens and hand back the fresh account, with the
 * contract the stock `refreshSession` callers rely on: a resolution means the
 * tokens rotated. Resolves `undefined` for the public bundle, as before.
 *
 * Forces a refresh (which rotates or rejects), reads the account fields with
 * `getSession`, rejects if the bundle stopped being current meanwhile, and
 * dispatches the account as an `update` event.
 */
export async function refreshOAuthBundle(
  store: HorizonSessionStore,
  bundle: PublicSessionBundle,
): Promise<SessionAccount | undefined> {
  const info = getOAuthBundleInfo(bundle)
  if (!info) return undefined
  const session = await restoreOAuthSession(info.did, true)
  const {aud} = await session.getTokenInfo(false)
  const data = await bundle.pdsClient.call(com.atproto.server.getSession, {})
  if (currentBundle(store) !== bundle) {
    throw new Error('The session changed while it was being refreshed')
  }
  const account = oauthAccountFrom(
    {issuer: session.serverMetadata.issuer, aud},
    data,
  )
  store.dispatch({
    type: 'received-session-event',
    bundle,
    accountDid: info.did,
    refreshedAccount: account,
    sessionEvent: 'update',
  })
  return account
}
