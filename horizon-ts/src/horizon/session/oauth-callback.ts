/*
 * Native stub of `oauth-callback.web.ts`: there is no web callback on this
 * platform.
 */

import {type OAuthSession} from '@atproto/oauth-client-browser'

/**
 * No callback URL on this platform.
 */
export function readOAuthCallbackParams(): URLSearchParams | undefined {
  return undefined
}

/**
 * Never a callback load on this platform.
 */
export function isOAuthCallbackLoad(): boolean {
  return false
}

/**
 * Nothing to complete on this platform.
 */
export function completeWebOAuth(
  _login: (session: OAuthSession, state: string | null) => Promise<void>,
): Promise<boolean> {
  return Promise.resolve(false)
}
