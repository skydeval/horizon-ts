/*
 * An OAuth session that ends remotely is handled as an expired session.
 */

import {emitSessionDropped} from '#/state/events'
import {getOAuthBundleDid} from '#/horizon/session/oauth-bundles'
import {
  addOAuthSessionDeletedListener,
  isOAuthRevocationCause,
} from '#/horizon/session/oauth-client'
import {
  currentBundle,
  type HorizonSessionStore,
} from '#/horizon/session/session-store'

let activeStore: HorizonSessionStore | undefined

/**
 * Report that the OAuth session for `did` is gone. If it belongs to the
 * current bundle, the "session expired" toast shows and the reducer drops to
 * the signed-out bundle and marks the account, exactly as for an expired
 * password session. Any other DID: nothing.
 */
export function reportOAuthSessionLost(did: string) {
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
 * Watch the OAuth library for deleted sessions. Deletions this client asked
 * for (sign-out, re-authorization, the password gate) are ignored: sign-out
 * reaches other tabs through the persisted write, and a re-authorization
 * replaces the session rather than ending it. Returns the unsubscribe
 * function.
 */
export function watchOAuthSessionDeath(store: HorizonSessionStore) {
  activeStore = store
  const unsubscribe = addOAuthSessionDeletedListener((did, cause) => {
    if (isOAuthRevocationCause(cause)) return
    reportOAuthSessionLost(did)
  })
  return () => {
    unsubscribe()
    if (activeStore === store) activeStore = undefined
  }
}
