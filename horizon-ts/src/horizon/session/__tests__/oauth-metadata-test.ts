import {describe, expect, it} from '@jest/globals'

import committedJwks from '../../../../public/oauth/jwks.json'
import committedProduction from '../../../../public/oauth-client-metadata.json'
import committedAndroid from '../../../../public/oauth-client-metadata-android.json'
import committedDev from '../../../../public/oauth-client-metadata-dev.json'
import committedNative from '../../../../public/oauth-client-metadata-native.json'
import {
  ANDROID_CLIENT_METADATA,
  createOAuthClientMetadata,
  createPreviewClientMetadata,
  HOSTED_DEV_CLIENT_METADATA,
  isOAuthPopupComplete,
  loopbackClientId,
  NATIVE_CLIENT_METADATA,
  OAUTH_SCOPE,
  PRODUCTION_CLIENT_METADATA,
  selectOAuthClientMode,
} from '../oauth-metadata'
import {OAUTH_SIGNING_KEY} from '../oauth-signing-key.generated'

const PREVIEW = 'https://preview.example.invalid'

describe('OAuth client metadata', () => {
  it('the committed production document equals the one built in code', () => {
    expect(committedProduction).toEqual(PRODUCTION_CLIENT_METADATA)
  })

  it('the committed development document equals the one built in code', () => {
    expect(committedDev).toEqual(HOSTED_DEV_CLIENT_METADATA)
  })

  it('the committed app document equals the one built in code', () => {
    expect(committedNative).toEqual(NATIVE_CLIENT_METADATA)
  })

  it("the app document is a native client whose redirect is nearhorizon.app's reversed scheme", () => {
    expect(NATIVE_CLIENT_METADATA).toEqual({
      client_id: 'https://nearhorizon.app/oauth-client-metadata-native.json',
      client_name: 'Horizon',
      client_uri: 'https://nearhorizon.app',
      redirect_uris: ['app.nearhorizon:/oauth/callback'],
      scope: 'atproto transition:generic transition:email transition:chat.bsky',
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      application_type: 'native',
      dpop_bound_access_tokens: true,
    })
    // The library accepts only a `scheme:/path` redirect with a dotted scheme
    expect(NATIVE_CLIENT_METADATA.redirect_uris[0]).toMatch(
      /^(?:[^.]+(?:\.[^.]+)+):\/(?:[^/].*)?$/,
    )
  })

  it('the production document is a signed web client', () => {
    expect(PRODUCTION_CLIENT_METADATA).toEqual({
      client_id: 'https://nearhorizon.app/oauth-client-metadata.json',
      client_name: 'Horizon',
      client_uri: 'https://nearhorizon.app',
      redirect_uris: ['https://nearhorizon.app/auth/web/callback'],
      scope: 'atproto transition:generic transition:email transition:chat.bsky',
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      jwks_uri: 'https://nearhorizon.app/oauth/jwks.json',
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      application_type: 'web',
      dpop_bound_access_tokens: true,
    })
  })

  it('the committed Android document equals the one built in code', () => {
    expect(committedAndroid).toEqual(ANDROID_CLIENT_METADATA)
  })

  it('the Android document is a signed web client returning through nearhorizon.app', () => {
    expect(ANDROID_CLIENT_METADATA).toEqual({
      ...PRODUCTION_CLIENT_METADATA,
      client_id: 'https://nearhorizon.app/oauth-client-metadata-android.json',
      redirect_uris: ['https://nearhorizon.app/auth/app/callback'],
    })
  })

  it('a native document is never signed (the server refuses it)', () => {
    expect(
      createOAuthClientMetadata({
        clientId: 'https://example.invalid/c.json',
        clientUri: 'https://example.invalid',
        redirectUri: 'invalid.example:/cb',
        clientName: 'x',
        applicationType: 'native',
        signed: {jwksOrigin: 'https://example.invalid'},
      }).token_endpoint_auth_method,
    ).toBe('none')
  })

  it('the published keys are the public half the app signs with', () => {
    expect(committedJwks).toEqual({keys: [OAUTH_SIGNING_KEY]})
    expect(OAUTH_SIGNING_KEY).not.toHaveProperty('d')
  })

  it('the loopback client ID carries the callback route and the scope', () => {
    const id = new URL(loopbackClientId('8081'))
    expect(id.origin).toBe('http://localhost')
    expect(id.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:8081/auth/web/callback',
    )
    expect(id.searchParams.get('scope')).toBe(OAUTH_SCOPE)
  })

  it('a preview elsewhere is the production document there, as a public client', () => {
    const {
      token_endpoint_auth_signing_alg: _alg,
      jwks_uri: _jwks,
      ...unsigned
    } = PRODUCTION_CLIENT_METADATA
    expect(createPreviewClientMetadata(PREVIEW)).toEqual({
      ...unsigned,
      token_endpoint_auth_method: 'none',
      client_id: 'https://preview.example.invalid/oauth-client-metadata.json',
      client_name: 'Horizon (preview)',
      client_uri: 'https://preview.example.invalid',
      redirect_uris: ['https://preview.example.invalid/auth/web/callback'],
    })
    expect(createPreviewClientMetadata(PREVIEW).scope).toBe(OAUTH_SCOPE)
  })

  it('the preview build on nearhorizon.app is the production document', () => {
    expect(createPreviewClientMetadata('https://nearhorizon.app')).toEqual(
      PRODUCTION_CLIENT_METADATA,
    )
  })

  describe('selectOAuthClientMode', () => {
    const base = {
      env: undefined,
      requested: undefined,
      previewOrigin: undefined,
      hostname: undefined,
    }

    it('a preview build uses the preview document, production or not', () => {
      expect(
        selectOAuthClientMode({
          ...base,
          env: 'production',
          requested: 'preview',
          previewOrigin: PREVIEW,
        }),
      ).toBe('preview')
      expect(
        selectOAuthClientMode({
          ...base,
          env: 'development',
          requested: 'preview',
          previewOrigin: PREVIEW,
          hostname: '127.0.0.1',
        }),
      ).toBe('preview')
    })

    it('preview without an origin is not a preview build', () => {
      expect(
        selectOAuthClientMode({
          ...base,
          env: 'production',
          requested: 'preview',
        }),
      ).toBe('production')
      expect(
        selectOAuthClientMode({
          ...base,
          requested: 'preview',
          hostname: '127.0.0.1',
        }),
      ).toBe('loopback')
    })

    it('a production build ignores the other modes', () => {
      for (const requested of ['loopback', 'hosted-dev', undefined]) {
        expect(
          selectOAuthClientMode({
            ...base,
            env: 'production',
            requested,
            hostname: '127.0.0.1',
          }),
        ).toBe('production')
      }
    })

    it('outside production the requested mode wins', () => {
      for (const requested of ['production', 'loopback', 'hosted-dev']) {
        expect(
          selectOAuthClientMode({
            ...base,
            env: 'development',
            requested,
            hostname: 'example.com',
          }),
        ).toBe(requested)
      }
    })

    it('outside production a loopback host defaults to loopback', () => {
      for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
        expect(selectOAuthClientMode({...base, hostname})).toBe('loopback')
      }
      expect(
        selectOAuthClientMode({
          ...base,
          requested: 'nonsense',
          hostname: 'a.b',
        }),
      ).toBe('production')
      expect(selectOAuthClientMode(base)).toBe('production')
    })
  })

  it('recognises the popup hand-off error', () => {
    const handOff = Object.assign(new Error('done'), {
      code: 'LOGIN_CONTINUED_IN_PARENT_WINDOW',
    })
    expect(isOAuthPopupComplete(handOff)).toBe(true)
    expect(isOAuthPopupComplete(new Error('other'))).toBe(false)
  })
})
