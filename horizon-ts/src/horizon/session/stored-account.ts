/*
 * The stock reducer's `updated-stored-account` action (Phase 1 design 10,
 * deferred there; Phase 5 design 8.5, PA-4), and the way a temporary client
 * reaches it.
 *
 * A temporary client (the composer's "Posting as" another signed-in account,
 * `posting-as/temp-client.ts`) runs its own password session. When that
 * session rotates its tokens, the new tokens must be stored at once: the old
 * refresh token is spent, and the next resume of that account (a switch, a
 * cold start, another tab) reads the stored copy.
 */

import {type State} from '#/state/session/reducer'
import {type SessionAccount} from '#/state/session/types'

/**
 * The state with `account` stored in place of the stored account of the
 * same DID. Never the current account's: its live session owns its tokens,
 * and the composer only makes a temporary client for another account. An
 * account that is no longer stored (removed meanwhile) is not added back.
 */
export function updatedStoredAccount(
  state: State,
  account: SessionAccount,
): State {
  if (state.currentBundleState.did === account.did) return state
  const stored = state.accounts.find(a => a.did === account.did)
  if (!stored || JSON.stringify(stored) === JSON.stringify(account)) {
    return state
  }
  return {
    ...state,
    accounts: state.accounts.map(a => (a.did === account.did ? account : a)),
    needsPersist: true,
  }
}

type Sink = (account: SessionAccount) => void

let sink: Sink | undefined

/**
 * Called by the session provider: where rotated tokens go. Returns the
 * unregister function.
 */
export function registerStoredAccountSink(next: Sink): () => void {
  sink = next
  return () => {
    if (sink === next) sink = undefined
  }
}

/**
 * Store a temporary client's rotated tokens. `false` when no session
 * provider is mounted to take them.
 */
export function storeRotatedAccount(account: SessionAccount): boolean {
  if (!sink) return false
  sink(account)
  return true
}
