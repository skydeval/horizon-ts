/*
 * Horizon's OAuth client metadata, from one source.
 *
 * Adapted from the Witchsky client (MIT), src/state/session/oauth-config.ts.
 *
 * The production document is also committed as
 * `public/oauth-client-metadata.json`, and the hosted development document as
 * `public/oauth-client-metadata-dev.json`; a unit test keeps each equal to the
 * document built here.
 */

import {PRODUCT_NAME} from '#/horizon/branding'

/**
 * The fixed grant Horizon asks for. `transition:generic` covers repo writes,
 * proxied `app.bsky.*` (prism included) and the `tools.kryphocron.*`
 * procedures.
 */
export const OAUTH_SCOPE =
  'atproto transition:generic transition:email transition:chat.bsky'

/**
 * Where the production client document and callback live.
 */
export const HORIZON_ORIGIN = 'https://nearhorizon.app'

/**
 * The callback route, the same for every client mode.
 */
export const OAUTH_CALLBACK_PATH = '/auth/web/callback'

/**
 * The hosted development document's client ID. Provisional (skydeval Q3,
 * option a): committed in `public/` and served from nearhorizon.app. To host
 * it elsewhere, change this one constant and move the file.
 */
export const HOSTED_DEV_CLIENT_ID = `${HORIZON_ORIGIN}/oauth-client-metadata-dev.json`

/**
 * Expo's web dev server, the hosted development document's fixed redirect.
 */
export const HOSTED_DEV_REDIRECT_URI = `http://127.0.0.1:8081${OAUTH_CALLBACK_PATH}`

/**
 * Which client document a build signs in with:
 * - `production`: the document at nearhorizon.app.
 * - `loopback`: the atproto loopback client, for local development against
 *   servers that accept it (Bluesky's PDS).
 * - `hosted-dev`: the hosted development document, for local development
 *   against aurora-locus until it accepts loopback clients.
 */
export type OAuthClientMode = 'production' | 'loopback' | 'hosted-dev'

/**
 * The client metadata document Horizon publishes.
 */
export type OAuthClientMetadataDocument = {
  client_id: string
  client_name: string
  client_uri: string
  redirect_uris: [string]
  scope: string
  token_endpoint_auth_method: 'none'
  response_types: ['code']
  grant_types: ['authorization_code', 'refresh_token']
  application_type: 'web'
  dpop_bound_access_tokens: true
}

/**
 * Build a public, DPoP-bound web client document. The key order matches the
 * committed JSON files.
 */
export function createOAuthClientMetadata({
  clientId,
  clientUri,
  redirectUri,
  clientName,
}: {
  clientId: string
  clientUri: string
  redirectUri: string
  clientName: string
}): OAuthClientMetadataDocument {
  return {
    client_id: clientId,
    client_name: clientName,
    client_uri: clientUri,
    redirect_uris: [redirectUri],
    scope: OAUTH_SCOPE,
    token_endpoint_auth_method: 'none',
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    application_type: 'web',
    dpop_bound_access_tokens: true,
  }
}

/**
 * The production document, served at
 * `https://nearhorizon.app/oauth-client-metadata.json`.
 */
export const PRODUCTION_CLIENT_METADATA = createOAuthClientMetadata({
  clientId: `${HORIZON_ORIGIN}/oauth-client-metadata.json`,
  clientUri: HORIZON_ORIGIN,
  redirectUri: `${HORIZON_ORIGIN}${OAUTH_CALLBACK_PATH}`,
  clientName: PRODUCT_NAME,
})

/**
 * The hosted development document. Only aurora-locus accepts it: it matches
 * redirect URIs as exact strings and does not require an https redirect.
 */
export const HOSTED_DEV_CLIENT_METADATA = createOAuthClientMetadata({
  clientId: HOSTED_DEV_CLIENT_ID,
  clientUri: HORIZON_ORIGIN,
  redirectUri: HOSTED_DEV_REDIRECT_URI,
  clientName: `${PRODUCT_NAME} (development)`,
})

/**
 * The atproto loopback client ID for a dev server on `127.0.0.1:<port>`. The
 * server synthesises the client document from the ID itself, so the redirect
 * and scope travel in the query.
 */
export function loopbackClientId(port: string): string {
  const redirectUri = `http://127.0.0.1${port ? `:${port}` : ''}${OAUTH_CALLBACK_PATH}`
  return `http://localhost?redirect_uri=${encodeURIComponent(
    redirectUri,
  )}&scope=${encodeURIComponent(OAUTH_SCOPE)}`
}

/**
 * The OAuth library signals that a popup handed its result to the opener by
 * throwing an error with this code from the popup's callback.
 */
export function isOAuthPopupComplete(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'LOGIN_CONTINUED_IN_PARENT_WINDOW'
  )
}
