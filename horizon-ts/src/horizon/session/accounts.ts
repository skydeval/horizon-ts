/*
 * Kind-aware account predicates.
 *
 * Adapted from the Witchsky client (MIT), src/state/session/util.ts
 * (`canAttemptSessionResume`): one predicate that knows both session kinds.
 */

import {type SessionAccount} from '#/state/session/types'

/**
 * Whether the account was signed in with OAuth. Its tokens live in the OAuth
 * library's store, not in the persisted account.
 */
export function isOauthAccount(account: SessionAccount | undefined): boolean {
  return account?.isOauthSession === true
}

/**
 * Whether an OAuth account was signed out (or its session ended). Such an
 * account looks like a signed-in one in every other field.
 */
export function isOAuthSignedOut(account: SessionAccount | undefined): boolean {
  return account?.oauthSignedOut === true
}

/**
 * Whether the account has a session to resume. For an OAuth account that is
 * "not marked signed out"; for any other account the stock rule passed in by
 * the caller decides, so each stock check keeps its own expression.
 */
export function isSignedInAccount(
  account: SessionAccount,
  passwordRule: boolean,
): boolean {
  if (isOauthAccount(account)) {
    return !isOAuthSignedOut(account)
  }
  return passwordRule
}

/**
 * The account without the signed-out marker, keeping field order.
 */
export function withoutSignedOutMark(account: SessionAccount): SessionAccount {
  if (account.oauthSignedOut === undefined) return account
  const copy = {...account}
  delete copy.oauthSignedOut
  return copy
}
