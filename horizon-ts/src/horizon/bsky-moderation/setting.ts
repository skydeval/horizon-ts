/*
 * The account's choice on this device, kept in account storage (not in a
 * public record, so turning Bluesky's moderation off isn't announced).
 */

import {useSyncExternalStore} from 'react'

import {account} from '#/storage'

export function getBskyModerationOff(did: string): boolean {
  try {
    return account.get([did, 'horizonBskyModerationOff']) === true
  } catch {
    return false
  }
}

export function setBskyModerationOff(did: string, off: boolean) {
  account.set([did, 'horizonBskyModerationOff'], off)
}

/** The stored choice for `did` (false when signed out). */
export function useBskyModerationOff(did: string | undefined): boolean {
  return useSyncExternalStore(
    listener => {
      if (!did) return () => {}
      const sub = account.addOnValueChangedListener(
        [did, 'horizonBskyModerationOff'],
        listener,
      )
      return () => sub.remove()
    },
    () => (did ? getBskyModerationOff(did) : false),
  )
}
