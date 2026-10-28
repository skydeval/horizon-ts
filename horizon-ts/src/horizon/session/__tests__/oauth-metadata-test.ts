import {describe, expect, it} from '@jest/globals'

import committedProduction from '../../../../public/oauth-client-metadata.json'
import committedDev from '../../../../public/oauth-client-metadata-dev.json'
import committedNative from '../../../../public/oauth-client-metadata-native.json'
import {
  createPreviewClientMetadata,
  HOSTED_DEV_CLIENT_METADATA,
  isOAuthPopupComplete,
  loopbackClientId,
  NATIVE_CLIENT_METADATA,
  OAUTH_SCOPE,
  PRODUCTION_CLIENT_METADATA,
  selectOAuthClientMode,
} from '../oauth-metadata'

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

  it('the production document is the design document', () => {
    expect(PRODUCTION_CLIENT_METADATA).toEqual({
      client_id: 'https://nearhorizon.app/oauth-client-metadata.json',
      client_name: 'Horizon',
      client_uri: 'https://nearhorizon.app',
      redirect_uris: ['https://nearhorizon.app/auth/web/callback'],
      scope: 'atproto transition:generic transition:email transition:chat.bsky',
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      application_type: 'web',
      dpop_bound_access_tokens: true,
    })
  })

  it('the loopback client ID carries the callback route and the scope', () => {
    const id = new URL(loopbackClientId('8081'))
    expect(id.origin).toBe('http://localhost')
    expect(id.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:8081/auth/web/callback',
    )
    expect(id.searchParams.get('scope')).toBe(OAUTH_SCOPE)
  })

  it('the preview document is the production document at the preview origin', () => {
    expect(createPreviewClientMetadata(PREVIEW)).toEqual({
      ...PRODUCTION_CLIENT_METADATA,
      client_id: 'https://preview.example.invalid/oauth-client-metadata.json',
      client_name: 'Horizon (preview)',
      client_uri: 'https://preview.example.invalid',
      redirect_uris: ['https://preview.example.invalid/auth/web/callback'],
    })
    expect(createPreviewClientMetadata(PREVIEW).scope).toBe(OAUTH_SCOPE)
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
