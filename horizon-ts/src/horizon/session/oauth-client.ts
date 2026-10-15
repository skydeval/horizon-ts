/*
 * Native stub of `oauth-client.web.ts`. Native sign-in comes later, as
 * `.native.ts` siblings over the Expo OAuth client; until then the sign-in
 * form shows the Password tab alone and nothing reaches these functions.
 */

import {type BrowserOAuthClient} from '@atproto/oauth-client-browser'

import {type OAuthClientMode} from '#/horizon/session/oauth-metadata'

/**
 * OAuth sign-in is not available on this platform yet.
 */
export const OAUTH_AVAILABLE: boolean = false

/**
 * Unused on this platform.
 */
export const OAUTH_HANDLE_RESOLVER: string = ''

/**
 * Unused on this platform.
 */
export function getOAuthClientMode(): OAuthClientMode {
  return 'production'
}

/**
 * No OAuth sessions exist on this platform, so nothing is ever deleted.
 */
export function addOAuthSessionDeletedListener(
  _listener: (did: string, cause: unknown) => void,
) {
  return () => {}
}

/**
 * Unused on this platform.
 */
export function isOAuthRevocationCause(_cause: unknown): boolean {
  return false
}

/**
 * Throws: OAuth is not available on this platform.
 */
export function getOAuthClient(): BrowserOAuthClient {
  throw new Error('OAuth sign-in is not available on this platform')
}
