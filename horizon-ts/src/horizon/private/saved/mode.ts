/*
 * The Saved screen's Public | Private mode (9.2): an instance of
 * `tabs/mode-store.ts`, guarded by `PRIVATE_SAVED_SWITCH`.
 */

import {
  createModeStore,
  type PrivateMode,
} from '#/horizon/private/tabs/mode-store'
import {PRIVATE_SAVED_SWITCH} from '#/horizon/switches'

export type SavedMode = PrivateMode

const store = createModeStore(() => PRIVATE_SAVED_SWITCH)

/**
 * The mode chosen for `did`: Public unless that account chose Private.
 */
export const getSavedMode = store.get

/**
 * Choose the mode for `did`.
 */
export const setSavedMode = store.set

/**
 * Whether Saved shows the private list.
 */
export const showsPrivateSaved = store.shows

/**
 * Whether the tabs are offered (members, with the switch on).
 */
export const offersSavedSwitch = store.offers

/**
 * The current account's chosen mode, kept current.
 */
export const useSavedMode = store.useMode

/**
 * Whether the Saved screen shows the private list (Bkm 1), kept current.
 */
export const usePrivateSavedMode = store.usePrivateMode
