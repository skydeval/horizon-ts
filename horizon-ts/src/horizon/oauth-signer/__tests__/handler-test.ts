import {beforeAll, describe, expect, it} from '@jest/globals'

import {handleAppCallback} from '../app-callback'
import {handleClientAssertion, isIssuer, type SignerEnv} from '../handler'

/*
 * The client assertion signer and the Android return page, with a key made
 * here. Synthetic issuers only.
 */

const ORIGIN = 'https://nearhorizon.app'
const CLIENT = `${ORIGIN}/oauth-client-metadata.json`
const ANDROID = `${ORIGIN}/oauth-client-metadata-android.json`
const ISSUER = 'https://pds.example.invalid'
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)

let env: SignerEnv
let publicKey: CryptoKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {name: 'ECDSA', namedCurve: 'P-256'},
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  env = {
    HORIZON_OAUTH_CLIENT_KEY: JSON.stringify({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
      d: jwk.d,
      kid: 'test-key',
    }),
  }
  publicKey = pair.publicKey
})

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/oauth/client-assertion`, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...headers},
    body: JSON.stringify(body),
  })
}

function decode(part: string) {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(base64)) as Record<string, unknown>
}

function bytes(part: string) {
  const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

describe('the client assertion signer', () => {
  it('signs a one-minute assertion for one of Horizon’s clients', async () => {
    for (const clientId of [CLIENT, ANDROID]) {
      const response = await handleClientAssertion(
        post({client_id: clientId, aud: ISSUER}),
        env,
        NOW,
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const {client_assertion} = (await response.json()) as {
        client_assertion: string
      }
      const [header, payload, signature] = client_assertion.split('.')
      expect(decode(header)).toEqual({
        alg: 'ES256',
        typ: 'JWT',
        kid: 'test-key',
      })
      const claims = decode(payload)
      expect(claims).toMatchObject({
        iss: clientId,
        sub: clientId,
        aud: ISSUER,
        iat: NOW / 1000,
        exp: NOW / 1000 + 60,
      })
      expect(typeof claims.jti).toBe('string')
      const valid = await crypto.subtle.verify(
        {name: 'ECDSA', hash: 'SHA-256'},
        publicKey,
        bytes(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      )
      expect(valid).toBe(true)
    }
  })

  it('never signs the private key or anything else into the answer', async () => {
    const response = await handleClientAssertion(
      post({client_id: CLIENT, aud: ISSUER}),
      env,
      NOW,
    )
    const text = await response.text()
    const {d} = JSON.parse(env.HORIZON_OAUTH_CLIENT_KEY!) as {d: string}
    expect(text).not.toContain(d)
  })

  it('refuses other clients, bad audiences and other origins', async () => {
    const cases: [Request, number][] = [
      [post({client_id: 'https://evil.example/c.json', aud: ISSUER}), 400],
      [
        post({
          client_id: `${ORIGIN}/oauth-client-metadata-dev.json`,
          aud: ISSUER,
        }),
        400,
      ],
      [post({client_id: CLIENT, aud: 'http://pds.example.invalid'}), 400],
      [post({client_id: CLIENT, aud: `${ISSUER}/?x=1`}), 400],
      [post({client_id: CLIENT}), 400],
      [
        post(
          {client_id: CLIENT, aud: ISSUER},
          {origin: 'https://evil.example'},
        ),
        403,
      ],
      [new Request(`${ORIGIN}/oauth/client-assertion`), 405],
    ]
    for (const [request, status] of cases) {
      expect((await handleClientAssertion(request, env, NOW)).status).toBe(
        status,
      )
    }
  })

  it('answers its own origin’s browser requests with CORS', async () => {
    const response = await handleClientAssertion(
      post({client_id: CLIENT, aud: ISSUER}, {origin: ORIGIN}),
      env,
      NOW,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('is unavailable without a usable key', async () => {
    for (const broken of [{}, {HORIZON_OAUTH_CLIENT_KEY: 'nope'}]) {
      const response = await handleClientAssertion(
        post({client_id: CLIENT, aud: ISSUER}),
        broken,
        NOW,
      )
      expect(response.status).toBe(503)
    }
  })

  it('takes only https issuers', () => {
    expect(isIssuer('https://bsky.social')).toBe(true)
    expect(isIssuer('https://pds.example.invalid:8443')).toBe(true)
    expect(isIssuer('http://bsky.social')).toBe(false)
    expect(isIssuer('https://u:p@bsky.social')).toBe(false)
    expect(isIssuer('https://bsky.social#x')).toBe(false)
    expect(isIssuer(7)).toBe(false)
  })
})

describe('the Android return page', () => {
  it('forwards the answer to the app’s scheme, untouched', () => {
    const response = handleAppCallback(
      new Request(`${ORIGIN}/auth/app/callback?state=s&iss=${ISSUER}&code=c`),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `app.nearhorizon:/oauth/callback?state=s&iss=${ISSUER}&code=c`,
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
