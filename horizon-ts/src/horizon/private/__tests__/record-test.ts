import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; blob CIDs need the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockVideo = false
let mockGallery = false
let mockQuoteWithMedia = false
let mockMediaExtras = false
let mockFacetsServed = false
let mockLangsLabels = true

jest.mock('#/horizon/private/server-support', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/private/server-support')},
    {
      PRIVATE_LANGS_LABELS: {get: () => mockLangsLabels, enumerable: true},
      PRIVATE_VIDEO: {get: () => mockVideo, enumerable: true},
      PRIVATE_GALLERY: {get: () => mockGallery, enumerable: true},
      PRIVATE_QUOTE_WITH_MEDIA: {
        get: () => mockQuoteWithMedia,
        enumerable: true,
      },
      PRIVATE_MEDIA_EXTRAS: {get: () => mockMediaExtras, enumerable: true},
      // A read-time decision: the function stands in for the feature store.
      privateFacetsServed: {value: () => mockFacetsServed, enumerable: true},
    },
  ),
)

import {type $Typed} from '@atproto/lex'

import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {
  detectLocalFacets,
  PrivateEmbedUnsupportedError,
  privateSelfLabelValues,
  toBskyRecord,
  toPrivateEmbed,
  toPrivateFacets,
  toPrivateSelfLabels,
} from '../adapt/record'
import {validatePrivateRecord} from '../api/validate'
import {AUDIENCE, blob, DID, RECORD_CID} from './fixtures'

const PUB = 'tools.kryphocron.feed.postPublic'
const ref = {
  uri: `at://${DID}/app.bsky.feed.post/3kquoted22`,
  cid: RECORD_CID,
} as const

beforeEach(() => {
  mockVideo = false
  mockGallery = false
  mockQuoteWithMedia = false
  mockMediaExtras = false
  mockFacetsServed = false
  mockLangsLabels = true
})

function validRecord(embed: unknown) {
  return validatePrivateRecord({
    $type: 'tools.kryphocron.feed.postPrivate',
    text: '',
    createdAt: '2026-10-15T12:00:00.000Z',
    audienceList: AUDIENCE,
    embed,
  })
}

const videoEmbed = {
  $type: 'app.bsky.embed.video',
  video: blob(5_000_000, 'video/mp4'),
  alt: 'a clip',
  aspectRatio: {width: 16, height: 9},
  captions: [{lang: 'en', file: blob(100, 'text/vtt')}],
  presentation: 'gif',
} as unknown as $Typed<app.bsky.embed.video.Main>

function galleryEmbed(count: number) {
  return {
    $type: 'app.bsky.embed.gallery',
    items: Array.from({length: count}, (_, i) => ({
      $type: 'app.bsky.embed.gallery#image',
      image: blob(),
      alt: `image ${i}`,
      aspectRatio: {width: 4, height: 3},
    })),
  } as unknown as $Typed<app.bsky.embed.gallery.Main>
}

describe('toPrivateFacets', () => {
  it('retypes mention, link and tag features and drops others', () => {
    const facets = [
      {
        index: {byteStart: 0, byteEnd: 6},
        features: [{$type: 'app.bsky.richtext.facet#mention', did: DID}],
      },
      {
        index: {byteStart: 7, byteEnd: 26},
        features: [
          {
            $type: 'app.bsky.richtext.facet#link',
            uri: 'https://example.com',
          },
        ],
      },
      {
        index: {byteStart: 27, byteEnd: 31},
        features: [
          {$type: 'app.bsky.richtext.facet#tag', tag: 'tag'},
          {$type: 'app.example.unknownFeature', value: 1},
        ],
      },
      {
        index: {byteStart: 0, byteEnd: 1},
        features: [{$type: 'app.example.unknownFeature'}],
      },
    ] as app.bsky.richtext.facet.Main[]
    expect(toPrivateFacets(facets)).toEqual([
      {
        $type: `${PUB}#facet`,
        index: {byteStart: 0, byteEnd: 6},
        features: [{$type: `${PUB}#mention`, did: DID}],
      },
      {
        $type: `${PUB}#facet`,
        index: {byteStart: 7, byteEnd: 26},
        features: [{$type: `${PUB}#link`, uri: 'https://example.com'}],
      },
      {
        $type: `${PUB}#facet`,
        index: {byteStart: 27, byteEnd: 31},
        features: [{$type: `${PUB}#tag`, tag: 'tag'}],
      },
    ])
    expect(toPrivateFacets(undefined)).toBeUndefined()
    expect(toPrivateFacets([])).toBeUndefined()
  })
})

