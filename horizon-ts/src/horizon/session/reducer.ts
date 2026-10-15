/*
 * Marks signed-out OAuth accounts in the stock session reducer's output.
 *
 * A signed-out OAuth account keeps `isOauthSession: true` and has no tokens,
 * exactly like a signed-in one, so the reducer wrapper sets `oauthSignedOut`
 * in the same persisted write that signs it out. Every tab then sees it
 * signed out. The mark is cleared by replacement: an OAuth login builds a
 * fresh account without it, and `switched-to-account` replaces the stored
 * object.
 */

import {type Action, type State} from '#/state/session/reducer'
import {type SessionAccount} from '#/state/session/types'
import {isOauthAccount} from '#/horizon/session/accounts'

type Reducer = (state: State, action: Action) => State

function markSignedOut(
  state: State,
  pick: (account: SessionAccount) => boolean,
): State {
  let changed = false
  const accounts = state.accounts.map(account => {
    if (!pick(account) || !isOauthAccount(account) || account.oauthSignedOut) {
      return account
    }
    changed = true
    return {...account, oauthSignedOut: true}
  })
  if (!changed) return state
  return {...state, accounts, needsPersist: true}
}

/**
 * Wrap the stock reducer so these actions also mark OAuth accounts signed
 * out:
 * - `logged-out-current-account`: the previous current account.
 * - `logged-out-every-account`: every OAuth account.
 * - `received-session-event` with `expired`, the live bundle and no refreshed
 *   account: that account.
 *
 * Password accounts are never marked, and no action type is added.
 */
export function withOAuthSignOutMarks(reducer: Reducer): Reducer {
  return (state, action) => {
    const next = reducer(state, action)
    switch (action.type) {
      case 'logged-out-current-account': {
        const did = state.currentBundleState.did
        if (!did) return next
        return markSignedOut(next, account => account.did === did)
      }
      case 'logged-out-every-account': {
        return markSignedOut(next, () => true)
      }
      case 'received-session-event': {
        if (
          action.sessionEvent !== 'expired' ||
          action.refreshedAccount ||
          action.bundle !== state.currentBundleState.bundle
        ) {
          return next
        }
        return markSignedOut(next, account => account.did === action.accountDid)
      }
      default: {
        return next
      }
    }
  }
}
