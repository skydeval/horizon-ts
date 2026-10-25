/*
 * The system accounts' two device keys on web, in `localStorage` through
 * Horizon's local store, which tells this tab at once and other tabs through
 * their `storage` event (system accounts design 6.3, "Tabs and the store").
 */

import {
  readLocal,
  subscribeLocal,
  writeLocal,
} from '#/horizon/session/local-store'

/** The stored string, or `undefined`. */
export function readDevice(key: string): string | undefined {
  return readLocal(key)
}

/** Replace the stored string; `undefined` removes it. */
export function writeDevice(key: string, value: string | undefined) {
  writeLocal(key, value)
}

/** Call `listener` when the key changes. Returns the unsubscribe function. */
export function subscribeDevice(key: string, listener: () => void) {
  return subscribeLocal(key, listener)
}
