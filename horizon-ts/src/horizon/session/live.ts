/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * The running app's session state, for code outside React (the push task).
 * Set when the session provider's store is created; unset in a JS runtime
 * started only for a background task, where no UI holds a session.
 */

type LiveState = {
  currentBundleState: {did?: string; bundle: unknown}
}

let getLive: (() => LiveState) | undefined

/** Called by the session store when it is created. */
export function setLiveSession(getState: () => LiveState) {
  getLive = getState
}

/** Whether the app UI (and so its session store) is running. */
export function isAppSessionLive(): boolean {
  return getLive !== undefined
}

/** The app's current bundle when it belongs to `did`. */
export function liveBundleFor(did: string): unknown {
  const state = getLive?.()
  if (!state || state.currentBundleState.did !== did) return undefined
  return state.currentBundleState.bundle ?? undefined
}
