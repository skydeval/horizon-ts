/*
 * The aster switch, kept per account on the device like the Thread Lens
 * value (`preference.ts`): one key per DID, `horizon:aster:<did>`, in
 * Horizon's own device keys, which tell other tabs on web. Off unless the
 * account turned it on, so a granted account sees no aster action until it
 * chooses to. Stored as `"1"`; off is no value.
 */

import {useSyncExternalStore} from 'react'

import {
  readLocal,
  subscribeLocal,
  writeLocal,
} from '#/horizon/session/local-store'

/** The device key of `did`'s value. */
export function asterPreferenceKey(did: string): string {
  return `horizon:aster:${did}`
}

/** Whether the aster switch is on for `did` on this device. A plain read. */
export function getAsterPreference(did: string | undefined): boolean {
  return did ? readLocal(asterPreferenceKey(did)) === '1' : false
}

/** Turn the aster switch on or off for `did` on this device. */
export function setAsterPreference(did: string | undefined, on: boolean) {
  if (!did) return
  writeLocal(asterPreferenceKey(did), on ? '1' : undefined)
}

function noKey() {
  return () => {}
}

/** {@link getAsterPreference}, re-rendering on a write from any control or tab. */
export function useAsterPreference(did: string | undefined): boolean {
  const key = did ? asterPreferenceKey(did) : undefined
  return useSyncExternalStore(
    key ? listener => subscribeLocal(key, listener) : noKey,
    () => (key ? readLocal(key) === '1' : false),
  )
}
