/*
 * The notifications screen's Public | Private mode (design 9): an instance of
 * `tabs/mode-store.ts`, guarded by `PRIVATE_NOTIFICATIONS_SWITCH`.
 */

import {
  createModeStore,
  type PrivateMode,
} from '#/horizon/private/tabs/mode-store'
import {PRIVATE_NOTIFICATIONS_SWITCH} from '#/horizon/switches'

export type NotificationsMode = PrivateMode

const store = createModeStore(() => PRIVATE_NOTIFICATIONS_SWITCH)

/**
 * The mode chosen for `did`: Public unless that account chose Private.
 */
export const getNotificationsMode = store.get

/**
 * Choose the mode for `did`. Choosing for another account replaces the
 * previous account's choice.
 */
export const setNotificationsMode = store.set

/**
 * Whether the screen shows the Private view: the switch is on, the account
 * is a member, and the mode it chose is Private.
 */
export const showsPrivateNotifications = store.shows

/**
 * Whether the switch is offered: the switch is on and the account is a
 * member.
 */
export const offersNotificationsSwitch = store.offers

/**
 * The current account's chosen mode, kept current.
 */
export const useNotificationsMode = store.useMode

/**
 * Whether the notifications screen shows the Private view (Notif 1), kept
 * current.
 */
export const usePrivateNotificationsMode = store.usePrivateMode
