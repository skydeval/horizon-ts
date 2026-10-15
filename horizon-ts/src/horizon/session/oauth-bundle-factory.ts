/*
 * Native stub of `oauth-bundle-factory.web.ts`. No OAuth session exists on
 * this platform yet, so building one rejects.
 */

import {type OAuthSession} from '@atproto/oauth-client-browser'

import {type PublicSessionBundle} from '#/state/session/session-core'
import {type SessionAccount} from '#/state/session/types'
import {OAuthSessionEndedError} from '#/horizon/session/auth-errors'

/**
 * An OAuth bundle has the public-bundle shape; the side store marks it.
 */
export type OAuthSessionBundle = PublicSessionBundle

/**
 * Throws: OAuth is not available on this platform.
 */
export function createOAuthBundle(
  _account: {did: string; service: string},
  _options: {needsAccountRefresh?: boolean} = {},
): OAuthSessionBundle {
  throw new Error('OAuth sign-in is not available on this platform')
}

/**
 * Rejects: OAuth is not available on this platform.
 */
export function createOAuthSessionBundleAndLogin(
  _session: OAuthSession,
): Promise<{account: SessionAccount; bundle: OAuthSessionBundle}> {
  return Promise.reject(
    new Error('OAuth sign-in is not available on this platform'),
  )
}

/**
 * Rejects with an auth error, so an OAuth account stored by a web session is
 * treated as signed out on this platform.
 */
export function createOAuthSessionBundleAndResume(
  _storedAccount: SessionAccount,
  _isSwitchingAccounts: boolean,
): Promise<{account: SessionAccount; bundle: OAuthSessionBundle}> {
  return Promise.reject(new OAuthSessionEndedError())
}
