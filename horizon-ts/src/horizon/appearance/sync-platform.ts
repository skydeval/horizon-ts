/*
 * Whether this platform syncs the appearance with the account. The app keeps
 * it on this device only: its backdrops draw differently from web's, so a
 * synced choice kept changing under it (skydeval, 2026-10-29). Web syncs
 * (`sync-platform.web.ts`). Jest runs as iOS, so its setup keeps this on for
 * the shared sync tests.
 */

import {APPEARANCE_SYNC} from '#/horizon/switches'

/** False in the app. */
export const SYNCS_HERE: boolean = false

/** Whether the appearance is read from and saved to the account here. */
export function appearanceSyncs(): boolean {
  return APPEARANCE_SYNC && SYNCS_HERE
}
