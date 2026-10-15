import {beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/state/session', () => ({
  useMaybePdsClient: () => null,
}))

import {BLUESKY_PROXY_HEADER, PUBLIC_BSKY_SERVICE} from '#/lib/constants'
import {isPrismDid, validatePublicAppview} from '../appview-validation'
import {type DidDocument, didWebFromUrl} from '../did-web'
import {
  getPublicAppviewService,
  getPublicAppviewUrl,
  usesBlueskyPublicAppview,
  writePublicAppviewChoice,
} from '../public-appview'

beforeEach(() => {
  writePublicAppviewChoice(undefined)
})

describe('the public AppView readers', () => {
  it('fall back to the stock values by default', () => {
    expect(getPublicAppviewService(BLUESKY_PROXY_HEADER.get())).toBe(
      BLUESKY_PROXY_HEADER.get(),
    )
    expect(getPublicAppviewUrl(PUBLIC_BSKY_SERVICE)).toBe(PUBLIC_BSKY_SERVICE)
    expect(usesBlueskyPublicAppview()).toBe(true)
  })

  it('read a stored choice', () => {
    writePublicAppviewChoice({
      did: 'did:web:appview.example',
      url: 'https://appview.example',
    })
    expect(getPublicAppviewService('did:web:api.bsky.app#bsky_appview')).toBe(
      'did:web:appview.example#bsky_appview',
    )
    expect(getPublicAppviewUrl(PUBLIC_BSKY_SERVICE)).toBe(
      'https://appview.example',
    )
    expect(usesBlueskyPublicAppview()).toBe(false)
  })
})

function deps(doc: DidDocument | undefined, isPds = false) {
  return {
    fetchDocument: jest.fn((_did: string) => Promise.resolve(doc)),
    answersDescribeServer: jest.fn((_url: string) => Promise.resolve(isPds)),
  }
}

describe('the switcher validator', () => {
  it('rejects prism by its DID, without looking it up', async () => {
    const lookups = deps(undefined)
    await expect(
      validatePublicAppview('api.nearhorizon.app', lookups),
    ).resolves.toEqual({ok: false, reason: 'prism'})
    expect(lookups.fetchDocument).not.toHaveBeenCalled()
    expect(isPrismDid('did:web:api.nearhorizon.app')).toBe(true)
  })

  it('accepts an AppView with a #bsky_appview service of type BskyAppView', async () => {
    const result = await validatePublicAppview(
      'https://appview.example/',
      deps({
        id: 'did:web:appview.example',
        service: [
          {
            id: '#bsky_appview',
            type: 'BskyAppView',
            serviceEndpoint: 'https://api.appview.example',
          },
        ],
      }),
    )
    expect(result).toEqual({
      ok: true,
      choice: {
        did: 'did:web:appview.example',
        url: 'https://api.appview.example',
      },
    })
  })

  it('names a PDS as a PDS', async () => {
    await expect(
      validatePublicAppview('bsky.social', deps(undefined, true)),
    ).resolves.toEqual({ok: false, reason: 'pds'})
  })

  it('reports an address with neither', async () => {
    await expect(
      validatePublicAppview('nothing.example', deps(undefined)),
    ).resolves.toEqual({ok: false, reason: 'not-found'})
  })

  it('derives did:web with an encoded port', () => {
    expect(didWebFromUrl('localhost:2584')).toBe('did:web:localhost%3A2584')
    expect(didWebFromUrl('https://api.example.com/')).toBe(
      'did:web:api.example.com',
    )
  })
})
