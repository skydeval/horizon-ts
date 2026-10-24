/*
 * The Thread Lens device value (Phase 4 design 4.2, TL-16), kept per account
 * on the device (skydeval, after live check 18): one key per DID,
 * `horizon:threadLens:<did>`, in Horizon's own device keys, which tell other
 * tabs on web. Changing it for one account never changes what another
 * account on the same device gets.
 *
 * Stored values are `"1"` and `"0"` (`"true"` and `"false"` read the same).
 * Anything else, or no value, means the account's default: on for a
 * `member`, off for every other membership state. Writing the value that
 * equals the account's current default removes its key, so an `indexing`
 * account that never chose still turns on by itself when it becomes
 * `member`.
 *
 * The old unkeyed `horizon:threadLens` (one value for the whole device) is
 * ignored: Horizon is pre-alpha, so it is not migrated.
 *
 * Render-time readers subscribe (TL-34): the account's key through
 * `subscribeLocal`, membership through `useMembership`.
 */

import {useSyncExternalStore} from 'react'

import {
  getMembership,
  type MembershipState,
  useMembership,
} from '#/horizon/routing/membership'
import {
  readLocal,
  subscribeLocal,
  writeLocal,
} from '#/horizon/session/local-store'

/** The device key of `did`'s value (4.2). */
export function threadLensPreferenceKey(did: string): string {
  return `horizon:threadLens:${did}`
}

/** The stored choice, if any: `"1"` / `"true"` on, `"0"` / `"false"` off. */
export function parseLensPreference(
  value: string | undefined,
): boolean | undefined {
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return undefined
}

/** The default for a membership state (Q1): on only for a ready member. */
export function lensDefaultFor(state: MembershipState): boolean {
  return state === 'member'
}

/** `did`'s stored choice on this device, if any. A plain read. */
export function readLensPreference(did: string): boolean | undefined {
  return parseLensPreference(readLocal(threadLensPreferenceKey(did)))
}

/** Whether the lens is on for `did` on this device. A plain read. */
export function getThreadLensPreference(did: string | undefined): boolean {
  if (!did) return false
  return readLensPreference(did) ?? lensDefaultFor(getMembership(did))
}

/**
 * Turn the lens on or off for `did` on this device. The account's own
 * default is written as no value (4.2).
 */
export function setThreadLensPreference(did: string | undefined, on: boolean) {
  if (!did) return
  const fallback = lensDefaultFor(getMembership(did))
  writeLocal(
    threadLensPreferenceKey(did),
    on === fallback ? undefined : on ? '1' : '0',
  )
}

function noKey() {
  return () => {}
}

/**
 * Whether the lens is on for `did` on this device, kept current: another
 * tab's write for `did`, either control, and `did`'s membership becoming
 * `member` (an `indexing` account's unset value turns on by itself)
 * re-render. An account switch re-reads under the new account's key.
 */
export function useThreadLensPreference(did: string | undefined): boolean {
  const key = did ? threadLensPreferenceKey(did) : undefined
  // Both reads run on every render (rules of hooks).
  const stored = useSyncExternalStore(
    key ? listener => subscribeLocal(key, listener) : noKey,
    () => (key ? parseLensPreference(readLocal(key)) : undefined),
  )
  const membership = useMembership(did)
  if (!did) return false
  return stored ?? lensDefaultFor(membership)
}
