/*
 * The appearance device value on native: its own synchronous MMKV instance
 * (the shared local store is in-memory on native). Built, not verified in
 * Phase 3 (design N-1). `device-store.web.ts` is the web implementation.
 */

import {MMKV} from 'react-native-mmkv'

import {APPEARANCE_DEVICE_KEY} from '#/horizon/appearance/device-value'

let store: MMKV | undefined

function mmkv() {
  if (!store) store = new MMKV({id: 'horizon_appearance'})
  return store
}

/** The stored JSON, or `undefined`. */
export function readDeviceJson(): string | undefined {
  return mmkv().getString(APPEARANCE_DEVICE_KEY)
}

/** Replace the stored JSON. */
export function writeDeviceJson(json: string) {
  mmkv().set(APPEARANCE_DEVICE_KEY, json)
}

/** Call `listener` when the value changes. */
export function subscribeDeviceJson(listener: () => void): () => void {
  const subscription = mmkv().addOnValueChangedListener(key => {
    if (key === APPEARANCE_DEVICE_KEY) listener()
  })
  return () => subscription.remove()
}
