import {describe, expect, it} from '@jest/globals'

import committedProduction from '../../../../public/oauth-client-metadata.json'
import committedDev from '../../../../public/oauth-client-metadata-dev.json'
import {
  HOSTED_DEV_CLIENT_METADATA,
  isOAuthPopupComplete,
  loopbackClientId,
  OAUTH_SCOPE,
  PRODUCTION_CLIENT_METADATA,
} from '../oauth-metadata'

describe('OAuth client metadata', () => {
  it('the committed production document equals the one built in code', () => {
    expect(committedProduction).toEqual(PRODUCTION_CLIENT_METADATA)
  })

  it('the committed development document equals the one built in code', () => {
    expect(committedDev).toEqual(HOSTED_DEV_CLIENT_METADATA)
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

  it('recognises the popup hand-off error', () => {
    const handOff = Object.assign(new Error('done'), {
      code: 'LOGIN_CONTINUED_IN_PARENT_WINDOW',
    })
    expect(isOAuthPopupComplete(handOff)).toBe(true)
    expect(isOAuthPopupComplete(new Error('other'))).toBe(false)
  })
})
