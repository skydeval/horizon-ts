/*
 * Horizon's OAuth client metadata, from one source.
 *
 * Adapted from the Witchsky client (MIT), src/state/session/oauth-config.ts.
 *
 * The production document is also committed as
 * `public/oauth-client-metadata.json`, and the hosted development document as
 * `public/oauth-client-metadata-dev.json`, and the app's document as
 * `public/oauth-client-metadata-native.json`; a unit test keeps each equal to
 * the document built here. A preview build's document is written into the build
 * output by `scripts/horizon-preview-pages.js`; a unit test keeps that script
 * equal to `createPreviewClientMetadata`.
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
 * - `preview`: a preview build served from its own https origin
 *   (`EXPO_PUBLIC_PREVIEW_ORIGIN`), with its own document at that origin.
 */
export type OAuthClientMode =
  'production' | 'loopback' | 'hosted-dev' | 'preview'

/**
 * Where a client document lives, relative to its origin. The production and
 * preview documents share it.
 */
export const CLIENT_METADATA_PATH = '/oauth-client-metadata.json'

/**
 * Where a signed client's public keys are served, relative to its origin.
 */
export const OAUTH_JWKS_PATH = '/oauth/jwks.json'

/**
 * The client metadata document Horizon publishes. A signed document is a
 * confidential client (`private_key_jwt`): its sessions last up to two years
 * instead of two weeks, with the assertions signed by nearhorizon.app's
 * signer (`oauth-signing.ts`).
 */
export type OAuthClientMetadataDocument = {
  client_id: string
  client_name: string
  client_uri: string
  redirect_uris: [string]
  scope: string
  token_endpoint_auth_method: 'none' | 'private_key_jwt'
  token_endpoint_auth_signing_alg?: 'ES256'
  jwks_uri?: string
  response_types: ['code']
  grant_types: ['authorization_code', 'refresh_token']
  application_type: 'web' | 'native'
  dpop_bound_access_tokens: true
}

/**
 * Build a DPoP-bound client document, for the web unless `applicationType`
 * says `native`. `signed` makes it a confidential client whose keys are at
 * `jwksOrigin` (a web document only: the authorization server refuses a
 * signed native client). The key order matches the committed JSON files.
 */
export function createOAuthClientMetadata({
  clientId,
  clientUri,
  redirectUri,
  clientName,
  applicationType = 'web',
  signed,
}: {
  clientId: string
  clientUri: string
  redirectUri: string
  clientName: string
  applicationType?: 'web' | 'native'
  signed?: {jwksOrigin: string}
}): OAuthClientMetadataDocument {
  return {
    client_id: clientId,
    client_name: clientName,
    client_uri: clientUri,
    redirect_uris: [redirectUri],
    scope: OAUTH_SCOPE,
    ...(signed && applicationType === 'web'
      ? {
          token_endpoint_auth_method: 'private_key_jwt' as const,
          token_endpoint_auth_signing_alg: 'ES256' as const,
          jwks_uri: `${signed.jwksOrigin}${OAUTH_JWKS_PATH}`,
        }
      : {token_endpoint_auth_method: 'none' as const}),
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    application_type: applicationType,
    dpop_bound_access_tokens: true,
  }
}

/** Whether a document is a confidential (signed) client. */
export function isSignedClient(metadata: {
  token_endpoint_auth_method?: string
}) {
  return metadata.token_endpoint_auth_method === 'private_key_jwt'
}

/**
 * The production document, served at
 * `https://nearhorizon.app/oauth-client-metadata.json`. Signed.
 */
