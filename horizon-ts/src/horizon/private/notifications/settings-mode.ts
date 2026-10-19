/*
 * The Notifications settings screen's Public | Private mode (Phase 3, batch
 * B, rolling list item 6): an instance of `tabs/mode-store.ts`, guarded by
 * `PRIVATE_NOTIFICATION_SETTINGS`. Its own store, so the settings screen
 * opens on Public whatever the notifications screen shows.
 */

import {createModeStore} from '#/horizon/private/tabs/mode-store'
import {PRIVATE_NOTIFICATION_SETTINGS} from '#/horizon/switches'

const store = createModeStore(() => PRIVATE_NOTIFICATION_SETTINGS)

/** The mode chosen for `did`: Public unless that account chose Private. */
export const getNotificationSettingsMode = store.get

/** Choose the mode for `did`. */
export const setNotificationSettingsMode = store.set

/** Whether the tabs are offered: the switch is on and the account a member. */
export const offersNotificationSettingsTabs = store.offers

/** The current account's chosen mode, kept current. */
export const useNotificationSettingsMode = store.useMode

/** Whether the screen shows the Private settings, kept current. */
export const usePrivateNotificationSettingsMode = store.usePrivateMode
