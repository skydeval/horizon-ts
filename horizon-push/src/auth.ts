/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {verifySignature} from '@atproto/crypto'

import {SERVICE_DID, SERVICE_ID} from './config'

/**
 * Checks the service token a PDS attaches when it forwards a request here
 * (`atproto-proxy`): a JWT signed with the account's atproto key, naming
 * this service as its audience and the method as `lxm`. A valid token proves
 * which account is asking; nothing else is trusted.
 */

export class AuthError extends Error {}

/** Fetches a DID document; injected so tests need no network. */
export type FetchDidDoc = (did: string) => Promise<unknown>

const ALGS = new Set(['ES256K', 'ES256'])

/** Tokens claiming a longer life than this are refused. */
const MAX_LIFETIME_S = 5 * 60
const CLOCK_SKEW_S = 30

const AUDIENCES = new Set([SERVICE_DID, `${SERVICE_DID}${SERVICE_ID}`])

function b64urlBytes(part: string): Uint8Array {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64urlJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(part)))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthError('malformed token')
  }
  return value as Record<string, unknown>
}

/** The account's atproto signing key from its DID document, as a did:key. */
export function signingKeyOf(doc: unknown, did: string): string | undefined {
  const d = doc as {id?: unknown; verificationMethod?: unknown}
  if (!d || d.id !== did || !Array.isArray(d.verificationMethod)) return undefined
  for (const vm of d.verificationMethod) {
    const m = vm as {id?: unknown; type?: unknown; publicKeyMultibase?: unknown}
    const isAtproto = m.id === '#atproto' || m.id === `${did}#atproto`
    if (
      isAtproto &&
      m.type === 'Multikey' &&
      typeof m.publicKeyMultibase === 'string'
    ) {
      return `did:key:${m.publicKeyMultibase}`
    }
  }
  return undefined
}

/** Real DID document lookup: PLC directory, or the did:web host. */
export const fetchDidDoc: FetchDidDoc = async did => {
  let url: string
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}`
  } else if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length))
    if (host.includes(':') || host.includes('/')) throw new AuthError('unsupported did:web')
    url = `https://${host}/.well-known/did.json`
  } else {
    throw new AuthError('unsupported DID method')
  }
  const res = await fetch(url, {headers: {accept: 'application/json'}})
  if (!res.ok) throw new AuthError('could not resolve the account')
  return res.json()
}

/**
 * Verifies a request's bearer token for method `lxm` and returns the
 * account DID it proves.
 */
export async function verifyServiceAuth(
  authorization: string | null,
  lxm: string,
  {fetchDoc = fetchDidDoc, now = Date.now()}: {fetchDoc?: FetchDidDoc; now?: number} = {},
): Promise<string> {
  if (!authorization?.startsWith('Bearer ')) throw new AuthError('missing token')
  const jwt = authorization.slice('Bearer '.length).trim()
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new AuthError('malformed token')
  const [h, p, s] = parts as [string, string, string]

  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = b64urlJson(h)
    payload = b64urlJson(p)
  } catch {
    throw new AuthError('malformed token')
  }

  const alg = header.alg
  if (typeof alg !== 'string' || !ALGS.has(alg)) throw new AuthError('unsupported algorithm')
  // Refresh and access tokens are not service tokens
  if (header.typ === 'at+jwt' || header.typ === 'refresh+jwt' || header.typ === 'dpop+jwt') {
    throw new AuthError('not a service token')
  }

  const iss = payload.iss
  if (typeof iss !== 'string' || !iss.startsWith('did:') || iss.includes('#')) {
    throw new AuthError('bad issuer')
  }
  if (typeof payload.aud !== 'string' || !AUDIENCES.has(payload.aud)) {
    throw new AuthError('wrong audience')
  }
  if (payload.lxm !== lxm) throw new AuthError('wrong method')
  const exp = payload.exp
  const nowS = Math.floor(now / 1000)
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_S < nowS) throw new AuthError('token expired')
  if (exp > nowS + MAX_LIFETIME_S + CLOCK_SKEW_S) throw new AuthError('token lives too long')

  let sig: Uint8Array
  try {
    sig = b64urlBytes(s)
  } catch {
    throw new AuthError('malformed token')
  }
  const key = signingKeyOf(await fetchDoc(iss), iss)
  if (!key) throw new AuthError('the account has no signing key')
  const data = new TextEncoder().encode(`${h}.${p}`)
  let ok = false
  try {
    ok = await verifySignature(key, data, sig, {jwtAlg: alg})
  } catch {
    ok = false
  }
  if (!ok) throw new AuthError('bad signature')
  return iss
}