export const PRODUCTION_CLIENT_METADATA = createOAuthClientMetadata({
  clientId: `${HORIZON_ORIGIN}${CLIENT_METADATA_PATH}`,
  clientUri: HORIZON_ORIGIN,
  redirectUri: `${HORIZON_ORIGIN}${OAUTH_CALLBACK_PATH}`,
  clientName: PRODUCT_NAME,
  signed: {jwksOrigin: HORIZON_ORIGIN},
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
 * The app's client ID: its own document beside the web one on nearhorizon.app.
 */
export const NATIVE_CLIENT_ID = `${HORIZON_ORIGIN}/oauth-client-metadata-native.json`

/**
 * The app's redirect: a private-use scheme that is nearhorizon.app reversed
 * (the app's `scheme` in app.config.js), with a single slash, as atproto
 * OAuth requires of native clients.
 */
export const NATIVE_REDIRECT_URI = 'app.nearhorizon:/oauth/callback'

/**
 * The app's first document, served at
 * `https://nearhorizon.app/oauth-client-metadata-native.json`: a public
 * native client. Builds before the signed Android document still sign in
 * with it, so it stays published unchanged.
 */
export const NATIVE_CLIENT_METADATA = createOAuthClientMetadata({
  clientId: NATIVE_CLIENT_ID,
  clientUri: HORIZON_ORIGIN,
  redirectUri: NATIVE_REDIRECT_URI,
  clientName: PRODUCT_NAME,
  applicationType: 'native',
})

/**
 * The Android app's signed document's client ID, beside the others.
 */
export const ANDROID_CLIENT_ID = `${HORIZON_ORIGIN}/oauth-client-metadata-android.json`

/**
 * The Android app's return page (`oauth-signer/app-callback.ts`), which
 * forwards to {@link NATIVE_REDIRECT_URI}. A signed client must be a web
 * client, and a web client returns to an https address.
 */
export const ANDROID_REDIRECT_URI = `${HORIZON_ORIGIN}/auth/app/callback`

/**
 * The Android app's document, served at
 * `https://nearhorizon.app/oauth-client-metadata-android.json`: a signed
 * web client that returns through {@link ANDROID_REDIRECT_URI}.
 */
export const ANDROID_CLIENT_METADATA = createOAuthClientMetadata({
  clientId: ANDROID_CLIENT_ID,
  clientUri: HORIZON_ORIGIN,
  redirectUri: ANDROID_REDIRECT_URI,
  clientName: PRODUCT_NAME,
  signed: {jwksOrigin: HORIZON_ORIGIN},
})

/**
 * A preview build's document: the production document moved to `origin`
 * (an https origin with no trailing slash), under its own name so the
 * authorization page says which build is asking. On nearhorizon.app itself
 * (the live site is built this way) it keeps the plain name and is signed,
 * since that deployment holds the signing key; a preview on another origin
 * is a public client.
 */
export function createPreviewClientMetadata(
  origin: string,
): OAuthClientMetadataDocument {
  const live = origin === HORIZON_ORIGIN
  return createOAuthClientMetadata({
    clientId: `${origin}${CLIENT_METADATA_PATH}`,
    clientUri: origin,
    redirectUri: `${origin}${OAUTH_CALLBACK_PATH}`,
    clientName: live ? PRODUCT_NAME : `${PRODUCT_NAME} (preview)`,
    signed: live ? {jwksOrigin: origin} : undefined,
  })
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1']

/**
 * The modes `EXPO_PUBLIC_OAUTH_CLIENT` can pick outside a production build.
 * `preview` is not one: it needs a preview origin.
 */
const REQUESTABLE_MODES: OAuthClientMode[] = [
  'production',
  'loopback',
  'hosted-dev',
]

/**
 * Which client document a page signs in with:
 * - a preview build (`requested` is `preview` and the build has a preview
 *   origin) uses the preview document, production build or not;
 * - any other production build uses the production document;
 * - otherwise `requested` chooses, and a page on a loopback host defaults to
 *   the loopback client.
 */
export function selectOAuthClientMode({
  env,
  requested,
  previewOrigin,
  hostname,
}: {
  env: string | undefined
  requested: string | undefined
  previewOrigin: string | undefined
  hostname: string | undefined
}): OAuthClientMode {
  if (requested === 'preview' && previewOrigin) return 'preview'
  if (env === 'production') return 'production'
  const mode = REQUESTABLE_MODES.find(m => m === requested)
  if (mode) return mode
  if (hostname && LOOPBACK_HOSTS.includes(hostname)) return 'loopback'
  return 'production'
}

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
