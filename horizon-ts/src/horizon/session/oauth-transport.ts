/*
 * Native stub of `oauth-transport.web.ts`. No OAuth session exists on this
 * platform yet, so every function rejects.
 */

import {type Agent} from '@atproto/lex'
import {type OAuthSession} from '@atproto/oauth-client-browser'

/**
 * Same value as on web; unused here.
 */
export const PROBE_WINDOW_MS = 60_000

/**
 * The transport's lifecycle, owned by the bundle.
 */
export type OAuthTransportLifecycle = {killed: boolean}

/**
 * Rejects: OAuth is not available on this platform.
 */
export function restoreOAuthSession(
  _did: string,
  _refresh: boolean | 'auto',
): Promise<OAuthSession> {
  return Promise.reject(
    new Error('OAuth sign-in is not available on this platform'),
  )
}

/**
 * Nothing to reset on this platform.
 */
export function resetOAuthTransportProbes() {}

/**
 * A transport whose every request rejects.
 */
export function createOAuthTransport(
  did: string,
  _lifecycle: OAuthTransportLifecycle = {killed: false},
): Agent {
  return {
    get did() {
      return did as Agent['did']
    },
    fetchHandler() {
      return Promise.reject(
        new Error('OAuth sign-in is not available on this platform'),
      )
    },
  }
}
