/*
 * Web syncs the appearance with the account (`sync-platform.ts` has the
 * app's side).
 */

import {APPEARANCE_SYNC} from '#/horizon/switches'

/** True on web. */
export const SYNCS_HERE: boolean = true

/** Whether the appearance is read from and saved to the account here. */
export function appearanceSyncs(): boolean {
  return APPEARANCE_SYNC && SYNCS_HERE
}
