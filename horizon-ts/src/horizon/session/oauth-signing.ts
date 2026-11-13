/*
 * Horizon's confidential OAuth client: the key the OAuth library signs its
 * client assertions with, held by nearhorizon.app's signer
 * (`oauth-signer/handler.ts`), not on the device.
 *
 * The library asks its keyset for a signing key and calls `createJwt` on it
 * for each PAR, token and revocation request. This key answers by asking
 * the signer, which fixes `iss`, `sub`, `jti`, `iat` and `exp` itself; only
 * the client ID and the authorization server (`aud`) are sent. `Keyset`
 * accepts any key of this shape, so nothing here imports the library.
 *
 * A failure to reach the signer is a {@link SignerUnavailableError}, never a
 * `TypeError` (which the library would read as a broken stored session and
 * delete) and never worded like an ended session (`auth-errors.ts`): the
 * session is kept, and the next request tries again.
 */

import {OAUTH_SIGNING_KEY} from '#/horizon/session/oauth-signing-key.generated'

/** The signer's path on the client's origin. */
export const CLIENT_ASSERTION_PATH = '/oauth/client-assertion'

/** How long one request to the signer may take. */
const SIGNER_TIMEOUT_MS = 10_000

/** Waits before the one retry of a failed request. */
const RETRY_DELAY_MS = 700

/** The signer could not be reached or refused; the session is unaffected. */
export class SignerUnavailableError extends Error {
  constructor(detail: string) {
    super(`Horizon's signer is unavailable: ${detail}`)
    this.name = 'SignerUnavailableError'
  }
}

type PublicJwk = {
  kty: string
  crv: string
  x: string
  y: string
  kid: string
  alg: string
  use: string
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

type KeyMatch = {
  kid?: string | string[]
  alg?: string | string[]
  usage?: string
}

function includesOrEquals(value: string, want: string | string[]) {
  return Array.isArray(want) ? want.includes(value) : value === want
}

/**
 * A signing key whose private half lives with the signer at `endpoint`.
 * Shaped like the library's `Key` for the parts `Keyset` and the client use.
 */
export class RemoteSigningKey {
  readonly jwk: PublicJwk
  readonly endpoint: string
  private readonly fetchImpl: Fetch

  constructor(jwk: PublicJwk, endpoint: string, fetchImpl?: Fetch) {
    this.jwk = jwk
    this.endpoint = endpoint
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init))
  }

  get kid() {
    return this.jwk.kid
  }
  get alg() {
    return this.jwk.alg
  }
  get use() {
    return this.jwk.use
  }
  get keyOps() {
    return ['sign']
  }
  get algorithms(): readonly string[] {
    return [this.jwk.alg]
  }
  /** It signs, so the library treats it as a private key. */
  get isPrivate() {
    return true
  }
  get isSymetric() {
    return false
  }
  get isRevoked() {
    return false
  }
  get publicJwk() {
    return this.jwk
  }
  get privateJwk() {
    return undefined
  }

  isActive() {
    return true
  }

  matches({kid, alg, usage}: KeyMatch) {
    if (kid != null && !includesOrEquals(this.kid, kid)) return false
    if (alg != null && !includesOrEquals(this.alg, alg)) return false
    if (usage != null && usage !== 'sign' && usage !== 'verify') return false
    return true
  }

  /**
   * Ask the signer for the assertion. The library's own claims are not
   * sent: the signer sets them, so only `iss` (the client ID) and `aud`
   * are read here.
   */
  async createJwt(
    _header: unknown,
    payload: {iss?: unknown; aud?: unknown; [claim: string]: unknown},
  ): Promise<string> {
    const body = JSON.stringify({client_id: payload.iss, aud: payload.aud})
    try {
      return await this.request(body)
    } catch {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      return this.request(body)
    }
  }

  verifyJwt(): Promise<never> {
    return Promise.reject(new Error('A remote signing key does not verify'))
  }

  private async request(body: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SIGNER_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body,
        signal: controller.signal,
      })
    } catch (error) {
      throw new SignerUnavailableError(
        error instanceof Error ? error.name : 'network',
      )
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new SignerUnavailableError(`status ${response.status}`)
    }
    let assertion: unknown
    try {
      assertion = ((await response.json()) as {client_assertion?: unknown})
        .client_assertion
    } catch {
      throw new SignerUnavailableError('unreadable answer')
    }
    if (typeof assertion !== 'string' || assertion.split('.').length !== 3) {
      throw new SignerUnavailableError('no assertion')
    }
    return assertion
  }
}

/** The keyset for a client document on `origin`. */
export function remoteKeyset(origin: string, fetchImpl?: Fetch) {
  return [
    new RemoteSigningKey(
      OAUTH_SIGNING_KEY,
      `${origin}${CLIENT_ASSERTION_PATH}`,
      fetchImpl,
    ),
  ]
}
