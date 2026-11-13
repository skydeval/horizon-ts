/*
 * The client assertion signer: a Cloudflare Pages function
 * (`functions/oauth/client-assertion.ts`) that signs the short JWT with
 * which Horizon authenticates to an OAuth token endpoint as a confidential
 * client (`private_key_jwt`). A confidential client's session can last up to
 * two years; a public client's at most two weeks.
 *
 * The browser and the app can't hold the private key, so they ask this
 * function for each assertion (Bluesky's "client assertion backend"
 * proposal, 0010). Tokens never pass through it: it only ever sees the
 * client ID and the authorization server it is signing for.
 *
 * What it signs is fixed here, not by the caller: `iss` and `sub` are one of
 * Horizon's own client IDs on this origin, `aud` is the caller's https
 * issuer, with a fresh `jti` and a one-minute life. An assertion on its own
 * gets nobody a token: the authorization code still goes to Horizon's own
 * redirect, and a refresh still needs the session's DPoP-bound refresh token
 * and key.
 *
 * Self-contained (no `#/` imports), because the Pages build bundles it on
 * its own. The private key is the Pages secret `HORIZON_OAUTH_CLIENT_KEY`, a
 * private P-256 JWK with its `kid`; its public half is in
 * `public/oauth/jwks.json`.
 */

/** The client documents on this origin that sign with the key. */
export const SIGNED_CLIENT_PATHS = [
  '/oauth-client-metadata.json',
  '/oauth-client-metadata-android.json',
] as const

/** An assertion's life, in seconds. The library asks for one per request. */
export const ASSERTION_LIFETIME_S = 60

export type SignerEnv = {
  HORIZON_OAUTH_CLIENT_KEY?: string
}

type PrivateJwk = JsonWebKey & {kid?: string}

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)))
}

/** The key, or `undefined` when the secret is missing or not a P-256 key. */
function readKey(env: SignerEnv): PrivateJwk | undefined {
  const raw = env.HORIZON_OAUTH_CLIENT_KEY
  if (!raw) return undefined
  try {
    const jwk = JSON.parse(raw) as PrivateJwk
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.kid) {
      return undefined
    }
    return jwk
  } catch {
    return undefined
  }
}

/** Whether `value` is an https issuer the signer will name as `aud`. */
export function isIssuer(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

/** Sign `payload` as an ES256 JWT with `jwk`. */
export async function signJwt(
  jwk: PrivateJwk,
  payload: Record<string, unknown>,
): Promise<string> {
  const {kid, ...keyData} = jwk
  const key = await crypto.subtle.importKey(
    'jwk',
    {...keyData, key_ops: ['sign'], ext: false},
    {name: 'ECDSA', namedCurve: 'P-256'},
    false,
    ['sign'],
  )
  const signingInput = `${encodeJson({alg: 'ES256', typ: 'JWT', kid})}.${encodeJson(payload)}`
  // WebCrypto's ECDSA signature is already the JWS form (r and s, 64 bytes)
  const signature = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64url(new Uint8Array(signature))}`
}

/**
 * Answer one request: `POST` with `{client_id, aud}`; `200` with
 * `{client_assertion}`. A browser request from another origin is refused;
 * the app sends no `Origin`.
 */
export async function handleClientAssertion(
  request: Request,
  env: SignerEnv,
  now: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin && origin !== url.origin) {
    return json(403, {error: 'forbidden_origin'})
  }
  const cors: HeadersInit = origin
    ? {'access-control-allow-origin': origin, vary: 'Origin'}
    : {}
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      },
    })
  }
  if (request.method !== 'POST') {
    return json(405, {error: 'method_not_allowed'}, {allow: 'POST'})
  }

  let body: {client_id?: unknown; aud?: unknown}
  try {
    body = await request.json()
  } catch {
    return json(400, {error: 'invalid_request'}, cors)
  }
  const clientId = body?.client_id
  const allowed = SIGNED_CLIENT_PATHS.map(path => `${url.origin}${path}`)
  if (typeof clientId !== 'string' || !allowed.includes(clientId)) {
    return json(400, {error: 'unknown_client'}, cors)
  }
  if (!isIssuer(body.aud)) {
    return json(400, {error: 'invalid_audience'}, cors)
  }

  const jwk = readKey(env)
  if (!jwk) return json(503, {error: 'signer_unavailable'}, cors)

  const iat = Math.floor(now / 1000)
  const client_assertion = await signJwt(jwk, {
    iss: clientId,
    sub: clientId,
    aud: body.aud,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + ASSERTION_LIFETIME_S,
  })
  return json(200, {client_assertion}, cors)
}
