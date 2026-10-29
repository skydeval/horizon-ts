/*
 * Turning Bluesky's moderation labeler off, for adults (skydeval,
 * 2026-10-29). See `README.md`.
 */

import {useEffect} from 'react'
import {useQueryClient} from '@tanstack/react-query'

import {usePreferencesQuery} from '#/state/queries/preferences'
import {useSession} from '#/state/session'
import {useAgeAssurance} from '#/ageAssurance'
import {applyBskyModeration} from '#/horizon/bsky-moderation/apply'
import {
  type BskyModerationLock,
  bskyModerationLock,
} from '#/horizon/bsky-moderation/lock'
import {
  setBskyModerationOff,
  useBskyModerationOff,
} from '#/horizon/bsky-moderation/setting'

export type {BskyModerationLock} from '#/horizon/bsky-moderation/lock'

export type BskyModerationState = {
  /** Signed in: the switch is shown. */
  available: boolean
  /** Bluesky's labeler is in use. */
  on: boolean
  /** Why it can't be turned off, or null. */
  lock: BskyModerationLock
  setOn: (on: boolean) => void
}

export function useBskyModeration(): BskyModerationState {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const prefs = usePreferencesQuery()
  const aa = useAgeAssurance()
  const off = useBskyModerationOff(did)
  const lock = bskyModerationLock({
    age: prefs.data?.userAge,
    declaredAdult: prefs.data?.declaredAge?.isOverAge18 === true,
    ageCheckLocks: aa.flags.adultContentDisabled,
  })
  // Until the account's age is known, it stays on.
  const known = prefs.data !== undefined
  return {
    available: !!did,
    on: !(off && known && lock === null),
    lock: known ? lock : 'noAge',
    setOn: on => {
      if (did) setBskyModerationOff(did, !on)
    },
  }
}

/**
 * Keeps the requests in step with the account's choice. When it changes
 * them, everything read under the old list is read again (the account's
 * labelers come from preferences, labels from each view). Mounted once, in
 * `HorizonHost`.
 */
export function BskyModerationSync() {
  const {on} = useBskyModeration()
  const queryClient = useQueryClient()
  /*
   * Also on each preferences read: a session setup puts Bluesky's labeler
   * back on the list (`configureModerationForAccount`), and this takes it
   * off again.
   */
  const prefsReadAt = usePreferencesQuery().dataUpdatedAt
  useEffect(() => {
    if (applyBskyModeration(on)) {
      void queryClient.invalidateQueries()
    }
  }, [on, prefsReadAt, queryClient])
  return null
}
