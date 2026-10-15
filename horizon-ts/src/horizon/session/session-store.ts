/*
 * The stock session store, typed structurally so Horizon's session code can
 * read and dispatch without widening Bluesky's types.
 */

import {type Action, type State} from '#/state/session/reducer'
import {
  type PublicSessionBundle,
  type SessionBundle,
} from '#/state/session/session-core'

/**
 * The part of the stock `SessionStore` Horizon uses.
 */
export type HorizonSessionStore = {
  getState(): State
  dispatch(action: Action): void
}

/**
 * The current bundle, with the type the stock provider reads it as.
 */
export function currentBundle(
  store: HorizonSessionStore,
): SessionBundle | PublicSessionBundle {
  return store.getState().currentBundleState.bundle as unknown as
    SessionBundle | PublicSessionBundle
}