describe('toPrivateEmbed', () => {
  it('images keep alt text and drop the aspect ratio', () => {
    const image = blob()
    expect(
      toPrivateEmbed({
        $type: 'app.bsky.embed.images',
        images: [{image, alt: 'a cat', aspectRatio: {width: 4, height: 3}}],
      }),
    ).toEqual({
      $type: `${PUB}#embedImage`,
      images: [{image, alt: 'a cat'}],
    })
  })

  it('a link card keeps title and description and drops the thumbnail', () => {
    expect(
      toPrivateEmbed({
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com',
          title: 'Example',
          description: 'An example',
          thumb: blob(),
        },
      }),
    ).toEqual({
      $type: `${PUB}#embedExternal`,
      external: {
        uri: 'https://example.com',
        title: 'Example',
        description: 'An example',
      },
    })
  })

  it('a quote becomes an embedRecord', () => {
    expect(
      toPrivateEmbed({$type: 'app.bsky.embed.record', record: ref}),
    ).toEqual({$type: `${PUB}#embedRecord`, record: ref})
  })

  it('nothing in, nothing out', () => {
    expect(toPrivateEmbed(undefined)).toBeUndefined()
  })

  it('a quote with media, a video and a gallery throw while their constants are off', () => {
    const embeds = [
      {
        $type: 'app.bsky.embed.recordWithMedia',
        record: {$type: 'app.bsky.embed.record', record: ref},
        media: {$type: 'app.bsky.embed.images', images: []},
      },
      {$type: 'app.bsky.embed.video', video: blob(1000, 'video/mp4')},
      {$type: 'app.bsky.embed.gallery', items: []},
    ] as app.bsky.feed.post.Main['embed'][]
    for (const embed of embeds) {
      expect(() => toPrivateEmbed(embed)).toThrow(PrivateEmbedUnsupportedError)
    }
  })

  it('with PRIVATE_VIDEO, a video becomes #embedVideo with the job’s blob, field for field', () => {
    mockVideo = true
    const converted = toPrivateEmbed(videoEmbed)
    expect(converted).toEqual({
      $type: `${PUB}#embedVideo`,
      video: videoEmbed.video,
      alt: 'a clip',
      aspectRatio: {width: 16, height: 9},
      captions: [{lang: 'en', file: videoEmbed.captions![0].file}],
      presentation: 'gif',
    })
    expect((converted as {video: unknown}).video).toBe(videoEmbed.video)
    expect(() => validRecord(converted)).not.toThrow()
  })

  it('with PRIVATE_GALLERY, a gallery becomes #embedGallery with typed items and aspect ratios', () => {
    mockGallery = true
    const converted = toPrivateEmbed(galleryEmbed(5)) as {
      $type: string
      items: {$type: string; aspectRatio: unknown}[]
    }
    expect(converted.$type).toBe(`${PUB}#embedGallery`)
    expect(converted.items).toHaveLength(5)
    for (const item of converted.items) {
      expect(item.$type).toBe(`${PUB}#galleryImage`)
      expect(item.aspectRatio).toEqual({width: 4, height: 3})
    }
    expect(() => validRecord(converted)).not.toThrow()
  })

  it('with PRIVATE_QUOTE_WITH_MEDIA, a quote with a video becomes #embedRecordWithMedia', () => {
    mockQuoteWithMedia = true
    mockVideo = true
    const converted = toPrivateEmbed({
      $type: 'app.bsky.embed.recordWithMedia',
      record: {$type: 'app.bsky.embed.record', record: ref},
      media: {...videoEmbed, $type: 'app.bsky.embed.video'},
    })
    expect(converted).toMatchObject({
      $type: `${PUB}#embedRecordWithMedia`,
      record: {record: ref},
      media: {$type: `${PUB}#embedVideo`, video: videoEmbed.video},
    })
    expect(() => validRecord(converted)).not.toThrow()
    // The media still follows its own constant.
    mockVideo = false
    expect(() =>
      toPrivateEmbed({
        $type: 'app.bsky.embed.recordWithMedia',
        record: {$type: 'app.bsky.embed.record', record: ref},
        media: {...videoEmbed, $type: 'app.bsky.embed.video'},
      }),
    ).toThrow(PrivateEmbedUnsupportedError)
  })

  it('with PRIVATE_MEDIA_EXTRAS, image aspect ratio and link thumbnail are kept', () => {
    mockMediaExtras = true
    const thumb = blob()
    expect(
      toPrivateEmbed({
        $type: 'app.bsky.embed.images',
        images: [{image: blob(), alt: '', aspectRatio: {width: 4, height: 3}}],
      }),
    ).toMatchObject({images: [{aspectRatio: {width: 4, height: 3}}]})
    expect(
      toPrivateEmbed({
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com',
          title: '',
          description: '',
          thumb,
        },
      }),
    ).toMatchObject({external: {thumb}})
  })

  it('validation rejects video and gallery records while their constants are off', () => {
    mockVideo = true
    mockGallery = true
    const video = toPrivateEmbed(videoEmbed)
    const gallery = toPrivateEmbed(galleryEmbed(5))
    mockVideo = false
    mockGallery = false
    expect(() => validRecord(video)).toThrow(/not an embed Horizon writes/)
    expect(() => validRecord(gallery)).toThrow(/not an embed Horizon writes/)
  })

  it('validation checks the video blob’s type and a gallery item’s aspect ratio', () => {
    mockVideo = true
    mockGallery = true
    expect(() =>
      validRecord({
        $type: `${PUB}#embedVideo`,
        video: blob(1000, 'video/quicktime'),
      }),
    ).toThrow(/embed.video.mimeType/)
    expect(() =>
      validRecord({
        $type: `${PUB}#embedGallery`,
        items: [{$type: `${PUB}#galleryImage`, image: blob(), alt: ''}],
      }),
    ).toThrow(/aspectRatio/)
  })

  it('every converted embed passes validation', () => {
    const embeds = [
      toPrivateEmbed({
        $type: 'app.bsky.embed.images',
        images: [{image: blob(), alt: ''}],
      }),
      toPrivateEmbed({
        $type: 'app.bsky.embed.external',
        external: {uri: 'https://example.com', title: '', description: ''},
      }),
      toPrivateEmbed({$type: 'app.bsky.embed.record', record: ref}),
    ]
    for (const embed of embeds) {
      expect(() =>
        validatePrivateRecord({
          $type: 'tools.kryphocron.feed.postPrivate',
          text: '',
          createdAt: '2026-10-15T12:00:00.000Z',
          audienceList: AUDIENCE,
          embed,
        }),
      ).not.toThrow()
    }
  })
})

