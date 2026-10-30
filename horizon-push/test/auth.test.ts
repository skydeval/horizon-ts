import {type Keypair, P256Keypair, Secp256k1Keypair} from '@atproto/crypto'
import {describe, expect, it} from 'vitest'

import {AuthError, signingKeyOf, verifyServiceAuth} from '../src/auth'
import {SERVICE_DID} from '../src/config'

const USER = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const LXM = 'app.bsky.notification.registerPush'
const NOW = 1_800_000_000_000

function b64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function token(kp: Keypair, claims: Record<string, unknown> = {}, header = {}) {
  const h = b64url(JSON.stringify({typ: 'JWT', alg: kp.jwtAlg, ...header}))
  const p = b64url(
    JSON.stringify({
      iss: USER,
      aud: SERVICE_DID,
      lxm: LXM,
      exp: Math.floor(NOW / 1000) + 60,
      ...claims,
    }),
  )
  const sig = await kp.sign(new TextEncoder().encode(`${h}.${p}`))
  return `Bearer ${h}.${p}.${b64url(sig)}`
}

function docFor(kp: Keypair, did = USER) {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: kp.did().slice('did:key:'.length),
      },
    ],
  }
}

function check(auth: string, kp: Keypair, lxm = LXM) {
  return verifyServiceAuth(auth, lxm, {fetchDoc: async () => docFor(kp), now: NOW})
}

describe('verifyServiceAuth', () => {
  it('accepts a token signed by the account (secp256k1 and P-256)', async () => {
    const k = await Secp256k1Keypair.create()
    const p = await P256Keypair.create()
    expect(await check(await token(k), k)).toBe(USER)
    expect(await check(await token(p), p)).toBe(USER)
  })

  it('accepts the audience with the service fragment', async () => {
    const k = await Secp256k1Keypair.create()
    expect(await check(await token(k, {aud: `${SERVICE_DID}#horizon_push`}), k)).toBe(USER)
  })

  it('refuses a token signed by another key', async () => {
    const k = await Secp256k1Keypair.create()
    const other = await Secp256k1Keypair.create()
    await expect(check(await token(other), k)).rejects.toThrow('bad signature')
  })

  it('refuses the wrong audience, method, or lifetime', async () => {
    const k = await Secp256k1Keypair.create()
    const nowS = Math.floor(NOW / 1000)
    await expect(check(await token(k, {aud: 'did:web:api.bsky.app'}), k)).rejects.toThrow(
      'wrong audience',
    )
    await expect(check(await token(k), k, 'app.bsky.notification.unregisterPush')).rejects.toThrow(
      'wrong method',
    )
    await expect(check(await token(k, {lxm: undefined}), k)).rejects.toThrow('wrong method')
    await expect(check(await token(k, {exp: nowS - 120}), k)).rejects.toThrow('expired')
    await expect(check(await token(k, {exp: nowS + 3600}), k)).rejects.toThrow('too long')
  })

  it('refuses access tokens and malformed input', async () => {
    const k = await Secp256k1Keypair.create()
    await expect(check(await token(k, {}, {typ: 'at+jwt'}), k)).rejects.toThrow(
      'not a service token',
    )
    await expect(check('Bearer a.b', k)).rejects.toBeInstanceOf(AuthError)
    await expect(check('Basic abc', k)).rejects.toThrow('missing token')
    await expect(verifyServiceAuth(null, LXM)).rejects.toThrow('missing token')
  })
})

describe('signingKeyOf', () => {
  it('finds the #atproto Multikey, short or full id', async () => {
    const k = await Secp256k1Keypair.create()
    const doc = docFor(k)
    expect(signingKeyOf(doc, USER)).toBe(k.did())
    const short = {...doc, verificationMethod: [{...doc.verificationMethod[0], id: '#atproto'}]}
    expect(signingKeyOf(short, USER)).toBe(k.did())
  })

  it('refuses a document for another DID', async () => {
    const k = await Secp256k1Keypair.create()
    expect(signingKeyOf(docFor(k, 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'), USER)).toBeUndefined()
  })
})
