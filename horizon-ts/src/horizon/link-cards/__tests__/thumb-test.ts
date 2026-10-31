import {describe, expect, it, jest} from '@jest/globals'

import {directImageUrl, thumbWithDirectFallback} from '../thumb'

const SITE_IMAGE = 'https://images.example.com/card.png'
const CARDYB = `https://cardyb.bsky.app/v1/image?url=${encodeURIComponent(SITE_IMAGE)}`

describe('a link card image', () => {
  it('finds the site image behind a card service link', () => {
    expect(directImageUrl(CARDYB)).toBe(SITE_IMAGE)
    expect(
      directImageUrl(
        `https://cardyb.staging.bsky.dev/v1/image?url=${encodeURIComponent(SITE_IMAGE)}`,
      ),
    ).toBe(SITE_IMAGE)
  })

  it('leaves other links alone', () => {
    expect(directImageUrl(SITE_IMAGE)).toBeUndefined()
    expect(
      directImageUrl('https://cardyb.bsky.app/v1/favicon?url=x'),
    ).toBeUndefined()
    expect(
      directImageUrl(
        `https://cardyb.bsky.app.example.com/v1/image?url=${encodeURIComponent(SITE_IMAGE)}`,
      ),
    ).toBeUndefined()
    expect(
      directImageUrl(
        `https://cardyb.bsky.app/v1/image?url=${encodeURIComponent('http://images.example.com/a.png')}`,
      ),
    ).toBeUndefined()
    expect(directImageUrl('not a url')).toBeUndefined()
  })

  it('uses the card service image when it works', async () => {
    const toThumb = jest.fn((uri: string) => Promise.resolve(`thumb:${uri}`))
    await expect(thumbWithDirectFallback(CARDYB, toThumb)).resolves.toBe(
      `thumb:${CARDYB}`,
    )
    expect(toThumb).toHaveBeenCalledTimes(1)
  })

  it('falls back to the site image when it fails', async () => {
    const toThumb = jest.fn((uri: string) =>
      Promise.resolve(uri === SITE_IMAGE ? 'site thumb' : undefined),
    )
    await expect(thumbWithDirectFallback(CARDYB, toThumb)).resolves.toBe(
      'site thumb',
    )
    expect(toThumb.mock.calls.map(call => call[0])).toEqual([
      CARDYB,
      SITE_IMAGE,
    ])
  })

  it('gives no thumbnail when both fail', async () => {
    const toThumb = jest.fn(() => Promise.resolve(undefined))
    await expect(
      thumbWithDirectFallback(CARDYB, toThumb),
    ).resolves.toBeUndefined()
  })
})