describe('toBskyRecord', () => {
  it('converts a private record back to an app.bsky.feed.post record', () => {
    const record = {
      $type: 'tools.kryphocron.feed.postPrivate',
      text: 'hi #tag',
      createdAt: '2026-10-15T12:00:00.000Z',
      audienceList: AUDIENCE,
      facets: [
        {
          $type: `${PUB}#facet`,
          index: {byteStart: 3, byteEnd: 7},
          features: [{$type: `${PUB}#tag`, tag: 'tag'}],
        },
      ],
      reply: {root: ref, parent: ref},
      embed: {$type: `${PUB}#embedRecord`, record: ref},
    }
    expect(toBskyRecord(record)).toEqual({
      $type: 'app.bsky.feed.post',
      text: 'hi #tag',
      createdAt: '2026-10-15T12:00:00.000Z',
      facets: [
        {
          index: {byteStart: 3, byteEnd: 7},
          features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'tag'}],
        },
      ],
      reply: {root: ref, parent: ref},
      embed: {$type: 'app.bsky.embed.record', record: ref},
    })
  })

  it('converts video, gallery and quote-with-media embeds back to the stock records', () => {
    mockVideo = true
    mockGallery = true
    mockQuoteWithMedia = true
    const base = {
      $type: 'tools.kryphocron.feed.postPrivate',
      text: 'media',
      createdAt: '2026-10-15T12:00:00.000Z',
      audienceList: AUDIENCE,
    }
    const video = toBskyRecord({...base, embed: toPrivateEmbed(videoEmbed)})
    expect(video?.embed).toMatchObject({
      $type: 'app.bsky.embed.video',
      video: videoEmbed.video,
      presentation: 'gif',
    })
    const gallery = toBskyRecord({
      ...base,
      embed: toPrivateEmbed(galleryEmbed(6)),
    })
    expect(gallery?.embed).toMatchObject({$type: 'app.bsky.embed.gallery'})
    expect(
      (gallery?.embed as {items: {$type: string}[]}).items.map(i => i.$type),
    ).toEqual(Array(6).fill('app.bsky.embed.gallery#image'))
    const withMedia = toBskyRecord({
      ...base,
      embed: toPrivateEmbed({
        $type: 'app.bsky.embed.recordWithMedia',
        record: {$type: 'app.bsky.embed.record', record: ref},
        media: {
          $type: 'app.bsky.embed.images',
          images: [{image: blob(), alt: ''}],
        },
      }),
    })
    expect(withMedia?.embed).toMatchObject({
      $type: 'app.bsky.embed.recordWithMedia',
      record: {$type: 'app.bsky.embed.record', record: ref},
      media: {$type: 'app.bsky.embed.images'},
    })
    for (const record of [video, gallery, withMedia]) {
      expect(bsky.matches(app.bsky.feed.post, record)).toBe(true)
    }
  })

  it('refuses a record that is not a private post with string text', () => {
    expect(toBskyRecord({$type: 'app.bsky.feed.post', text: 'x'})).toBe(
      undefined,
    )
    expect(
      toBskyRecord({$type: 'tools.kryphocron.feed.postPrivate', text: 3}),
    ).toBeUndefined()
    expect(toBskyRecord(null)).toBeUndefined()
  })
})

