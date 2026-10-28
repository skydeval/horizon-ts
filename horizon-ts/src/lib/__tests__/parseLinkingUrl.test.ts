import {describe, expect, it} from '@jest/globals'

import {parseLinkingUrl} from '../parseLinkingUrl'

describe('parseLinkingUrl', () => {
  it('should correctly parse app.nearhorizon:// URLs', () => {
    const url =
      'app.nearhorizon://intent/age-assurance?result=success&actorDid=did:example:123'
    const urlp = parseLinkingUrl(url)
    expect(urlp.protocol).toBe('app.nearhorizon:')
    expect(urlp.host).toBe('')
    expect(urlp.pathname).toBe('/intent/age-assurance')
  })

  it('should correctly parse standard URLs', () => {
    const url =
      'https://bsky.app/intent/age-assurance?result=success&actorDid=did:example:123'
    const urlp = parseLinkingUrl(url)
    expect(urlp.protocol).toBe('https:')
    expect(urlp.host).toBe('bsky.app')
    expect(urlp.pathname).toBe('/intent/age-assurance')
  })
})
