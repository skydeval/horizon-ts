/*
 * The system accounts' part of signing out (system accounts design 6.5,
 * "The sign-out seam", SA-21, SAR1-B3, SAR2-L3, SAR3-L4), called by
 * `horizonSignOut` with the accounts signed out and the switcher accounts
 * after the stock dispatch:
 *
 * 1. Before any await: the signed-out accounts' cached lists are deleted;
 *    their own system entries are marked "Sign in again"; the grace and
 *    pending time of every entry they started is cleared (every entry's,
 *    when no switcher account is left usable: "Sign out of every account");
 *    and their registrations are abandoned (a result that still arrives is
 *    discarded by `register.ts`, and a new grant revoked).
 * 2. Still before any await: the sweep is computed from the accounts after
 *    and its revocations start, concurrently with the stock sign-out.
 * 3. After the stock sign-out: the sweep once more.
 */

import {type SessionAccount} from '#/state/session/types'
import {canAccountAct} from '#/horizon/session/accounts'
import {abandonRegistrations} from './abandon'
import {deleteLists} from './list-store'
import {getEntries, markNeedsSignIn, putEntry} from './session-store'
import {runSweep} from './sweep'

/**
 * Steps 1 and 2. Returns the sweep's revocations (started) and step 3, to
 * run once the stock sign-out settles.
 */
export function signOutSystemAccounts(
  signedOut: readonly SessionAccount[],
  accountsAfter: readonly SessionAccount[] | undefined,
): {revocations: Promise<void>; afterStock: () => Promise<void>} {
  const dids = new Set<string>(signedOut.map(account => account.did))
  const every =
    accountsAfter !== undefined && !accountsAfter.some(canAccountAct)
  deleteLists([...dids])
  for (const entry of Object.values(getEntries())) {
    if (dids.has(entry.did)) markNeedsSignIn(entry.did)
  }
  for (const entry of Object.values(getEntries())) {
    const started =
      entry.addingFor !== undefined && (every || dids.has(entry.addingFor))
    if (!started) continue
    putEntry({
      ...entry,
      addingSince: undefined,
      addingFor: undefined,
      pendingUntil: undefined,
    })
  }
  abandonRegistrations(
    registration => every || dids.has(registration.addingFor),
  )
  const revocations = runSweep(accountsAfter)
  return {revocations, afterStock: () => runSweep()}
}