describe('local links and hashtags (6.1.2)', () => {
  const base = {
    $type: 'tools.kryphocron.feed.postPrivate',
    createdAt: '2026-10-15T12:00:00.000Z',
    audienceList: AUDIENCE,
  }

  it('a served record without facets gains link and tag facets with byte ranges, and no mention', () => {
    const text = 'hi @alice.test see https://example.com/a #tag'
    const record = toBskyRecord({...base, text})
    expect(record?.facets).toEqual([
      {
        index: {byteStart: 19, byteEnd: 40},
        features: [
          {
            $type: 'app.bsky.richtext.facet#link',
            uri: 'https://example.com/a',
          },
        ],
      },
      {
        index: {byteStart: 41, byteEnd: 45},
        features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'tag'}],
      },
    ])
    expect(bsky.matches(app.bsky.feed.post, record)).toBe(true)
  })

  it('counts bytes in multi-byte text', () => {
    const text = 'caf\u00e9 \u{1F600} #caf\u00e9'
    const facets = detectLocalFacets(text)
    const encoder = new TextEncoder()
    const start = encoder.encode('caf\u00e9 \u{1F600} ').length
    expect(facets).toEqual([
      {
        index: {byteStart: start, byteEnd: encoder.encode(text).length},
        features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'caf\u00e9'}],
      },
    ])
  })

  it('a record that carries facets is used as it is', () => {
    const record = toBskyRecord({
      ...base,
      text: 'see https://example.com',
      facets: [],
    })
    expect(record?.facets).toBeUndefined()
  })

  it('nothing is detected once prism serves facets', () => {
    mockFacetsServed = true
    const record = toBskyRecord({...base, text: 'see https://example.com #tag'})
    expect(record?.facets).toBeUndefined()
  })
})

