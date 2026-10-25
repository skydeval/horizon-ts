/*
 * What keeps the system accounts' device state in step with the switcher
 * (system accounts design 6.4, 6.5), started by Horizon's session provider:
 *
 * - The sweep reads the switcher from the provider's store and runs on app
 *   open, on every switcher change (another tab's arrives through the
 *   persisted sync), on every list change and on every session death.
 * - A session reported lost, for any DID: its system entry is marked "Sign
 *   in again" and, for a switcher account, its cached list gets `diedAt`
 *   (SAR3-L5). Horizon's own revocations are not deaths.
 * - A switcher account that stops being able to act gets `diedAt` (a death;
 *   a sign-out deletes the list right after, SA-21). A successful sign-in
 *   for a DID (an account that can act again, or that becomes current)
 *   clears its `diedAt` and its "Sign in again" mark (4.4, SAR3-N7).
 *
 * The current account's list read and the announcer mount in `HorizonHost`
 * (`SystemAccountsHost.tsx`), so the session provider loads no prism code.
 */

import {type SessionAccount} from '#/state/session/types'
import {canAccountAct} from '#/horizon/session/accounts'
import {isRevokingOAuthGrant} from '#/horizon/session/revoke'
import {addOAuthSessionLostListener} from '#/horizon/session/session-death'
import {clearListDied, markListDied, subscribeLists} from './list-store'
import {
  clearNeedsSignIn,
  markNeedsSignIn,
  subscribeEntries,
} from './session-store'
import {
  resetSweepForTests,
  runSweep,
  scheduleSweepTimer,
  setSwitcherAccountsSource,
} from './sweep'

/** The part of the stock store the runtime reads. */
export type RuntimeStore = {
  getState(): {
    accounts: SessionAccount[]
    currentBundleState: {did: string | undefined}
  }
  subscribe(listener: () => void): () => void
}

function signedIn(did: string) {
  clearListDied(did)
  clearNeedsSignIn(did)
}

/** Start the runtime for `store`. Returns the stop function. */
export function startSystemAccounts(store: RuntimeStore): () => void {
  setSwitcherAccountsSource(() => store.getState().accounts)
  let accounts = store.getState().accounts
  let currentDid = store.getState().currentBundleState.did

  const stops: (() => void)[] = []

  stops.push(
    addOAuthSessionLostListener(did => {
      if (isRevokingOAuthGrant(did)) return
      markNeedsSignIn(did)
      if (store.getState().accounts.some(a => a.did === did)) markListDied(did)
      void runSweep()
    }),
  )

  stops.push(
    store.subscribe(() => {
      const state = store.getState()
      const nextDid = state.currentBundleState.did
      if (state.accounts === accounts && nextDid === currentDid) return
      for (const account of state.accounts) {
        const before = accounts.find(a => a.did === account.did)
        const could = !!before && canAccountAct(before)
        const can = canAccountAct(account)
        if (could && !can) markListDied(account.did)
        if (!could && can) signedIn(account.did)
      }
      if (nextDid && nextDid !== currentDid) {
        const account = state.accounts.find(a => a.did === nextDid)
        if (account && canAccountAct(account)) signedIn(nextDid)
      }
      accounts = state.accounts
      currentDid = nextDid
      void runSweep()
    }),
  )

  // A list read or write in this tab or another one.
  stops.push(subscribeLists(() => void runSweep()))
  // Another tab's registration sets this tab's timers too.
  stops.push(subscribeEntries(() => scheduleSweepTimer()))

  // App open.
  void runSweep()

  return () => {
    stops.forEach(stop => stop())
    resetSweepForTests()
  }
}
