// The library's own Keyset, as the OAuth client builds it
// eslint-disable-next-line import/no-extraneous-dependencies
import {Keyset} from '@atproto/jwk'
import {describe, expect, it, jest} from '@jest/globals'

import {isAuthError} from '../auth-errors'
import {
  CLIENT_ASSERTION_PATH,
  remoteKeyset,
  RemoteSigningKey,
  SignerUnavailableError,
} from '../oauth-signing'
import {OAUTH_SIGNING_KEY} from '../oauth-signing-key.generated'

/*
 * The remote signing key: what it sends the signer, how the library's
 * Keyset finds it, and that a failure never reads as an ended session.
 */

const ORIGIN = 'https://nearhorizon.app'
const CLIENT = `${ORIGIN}/oauth-client-metadata.json`
const ISSUER = 'https://pds.example.invalid'
const ASSERTION = 'aaa.bbb.ccc'

type FetchArgs = [string, RequestInit]

function answering(...responses: (Response | Error)[]) {
  const fetchImpl = jest.fn<(...args: FetchArgs) => Promise<Response>>()
  for (const response of responses) {
    if (response instanceof Error) fetchImpl.mockRejectedValueOnce(response)
    else fetchImpl.mockResolvedValueOnce(response)
  }
  return fetchImpl
}

function ok() {
  return new Response(JSON.stringify({client_assertion: ASSERTION}), {
    status: 200,
  })
}

describe('RemoteSigningKey', () => {
  it('asks the signer with only the client ID and the issuer', async () => {
    const fetchImpl = answering(ok())
    const [key] = remoteKeyset(ORIGIN, fetchImpl)
    const jwt = await key.createJwt(
      {alg: 'ES256'},
      {iss: CLIENT, sub: CLIENT, aud: ISSUER, jti: 'x', iat: 1, exp: 2},
    )
    expect(jwt).toBe(ASSERTION)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${ORIGIN}${CLIENT_ASSERTION_PATH}`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: CLIENT,
      aud: ISSUER,
    })
  })

  it('is the signing key the library’s Keyset negotiates and finds', () => {
    const keyset = new Keyset(
      remoteKeyset(ORIGIN) as unknown as ConstructorParameters<
        typeof Keyset
      >[0],
    )
    const listed = Array.from(keyset.list({alg: ['ES256'], usage: 'sign'}))
    expect(listed.map(k => k.kid)).toEqual([OAUTH_SIGNING_KEY.kid])
    const {key, alg} = keyset.findPrivateKey({
      usage: 'sign',
      kid: OAUTH_SIGNING_KEY.kid,
      alg: ['ES256'],
    })
    expect(alg).toBe('ES256')
    expect(key.kid).toBe(OAUTH_SIGNING_KEY.kid)
    expect(keyset.publicJwks.keys).toEqual([OAUTH_SIGNING_KEY])
  })

  it('tries once more after a failure', async () => {
    const fetchImpl = answering(new TypeError('Failed to fetch'), ok())
    const key = new RemoteSigningKey(OAUTH_SIGNING_KEY, ORIGIN, fetchImpl)
    await expect(key.createJwt({}, {iss: CLIENT, aud: ISSUER})).resolves.toBe(
      ASSERTION,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails as SignerUnavailableError, never a TypeError or an auth error', async () => {
    for (const failure of [
      new TypeError('Failed to fetch'),
      new Response('{}', {status: 503}),
      new Response('not json', {status: 200}),
      new Response(JSON.stringify({client_assertion: 'nope'}), {status: 200}),
    ]) {
      const again =
        failure instanceof Response ? failure.clone() : new TypeError('x')
      const key = new RemoteSigningKey(
        OAUTH_SIGNING_KEY,
        ORIGIN,
        answering(failure, again),
      )
      const error = await key
        .createJwt({}, {iss: CLIENT, aud: ISSUER})
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SignerUnavailableError)
      expect(error).not.toBeInstanceOf(TypeError)
      expect(isAuthError(error)).toBe(false)
    }
  })
})