describe('languages and self-labels (K-1)', () => {
  const base = {
    $type: 'tools.kryphocron.feed.postPrivate',
    text: 'hello',
    createdAt: '2026-10-15T12:00:00.000Z',
    audienceList: AUDIENCE,
  }

  it('the composer’s labels become #selfLabels with PRIVATE_LANGS_LABELS on', () => {
    expect(toPrivateSelfLabels(['nudity', 'graphic-media'])).toEqual({
      $type: `${PUB}#selfLabels`,
      values: [{val: 'nudity'}, {val: 'graphic-media'}],
    })
    expect(toPrivateSelfLabels([])).toBeUndefined()
  })

  it('no labels are written with PRIVATE_LANGS_LABELS off', () => {
    mockLangsLabels = false
    expect(toPrivateSelfLabels(['nudity'])).toBeUndefined()
  })

  it('validates a record with langs and self-labels, and refuses them with the constant off', () => {
    const record = {
      ...base,
      langs: ['en', 'pt-BR'],
      labels: {$type: `${PUB}#selfLabels`, values: [{val: 'porn'}]},
    }
    expect(() => validatePrivateRecord(record)).not.toThrow()
    mockLangsLabels = false
    expect(() => validatePrivateRecord(record)).toThrow(
      'Private post is not valid at langs',
    )
  })

  it('refuses four languages, a wrong label type and eleven labels', () => {
    expect(() =>
      validatePrivateRecord({...base, langs: ['en', 'fr', 'de', 'es']}),
    ).toThrow('Private post is not valid at langs')
    expect(() =>
      validatePrivateRecord({
        ...base,
        labels: {
          $type: 'com.atproto.label.defs#selfLabels',
          values: [{val: 'porn'}],
        },
      }),
    ).toThrow('Private post is not valid at labels')
    expect(() =>
      validatePrivateRecord({
        ...base,
        labels: {
          $type: `${PUB}#selfLabels`,
          values: Array.from({length: 11}, (_, i) => ({val: `l${i}`})),
        },
      }),
    ).toThrow('Private post is not valid at labels.values')
  })

  it('reads langs and self-labels back into the stock record, which still matches', () => {
    const record = toBskyRecord({
      ...base,
      langs: ['en', 'not a tag!'],
      labels: {$type: `${PUB}#selfLabels`, values: [{val: 'sexual'}]},
    })
    expect(record?.langs).toEqual(['en'])
    expect(record?.labels).toEqual({
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{val: 'sexual'}],
    })
    expect(bsky.matches(app.bsky.feed.post, record)).toBe(true)
    expect(privateSelfLabelValues(record)).toEqual([])
  })
})

