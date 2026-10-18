/*
 * A screen's Public | Private mode (9, 9.2), one store per screen
 * (Notifications, Saved). Each is held for one account: the mode is Public
 * for any other account, so an account change resets it without a
 * subscription (D2-36). Only members get the Private mode, and only while
 * the screen's switch is on; for anyone else it is always Public.
 */

import {useSyncExternalStore} from 'react'

import {useSession} from '#/state/session'
import {useIsMember} from '#/horizon/private/membership'

export type PrivateMode = 'public' | 'private'

/**
 * One screen's mode store.
 */
export type ModeStore = {
  /** The mode chosen for `did`: Public unless that account chose Private. */
  get: (did: string | undefined) => PrivateMode
  /**
   * Choose the mode for `did`. Choosing for another account replaces the
   * previous account's choice.
   */
  set: (did: string, mode: PrivateMode) => void
  /** Whether the screen shows its Private view. */
  shows: (opts: {mode: PrivateMode; isMember: boolean}) => boolean
  /** Whether the tabs are offered. */
  offers: (isMember: boolean) => boolean
  /** The current account's chosen mode, kept current. */
  useMode: () => PrivateMode
  /** Whether the screen shows its Private view, kept current. */
  usePrivateMode: () => boolean
}

/**
 * A mode store guarded by `enabled` (the screen's switch, read on every
 * call so tests can change it).
 */
export function createModeStore(enabled: () => boolean): ModeStore {
  let state: {did: string; mode: PrivateMode} | undefined
  const listeners = new Set<() => void>()

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const get = (did: string | undefined): PrivateMode =>
    did && state?.did === did ? state.mode : 'public'

  const set = (did: string, mode: PrivateMode) => {
    if (state?.did === did && state.mode === mode) return
    state = {did, mode}
    listeners.forEach(listener => listener())
  }

  const shows = ({mode, isMember}: {mode: PrivateMode; isMember: boolean}) =>
    enabled() && isMember && mode === 'private'

  const offers = (isMember: boolean) => enabled() && isMember

  function useMode(): PrivateMode {
    const {currentAccount} = useSession()
    const did = currentAccount?.did
    return useSyncExternalStore(subscribe, () => get(did))
  }

  function usePrivateMode(): boolean {
    const mode = useMode()
    const isMember = useIsMember()
    return shows({mode, isMember})
  }

  return {get, set, shows, offers, useMode, usePrivateMode}
}
