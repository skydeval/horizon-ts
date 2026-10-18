import {describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {
  PrivatePostInvalidError,
  utf8Length,
  validatePrivateRecord,
} from '../api/validate'
import {AUDIENCE, blob, DID, RECORD_CID} from './fixtures'

const PP = 'tools.kryphocron.feed.postPrivate'
const PUB = 'tools.kryphocron.feed.postPublic'

function base(overrides: Record<string, unknown> = {}) {
  return {
    $type: PP,
    text: 'hello @alice.test https://example.com #tag',
    createdAt: '2026-10-15T12:00:00.000Z',
    audienceList: AUDIENCE,
    ...overrides,
  }
}

const ref = {uri: `at://${DID}/${PP}/3kparent22`, cid: RECORD_CID}

function rejects(record: unknown, path?: string) {
  let caught: unknown
  try {
    validatePrivateRecord(record)
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(PrivatePostInvalidError)
  if (path) expect((caught as PrivatePostInvalidError).path).toBe(path)
}

describe('validatePrivateRecord', () => {
  it('accepts a full record: facets of all three kinds and a reply', () => {
    const record = base({
      facets: [
        {
          $type: `${PUB}#facet`,
          index: {byteStart: 6, byteEnd: 17},
          features: [{$type: `${PUB}#mention`, did: DID}],
        },
        {
          $type: `${PUB}#facet`,
          index: {byteStart: 18, byteEnd: 37},
          features: [{$type: `${PUB}#link`, uri: 'https://example.com'}],
        },
        {
          $type: `${PUB}#facet`,
          index: {byteStart: 38, byteEnd: 42},
          features: [{$type: `${PUB}#tag`, tag: 'tag'}],
        },
      ],
      reply: {root: ref, parent: ref},
    })
    expect(validatePrivateRecord(record)).toBe(record)
  })

  it('accepts each embed kind', () => {
    expect(() =>
      validatePrivateRecord(
        base({
          embed: {
            $type: `${PUB}#embedImage`,
            images: [{image: blob(), alt: 'a cat'}],
          },
        }),
      ),
    ).not.toThrow()
    expect(() =>
      validatePrivateRecord(
        base({
          embed: {
            $type: `${PUB}#embedExternal`,
            external: {
              uri: 'https://example.com',
              title: 'Example',
              description: 'An example',
            },
          },
        }),
      ),
    ).not.toThrow()
    expect(() =>
      validatePrivateRecord(
        base({embed: {$type: `${PUB}#embedRecord`, record: ref}}),
      ),
    ).not.toThrow()
  })

  it('accepts empty text with an embed', () => {
    expect(() =>
      validatePrivateRecord(
        base({
          text: '',
          embed: {$type: `${PUB}#embedRecord`, record: ref},
        }),
      ),
    ).not.toThrow()
  })

  it('rejects an extra top-level key', () => {
    rejects(base({publicCompanion: ref.uri}), 'publicCompanion')
  })

  it('accepts langs and self-labels (K-1, PRIVATE_LANGS_LABELS on)', () => {
    expect(() =>
      validatePrivateRecord(
        base({
          langs: ['en'],
          labels: {$type: `${PUB}#selfLabels`, values: [{val: 'nudity'}]},
        }),
      ),
    ).not.toThrow()
  })

  it('accepts a quote with images, aspect ratios and a link thumbnail (K-2, K-4)', () => {
    expect(() =>
      validatePrivateRecord(
        base({
          embed: {
            $type: `${PUB}#embedRecordWithMedia`,
            record: {record: ref},
            media: {
              $type: `${PUB}#embedImage`,
              images: [
                {image: blob(), alt: '', aspectRatio: {width: 3, height: 2}},
              ],
            },
          },
        }),
      ),
    ).not.toThrow()
    expect(() =>
      validatePrivateRecord(
        base({
          embed: {
            $type: `${PUB}#embedExternal`,
            external: {
              uri: 'https://example.com',
              title: 't',
              description: 'd',
              thumb: blob(),
            },
          },
        }),
      ),
    ).not.toThrow()
  })

  it('rejects another $type', () => {
    rejects(base({$type: 'app.bsky.feed.post'}), '$type')
  })

  it('rejects a missing or non-string text', () => {
    const {text: _text, ...withoutText} = base()
    rejects(withoutText, 'text')
    rejects(base({text: 42}), 'text')
  })

  it('rejects a 301-grapheme text', () => {
    rejects(base({text: 'a'.repeat(301)}), 'text')
  })

  it('rejects a 3001-byte text', () => {
    // 250 graphemes of 12 bytes each (a family emoji), over the byte limit.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    const text = family.repeat(250) + 'a'
    expect(utf8Length(text)).toBeGreaterThan(3000)
    rejects(base({text}), 'text')
  })

  it('rejects an empty text with no embed', () => {
    rejects(base({text: ''}), 'text')
  })

  it('rejects an invalid createdAt', () => {
    rejects(base({createdAt: 'yesterday'}), 'createdAt')
  })

  it('rejects an audience URI in the wrong collection', () => {
    rejects(
      base({audienceList: `at://${DID}/app.bsky.graph.list/3kaud`}),
      'audienceList',
    )
  })

  it('rejects an audience URI without a DID authority', () => {
    rejects(
      base({
        audienceList: 'at://alice.test/tools.kryphocron.policy.audience/3kaud',
      }),
      'audienceList',
    )
  })

  it('rejects a reply without both refs', () => {
    rejects(base({reply: {parent: ref}}))
  })

  it('rejects a reply ref without cid', () => {
    rejects(base({reply: {root: ref, parent: {uri: ref.uri}}}))
  })

  it('rejects a reply ref whose cid is not a CID', () => {
    rejects(base({reply: {root: ref, parent: {uri: ref.uri, cid: 'nope'}}}))
  })

  it('rejects an embed of another type', () => {
    rejects(
      base({embed: {$type: 'app.bsky.embed.images', images: []}}),
      'embed.$type',
    )
  })

  it('rejects five images', () => {
    rejects(
      base({
        embed: {
          $type: `${PUB}#embedImage`,
          images: Array.from({length: 5}, () => ({image: blob(), alt: ''})),
        },
      }),
      'embed.images',
    )
  })

  it('rejects an image that is not an image or is too large', () => {
    rejects(
      base({
        embed: {
          $type: `${PUB}#embedImage`,
          images: [{image: blob(1000, 'video/mp4'), alt: ''}],
        },
      }),
      'embed.images[0].image.mimeType',
    )
    rejects(
      base({
        embed: {
          $type: `${PUB}#embedImage`,
          images: [{image: blob(2_000_001), alt: ''}],
        },
      }),
      'embed.images[0].image.size',
    )
  })

  it('rejects an alt that is not a string', () => {
    rejects(
      base({
        embed: {
          $type: `${PUB}#embedImage`,
          images: [{image: blob()}],
        },
      }),
      'embed.images[0].alt',
    )
  })

  it('rejects a facet past the end of the text', () => {
    rejects(
      base({
        text: 'hi',
        facets: [
          {
            $type: `${PUB}#facet`,
            index: {byteStart: 0, byteEnd: 3},
            features: [{$type: `${PUB}#tag`, tag: 'hi'}],
          },
        ],
      }),
      'facets[0].index',
    )
  })

  it('rejects a negative or inverted facet', () => {
    const facet = (byteStart: number, byteEnd: number) => ({
      $type: `${PUB}#facet`,
      index: {byteStart, byteEnd},
      features: [{$type: `${PUB}#tag`, tag: 'x'}],
    })
    rejects(base({facets: [facet(-1, 2)]}), 'facets[0].index')
    rejects(base({facets: [facet(4, 2)]}), 'facets[0].index')
  })

  it('rejects a facet feature of another type, or a tag too long', () => {
    rejects(
      base({
        facets: [
          {
            $type: `${PUB}#facet`,
            index: {byteStart: 0, byteEnd: 2},
            features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'x'}],
          },
        ],
      }),
    )
    rejects(
      base({
        facets: [
          {
            $type: `${PUB}#facet`,
            index: {byteStart: 0, byteEnd: 2},
            features: [{$type: `${PUB}#tag`, tag: 'x'.repeat(65)}],
          },
        ],
      }),
    )
  })

  it('rejects a mention without a DID and a link without a URI', () => {
    const facet = (feature: unknown) => ({
      $type: `${PUB}#facet`,
      index: {byteStart: 0, byteEnd: 2},
      features: [feature],
    })
    rejects(
      base({facets: [facet({$type: `${PUB}#mention`, did: 'alice.test'})]}),
    )
    rejects(base({facets: [facet({$type: `${PUB}#link`, uri: 'not a uri'})]}))
  })
})