describe('spoiler features (spoilers design 5.3, 6.1)', () => {
  const SP = 'app.nearhorizon.richtext.facet#spoiler'
  const MK = 'app.nearhorizon.richtext.facet#spoilerMarker'
  const base = {
    $type: 'tools.kryphocron.feed.postPrivate',
    createdAt: '2026-10-15T12:00:00.000Z',
    audienceList: AUDIENCE,
  }
  const written = [
    {
      index: {byteStart: 2, byteEnd: 4},
      features: [{$type: MK}],
    },
    {
      index: {byteStart: 4, byteEnd: 9},
      features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'b'}, {$type: SP}],
    },
    {
      index: {byteStart: 9, byteEnd: 11},
      features: [{$type: MK}, {$type: 'app.example.unknownFeature'}],
    },
  ] as app.bsky.richtext.facet.Main[]

  it('toPrivateFacets keeps spoiler and marker features and drops unknown ones', () => {
    expect(toPrivateFacets(written)).toEqual([
      {
        $type: `${PUB}#facet`,
        index: {byteStart: 2, byteEnd: 4},
        features: [{$type: MK}],
      },
      {
        $type: `${PUB}#facet`,
        index: {byteStart: 4, byteEnd: 9},
        features: [{$type: `${PUB}#tag`, tag: 'b'}, {$type: SP}],
      },
      {
        $type: `${PUB}#facet`,
        index: {byteStart: 9, byteEnd: 11},
        features: [{$type: MK}],
      },
    ])
  })

  it('a record with them validates, and adapts to a post record that keeps them', () => {
    const text = 'a ||#b c|| d'
    const record = validatePrivateRecord({
      ...base,
      text,
      facets: toPrivateFacets([
        {index: {byteStart: 2, byteEnd: 4}, features: [{$type: MK}]},
        {
          index: {byteStart: 4, byteEnd: 6},
          features: [
            {$type: 'app.bsky.richtext.facet#tag', tag: 'b'},
            {$type: SP},
          ],
        },
        {index: {byteStart: 6, byteEnd: 8}, features: [{$type: SP}]},
        {index: {byteStart: 8, byteEnd: 10}, features: [{$type: MK}]},
      ] as app.bsky.richtext.facet.Main[]),
    })
    const adapted = toBskyRecord(record)
    expect(adapted?.facets).toEqual([
      {index: {byteStart: 2, byteEnd: 4}, features: [{$type: MK}]},
      {
        index: {byteStart: 4, byteEnd: 6},
        features: [
          {$type: 'app.bsky.richtext.facet#tag', tag: 'b'},
          {$type: SP},
        ],
      },
      {index: {byteStart: 6, byteEnd: 8}, features: [{$type: SP}]},
      {index: {byteStart: 8, byteEnd: 10}, features: [{$type: MK}]},
    ])
    expect(bsky.matches(app.bsky.feed.post, adapted)).toBe(true)
  })

  it('local detection lays out a keep-mode text without facets, with no mention', () => {
    const text = '@alice.test ||see https://example.com #tag||'
    expect(detectLocalFacets(text)).toEqual([
      {index: {byteStart: 12, byteEnd: 14}, features: [{$type: MK}]},
      {index: {byteStart: 14, byteEnd: 18}, features: [{$type: SP}]},
      {
        index: {byteStart: 18, byteEnd: 37},
        features: [
          {$type: 'app.bsky.richtext.facet#link', uri: 'https://example.com'},
          {$type: SP},
        ],
      },
      {index: {byteStart: 37, byteEnd: 38}, features: [{$type: SP}]},
      {
        index: {byteStart: 38, byteEnd: 42},
        features: [
          {$type: 'app.bsky.richtext.facet#tag', tag: 'tag'},
          {$type: SP},
        ],
      },
      {index: {byteStart: 42, byteEnd: 44}, features: [{$type: MK}]},
    ])
    const adapted = toBskyRecord({...base, text})
    expect(adapted?.facets).toHaveLength(6)
    expect(bsky.matches(app.bsky.feed.post, adapted)).toBe(true)
  })

  it('local detection of a text without markers is as before', () => {
    expect(detectLocalFacets('a || b #tag')).toEqual([
      {
        index: {byteStart: 7, byteEnd: 11},
        features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'tag'}],
      },
    ])
  })
})
