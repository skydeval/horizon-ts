/*
 * An OAuth session that ends remotely is handled as an expired session.
 *
 * A death is read only from this window's own evidence (system accounts
 * design SA-25, 6.4). The library broadcasts every session deletion to every
 * other window and replays it into the deletion hook there, with the cause
 * structured-cloned into a plain `Error`. So a deletion counts only when its
 * cause is, in this realm, a refresh failure (`isOAuthRefreshFailure`):
 * another window's sign-out, a registration popup replacing a session, and
 * Horizon's own revocations are never deaths here. A real death in another
 * window is found at this window's next request, by the library's getter (a
 * same-window `TokenRefreshError`) or by the transport, which reports it
 * through {@link reportOAuthSessionLost}.
 */

import {emitSessionDropped} from '#/state/events'
import {getOAuthBundleDid} from '#/horizon/session/oauth-bundles'
import {
  addOAuthSessionDeletedListener,
  isOAuthRefreshFailure,
} from '#/horizon/session/oauth-client'
import {
  currentBundle,
  type HorizonSessionStore,
} from '#/horizon/session/session-store'

let activeStore: HorizonSessionStore | undefined

type LostListener = (did: string) => void

const lostListeners = new Set<LostListener>()

/**
 * Called with the DID whenever an OAuth session is reported lost, for any
 * DID, current or not (system accounts design 6.4, SA-H7). Returns the
 * unsubscribe function.
 */
export function addOAuthSessionLostListener(listener: LostListener) {
  lostListeners.add(listener)
  return () => {
    lostListeners.delete(listener)
  }
}

/**
 * Report that the OAuth session for `did` is gone. Every lost listener hears
 * it. If it belongs to the current bundle, the "session expired" toast shows
 * and the reducer drops to the signed-out bundle and marks the account,
 * exactly as for an expired password session.
 */
export function reportOAuthSessionLost(did: string) {
  lostListeners.forEach(listener => listener(did))
  const store = activeStore
  if (!store) return
  const bundle = currentBundle(store)
  if (getOAuthBundleDid(bundle) !== did) return
  emitSessionDropped()
  store.dispatch({
    type: 'received-session-event',
    bundle,
    accountDid: did,
    refreshedAccount: undefined,
    sessionEvent: 'expired',
  })
}

/**
 * Watch the OAuth library for deleted sessions. Only a refresh failure in
 * this window is a death (see the file header); every other deletion
 * (sign-out, a re-authorization, the password gate, the transport ending a
 * dead session, which reports the loss itself, and anything broadcast from
 * another window) is ignored. Returns the unsubscribe function.
 */
export function watchOAuthSessionDeath(store: HorizonSessionStore) {
  activeStore = store
  const unsubscribe = addOAuthSessionDeletedListener((did, cause) => {
    if (!isOAuthRefreshFailure(cause)) return
    reportOAuthSessionLost(did)
  })
  return () => {
    unsubscribe()
    if (activeStore === store) activeStore = undefined
  }
}
