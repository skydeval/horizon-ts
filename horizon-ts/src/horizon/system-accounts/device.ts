/*
 * The system accounts' two device keys on native: their own synchronous MMKV
 * instance (the shared local store is in-memory on native), as appearance's
 * device value does. `device.web.ts` is the web implementation.
 */

import {MMKV} from 'react-native-mmkv'

let store: MMKV | undefined

function mmkv() {
  if (!store) store = new MMKV({id: 'horizon_system_accounts'})
  return store
}

/** The stored string, or `undefined`. */
export function readDevice(key: string): string | undefined {
  return mmkv().getString(key)
}

/** Replace the stored string; `undefined` removes it. */
export function writeDevice(key: string, value: string | undefined) {
  if (value === undefined) {
    mmkv().delete(key)
  } else {
    mmkv().set(key, value)
  }
}

/** Call `listener` when the key changes. Returns the unsubscribe function. */
export function subscribeDevice(key: string, listener: () => void) {
  const subscription = mmkv().addOnValueChangedListener(changed => {
    if (changed === key) listener()
  })
  return () => subscription.remove()
}
