/*
 * Cross-tab adoption of an OAuth account for the DID this tab already shows.
 *
 * Adapted from the Witchsky client (MIT), src/state/session/index.tsx
 * (adopting another tab's OAuth account without rebroadcasting).
 */

import {logger} from '#/logger'
import {type OnSessionChange} from '#/state/session/session-core'
import {type SessionAccount} from '#/state/session/types'
import {
  disposeOAuthBundle,
  getOAuthBundleDid,
} from '#/horizon/session/oauth-bundles'
import {resumeAccountBundle} from '#/horizon/session/resume'
import {
  currentBundle,
  type HorizonSessionStore,
} from '#/horizon/session/session-store'

/**
 * Another tab persisted an OAuth account for the DID that is current here.
 *
 * - If this tab's bundle is already an OAuth bundle for that DID, nothing to
 *   do: its transport restores from the shared store on every request.
 * - Otherwise (this tab still holds a password bundle for the DID, because
 *   another tab signed it in again with OAuth), build the OAuth bundle with a
 *   cold-start resume and swap it in with `replaced-current-bundle`, which
 *   does not persist and so does not echo back to other tabs.
 *
 * A failed restore leaves the tab as it is; its next request finds the state.
 * The membership probe follows the bundle change by itself.
 */
export async function adoptOAuthAccount(
  store: HorizonSessionStore,
  account: SessionAccount,
  onSessionChange: OnSessionChange,
) {
  const previous = currentBundle(store)
  if (getOAuthBundleDid(previous) === account.did) return
  let result: Awaited<ReturnType<typeof resumeAccountBundle>>
  try {
    result = await resumeAccountBundle(account, onSessionChange, false)
  } catch (e) {
    logger.warn('session: adopting the OAuth account failed', {
      message: e instanceof Error ? e.message : String(e),
    })
    return
  }
  const latest = store.getState()
  if (
    currentBundle(store) !== previous ||
    latest.currentBundleState.did !== account.did
  ) {
    disposeOAuthBundle(result.bundle)
    return
  }
  store.dispatch({
    type: 'replaced-current-bundle',
    newBundle: result.bundle,
    newAccount: result.account,
  })
}
