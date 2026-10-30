import {describe, expect, it} from '@jest/globals'

import {isCdnImage, savedImageFilename} from '../util'

const CID = 'bafkreihwihm6kpd6zuwhhlro75p5qks5qtrcu55jp3gddbfjsieiv7wuka'

describe('savedImageFilename', () => {
  it('names a CDN image after its CID', () => {
    expect(
      savedImageFilename(
        `https://cdn.bsky.app/img/download/plain/did:plc:example/${CID}@jpeg`,
      ),
    ).toBe(`${CID}.jpg`)
  })

  it('gives the same name for every preset of an image', () => {
    const full = `https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:example/${CID}@jpeg`
    const thumb = `https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:example/${CID}`
    expect(savedImageFilename(full)).toBe(savedImageFilename(thumb))
  })

  it('names a getBlob image after its cid parameter', () => {
    expect(
      savedImageFilename(
        `https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Aexample&cid=${CID}`,
      ),
    ).toBe(`${CID}.jpg`)
  })

  it('keeps only safe characters', () => {
    expect(savedImageFilename('https://example.com/a/..%2Fb c@png')).toBe(
      '2Fbc.jpg',
    )
  })

  it('falls back to a fixed name', () => {
    expect(savedImageFilename('')).toBe('image.jpg')
  })
})

describe('isCdnImage', () => {
  it('knows the CDN', () => {
    expect(isCdnImage(`https://cdn.bsky.app/img/download/plain/x/${CID}`)).toBe(
      true,
    )
    expect(isCdnImage('https://pds.example.com/xrpc/x')).toBe(false)
  })
})
