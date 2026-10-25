/*
 * The browser OAuth client: one `BrowserOAuthClient` per client ID.
 *
 * Adapted from the Witchsky client (MIT), src/state/session/oauth-web-client.ts.
 */

import {
  atprotoLoopbackClientMetadata,
  BrowserOAuthClient,
  TokenInvalidError,
  TokenRefreshError,
  TokenRevokedError,
} from '@atproto/oauth-client-browser'

import {PUBLIC_BSKY_SERVICE} from '#/lib/constants'
import {ENV} from '#/env'
import {PREVIEW_ORIGIN} from '#/horizon/preview'
import {
  createPreviewClientMetadata,
  HOSTED_DEV_CLIENT_METADATA,
  loopbackClientId,
  type OAuthClientMode,
  PRODUCTION_CLIENT_METADATA,
  selectOAuthClientMode,
} from '#/horizon/session/oauth-metadata'

/**
 * OAuth sign-in is available on this platform.
 */
export const OAUTH_AVAILABLE: boolean = true

/**
 * The service that resolves typed handles for the library. Provisional
 * (skydeval Q4): Bluesky's public AppView, the service stock signed-out reads
 * already use. `EXPO_PUBLIC_OAUTH_HANDLE_RESOLVER` overrides it for
 * development.
 */
export const OAUTH_HANDLE_RESOLVER: string =
  process.env.EXPO_PUBLIC_OAUTH_HANDLE_RESOLVER || PUBLIC_BSKY_SERVICE

/**
 * The client document this page signs in with (`selectOAuthClientMode`). A
 * preview build uses its preview document; any other production build the
 * production document. Otherwise `EXPO_PUBLIC_OAUTH_CLIENT` chooses, and a
 * page on a loopback host defaults to the loopback client.
 */
export function getOAuthClientMode(): OAuthClientMode {
  return selectOAuthClientMode({
    env: ENV,
    requested: process.env.EXPO_PUBLIC_OAUTH_CLIENT,
    previewOrigin: PREVIEW_ORIGIN,
    hostname:
      typeof window !== 'undefined' ? window.location.hostname : undefined,
  })
}

type DeletedListener = (did: string, cause: unknown) => void
const deletedListeners = new Set<DeletedListener>()

/**
 * Listen for the library deleting a stored session, in this tab or (through
 * the library's broadcast channel) in another one. A deletion from another
 * window arrives with its cause structured-cloned, so it is never an instance
 * of a library error class here (see {@link isOAuthRefreshFailure}). Returns
 * the unsubscribe function.
 */
export function addOAuthSessionDeletedListener(listener: DeletedListener) {
  deletedListeners.add(listener)
  return () => {
    deletedListeners.delete(listener)
  }
}

/**
 * Whether a deletion cause is a revocation this client asked for (sign-out,
 * a re-authorization replacing the old session, the password gate, or the
 * transport ending a dead session, which reports the loss itself).
 */
export function isOAuthRevocationCause(cause: unknown): boolean {
  return cause instanceof TokenRevokedError
}

/**
 * Whether a deletion cause is a refresh failure the library raised in this
 * window: a `TokenRefreshError` or `TokenInvalidError` of this realm (system
 * accounts design SA-25). Only such a deletion is read as the session's
 * death. A deletion broadcast from another window carries a structured clone
 * of its cause, which is only ever a built-in error type, so it never counts:
 * another window's sign-out or re-authorization is not a death here, and a
 * real death is found at this window's next request.
 */
export function isOAuthRefreshFailure(cause: unknown): boolean {
  return (
    cause instanceof TokenRefreshError || cause instanceof TokenInvalidError
  )
}

const clients = new Map<string, BrowserOAuthClient>()

function buildMetadata() {
  switch (getOAuthClientMode()) {
    case 'hosted-dev':
      return HOSTED_DEV_CLIENT_METADATA
    case 'preview':
      // The mode is preview only when PREVIEW_ORIGIN is set.
      return createPreviewClientMetadata(PREVIEW_ORIGIN ?? '')
    case 'loopback':
      return atprotoLoopbackClientMetadata(
        loopbackClientId(window.location.port),
      )
    default:
      return PRODUCTION_CLIENT_METADATA
  }
}

/**
 * The OAuth client for this page's client document, built once per client ID.
 */
export function getOAuthClient(): BrowserOAuthClient {
  const clientMetadata = buildMetadata()
  let client = clients.get(clientMetadata.client_id)
  if (!client) {
    client = new BrowserOAuthClient({
      clientMetadata,
      handleResolver: OAUTH_HANDLE_RESOLVER,
      onSessionDeleted(sub, cause) {
        deletedListeners.forEach(listener => listener(sub, cause))
      },
    })
    clients.set(clientMetadata.client_id, client)
  }
  return client
}
