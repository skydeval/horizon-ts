/*
 * The Android OAuth client: one `ExpoOAuthClient` over the app's own client
 * document (`ANDROID_CLIENT_METADATA`), a signed (confidential) client whose
 * assertions nearhorizon.app's signer makes (`oauth-signing.ts`), so a
 * session lasts up to two years. Sign-in opens the authorization server in a
 * Custom Tab; the server returns to nearhorizon.app's return page, which
 * forwards to the app's `app.nearhorizon` scheme (patched library:
 * `appReturnUri`). Sessions and DPoP keys are kept in the library's MMKV
 * stores. The app is one process, so there is no cross-tab lock or
 * broadcast to follow, and the library's own in-process lock serialises
 * reads and refreshes.
 */

import {
  ExpoOAuthClient,
  type Key,
  TokenInvalidError,
  TokenRefreshError,
  TokenRevokedError,
} from '@atproto/oauth-client-expo'

import {PUBLIC_BSKY_SERVICE} from '#/lib/constants'
import {bufferedFetch} from '#/horizon/session/oauth-fetch'
import {
  ANDROID_CLIENT_METADATA,
  HORIZON_ORIGIN,
  NATIVE_REDIRECT_URI,
  type OAuthClientMode,
} from '#/horizon/session/oauth-metadata'
import {remoteKeyset} from '#/horizon/session/oauth-signing'

/**
 * OAuth sign-in is available on this platform.
 */
export const OAUTH_AVAILABLE: boolean = true

/**
 * The service that resolves typed handles for the library, as on web.
 */
export const OAUTH_HANDLE_RESOLVER: string =
  process.env.EXPO_PUBLIC_OAUTH_HANDLE_RESOLVER || PUBLIC_BSKY_SERVICE

/**
 * The app always signs in with its own document; the web modes don't apply.
 */
export function getOAuthClientMode(): OAuthClientMode {
  return 'production'
}

type DeletedListener = (did: string, cause: unknown) => void
const deletedListeners = new Set<DeletedListener>()

/**
 * Listen for the library deleting a stored session. Returns the unsubscribe
 * function.
 */
export function addOAuthSessionDeletedListener(listener: DeletedListener) {
  deletedListeners.add(listener)
  return () => {
    deletedListeners.delete(listener)
  }
}

/**
 * Whether a deletion cause is a revocation this client asked for.
 */
export function isOAuthRevocationCause(cause: unknown): boolean {
  return cause instanceof TokenRevokedError
}

/**
 * Whether a deletion cause is a refresh failure the library raised: the
 * session's death. There is only one window, so every deletion is this one's.
 */
export function isOAuthRefreshFailure(cause: unknown): boolean {
  return (
    cause instanceof TokenRefreshError || cause instanceof TokenInvalidError
  )
}

let client: ExpoOAuthClient | undefined

/**
 * The app's OAuth client, built once.
 */
export function getOAuthClient(): ExpoOAuthClient {
  if (!client) {
    client = new ExpoOAuthClient({
      clientMetadata: ANDROID_CLIENT_METADATA,
      keyset: remoteKeyset(HORIZON_ORIGIN) as unknown as Iterable<Key>,
      appReturnUri: NATIVE_REDIRECT_URI,
      handleResolver: OAUTH_HANDLE_RESOLVER,
      // Plain responses, so the DPoP nonce retry runs (see oauth-fetch.ts)
      fetch: bufferedFetch,
      onSessionDeleted(sub, cause) {
        deletedListeners.forEach(listener => listener(sub, cause))
      },
    })
  }
  return client
}
