/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * How the push task may read a password account now (see `clients.ts`):
 * - `live`: borrow the app's own session for this account;
 * - `stored-access`: the app runs on another account, so use the stored
 *   access token while it is valid and never refresh;
 * - `resume`: no app is running, so the session may refresh and save;
 * - `none`: not now.
 */
export type PasswordRoute = 'live' | 'stored-access' | 'resume' | 'none'

export function passwordRoute({
  hasLiveBundle,
  appRunning,
  accessValid,
  canAct,
}: {
  hasLiveBundle: boolean
  appRunning: boolean
  accessValid: boolean
  canAct: boolean
}): PasswordRoute {
  if (hasLiveBundle) return 'live'
  if (!canAct) return 'none'
  if (appRunning) return accessValid ? 'stored-access' : 'none'
  return 'resume'
}