describe('validatePrivateRecord, spoiler facets (spoilers design 5.6)', () => {
  const SP = 'app.nearhorizon.richtext.facet#spoiler'
  const MK = 'app.nearhorizon.richtext.facet#spoilerMarker'
  const facet = (byteStart: number, byteEnd: number, ...types: string[]) => ({
    $type: `${PUB}#facet`,
    index: {byteStart, byteEnd},
    features: types.map(type =>
      type === 'tag' ? {$type: `${PUB}#tag`, tag: 'x'} : {$type: type},
    ),
  })

  it('accepts a keep-mode spoiler and a strip-mode one', () => {
    expect(() =>
      validatePrivateRecord(
        base({
          text: 'a ||b|| c',
          facets: [facet(2, 4, MK), facet(4, 5, SP), facet(5, 7, MK)],
        }),
      ),
    ).not.toThrow()
    expect(() =>
      validatePrivateRecord(
        base({
          text: 'Intro\n||\nSecret #x\n||',
          facets: [
            facet(6, 9, MK),
            facet(9, 16, SP),
            facet(16, 18, 'tag', SP),
            facet(18, 21, MK),
          ],
        }),
      ),
    ).not.toThrow()
    expect(() =>
      validatePrivateRecord(base({text: 'a b c', facets: [facet(2, 3, SP)]})),
    ).not.toThrow()
  })

  it('rejects overlapping facets', () => {
    rejects(
      base({text: 'abcdef', facets: [facet(0, 3, SP), facet(2, 4, 'tag')]}),
      'facets[1].index',
    )
  })

  it('rejects an empty spoiler facet', () => {
    rejects(base({text: 'ab', facets: [facet(1, 1, SP)]}), 'facets[0].index')
  })

  it('rejects a marker facet over other text', () => {
    rejects(base({text: 'ab||', facets: [facet(0, 2, MK)]}), 'facets[0].index')
    rejects(base({text: '|||', facets: [facet(0, 3, MK)]}), 'facets[0].index')
  })

  it('rejects facets over 64 KiB serialized', () => {
    const text = 'x '.repeat(150)
    const long = `https://example.com/${'a'.repeat(1000)}`
    const facets = Array.from({length: 70}, (_, i) => ({
      $type: `${PUB}#facet`,
      index: {byteStart: i * 2, byteEnd: i * 2 + 1},
      features: [{$type: `${PUB}#link`, uri: long}],
    }))
    expect(utf8Length(JSON.stringify(facets))).toBeGreaterThan(64 * 1024)
    rejects(base({text, facets}), 'facets')
    expect(() =>
      validatePrivateRecord(base({text, facets: facets.slice(0, 50)})),
    ).not.toThrow()
  })
})
