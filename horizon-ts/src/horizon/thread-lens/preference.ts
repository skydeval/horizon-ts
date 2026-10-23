/*
 * The Thread Lens device value (Phase 4 design 4.2, TL-16): one per device,
 * not per account, under `horizon:threadLens` in Horizon's own device keys,
 * which tell other tabs on web.
 *
 * Stored values are `"1"` and `"0"`; Horizon 1.0's `"true"` and `"false"`,
 * written to the same key on the same origin, read as the same. Anything
 * else, or no value, means the account's default: on for a `member`, off for
 * every other membership state. Writing the value that equals the current
 * account's default removes the key, so the only stored values are a
 * member's "off" and a non-member's "on", and neither changes what another
 * account on the device gets by default.
 *
 * Render-time readers subscribe (TL-34): the device key through
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

/** The device key (4.2). */
export const THREAD_LENS_PREFERENCE_KEY = 'horizon:threadLens'

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

/** The device's stored choice, if any. A plain read, for non-render code. */
export function readLensPreference(): boolean | undefined {
  return parseLensPreference(readLocal(THREAD_LENS_PREFERENCE_KEY))
}

/** Whether the lens is on for `did` on this device. A plain read. */
export function getThreadLensPreference(did: string | undefined): boolean {
  if (!did) return false
  return readLensPreference() ?? lensDefaultFor(getMembership(did))
}

/**
 * Turn the lens on or off for this device, from `did`'s controls. The
 * account's own default is written as no value (4.2).
 */
export function setThreadLensPreference(did: string | undefined, on: boolean) {
  if (!did) return
  const fallback = lensDefaultFor(getMembership(did))
  writeLocal(
    THREAD_LENS_PREFERENCE_KEY,
    on === fallback ? undefined : on ? '1' : '0',
  )
}

function subscribePreference(listener: () => void) {
  return subscribeLocal(THREAD_LENS_PREFERENCE_KEY, listener)
}

/**
 * Whether the lens is on for `did` on this device, kept current: another
 * tab's write, either control, and `did`'s membership becoming `member`
 * (an `indexing` account's unset value turns on by itself) re-render.
 */
export function useThreadLensPreference(did: string | undefined): boolean {
  // Both reads run on every render (rules of hooks).
  const stored = useSyncExternalStore(subscribePreference, () =>
    parseLensPreference(readLocal(THREAD_LENS_PREFERENCE_KEY)),
  )
  const membership = useMembership(did)
  if (!did) return false
  return stored ?? lensDefaultFor(membership)
}
