/*
 * The browser OAuth client: one `BrowserOAuthClient` per client ID.
 *
 * Adapted from the Witchsky client (MIT), src/state/session/oauth-web-client.ts.
 */

import {
  atprotoLoopbackClientMetadata,
  BrowserOAuthClient,
  TokenRevokedError,
} from '@atproto/oauth-client-browser'

import {PUBLIC_BSKY_SERVICE} from '#/lib/constants'
import {ENV} from '#/env'
import {
  HOSTED_DEV_CLIENT_METADATA,
  loopbackClientId,
  type OAuthClientMode,
  PRODUCTION_CLIENT_METADATA,
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

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1']

/**
 * The client document this page signs in with. Production builds always use
 * the production document. Otherwise `EXPO_PUBLIC_OAUTH_CLIENT` chooses, and a
 * page on a loopback host defaults to the loopback client.
 */
export function getOAuthClientMode(): OAuthClientMode {
  if (ENV === 'production') return 'production'
  const requested = process.env.EXPO_PUBLIC_OAUTH_CLIENT
  if (
    requested === 'production' ||
    requested === 'loopback' ||
    requested === 'hosted-dev'
  ) {
    return requested
  }
  if (
    typeof window !== 'undefined' &&
    LOOPBACK_HOSTS.includes(window.location.hostname)
  ) {
    return 'loopback'
  }
  return 'production'
}

type DeletedListener = (did: string, cause: unknown) => void
const deletedListeners = new Set<DeletedListener>()

/**
 * Listen for the library deleting a stored session, in this tab or (through
 * the library's broadcast channel) in another one. Returns the unsubscribe
 * function.
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

const clients = new Map<string, BrowserOAuthClient>()

function buildMetadata() {
  switch (getOAuthClientMode()) {
    case 'hosted-dev':
      return HOSTED_DEV_CLIENT_METADATA
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
