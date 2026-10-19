/*
 * The appearance device value on web: `localStorage` through Horizon's local
 * store, synchronous, other tabs through the `storage` event.
 */

import {APPEARANCE_DEVICE_KEY} from '#/horizon/appearance/device-value'
import {
  readLocal,
  subscribeLocal,
  writeLocal,
} from '#/horizon/session/local-store.web'

/** The stored JSON, or `undefined`. */
export function readDeviceJson(): string | undefined {
  return readLocal(APPEARANCE_DEVICE_KEY)
}

/** Replace the stored JSON. */
export function writeDeviceJson(json: string) {
  writeLocal(APPEARANCE_DEVICE_KEY, json)
}

/** Call `listener` when the value changes, here or in another tab. */
export function subscribeDeviceJson(listener: () => void): () => void {
  return subscribeLocal(APPEARANCE_DEVICE_KEY, listener)
}
