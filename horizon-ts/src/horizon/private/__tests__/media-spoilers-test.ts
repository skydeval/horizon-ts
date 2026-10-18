import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; blob CIDs need the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockContentWarnings = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {CONTENT_WARNINGS: {get: () => mockContentWarnings, enumerable: true}},
  ),
)
jest.mock('#/horizon/private/server-support', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/private/server-support')},
    {
      PRIVATE_LANGS_LABELS: {value: true, enumerable: true},
      PRIVATE_VIDEO: {value: true, enumerable: true},
      PRIVATE_GALLERY: {value: true, enumerable: true},
      PRIVATE_QUOTE_WITH_MEDIA: {value: true, enumerable: true},
      PRIVATE_MEDIA_EXTRAS: {value: true, enumerable: true},
      // A read-time decision: the function stands in for the feature store.
      privateFacetsServed: {value: () => false, enumerable: true},
    },
  ),
)

import {type $Typed, type Client} from '@atproto/lex'
import {RichText} from '@bsky/sdk/richtext'

import {kryphocron} from '#/horizon/lexicons'
import {CW_SELF_LABEL, isFlagged} from '#/horizon/media-spoilers/nsid'
import {resolveContentWarningRT} from '#/horizon/spoilers/content-warning'
import {CONTENT_WARNING_FEATURE, SPOILER_FEATURE} from '#/horizon/spoilers/nsid'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {toBskyRecord, toPrivateEmbed, toPrivateFacets} from '../adapt/record'
import {PrivatePostInvalidError, validatePrivateRecord} from '../api/validate'
import {AUDIENCE, blob, RECORD_CID} from './fixtures'

const PUB = 'tools.kryphocron.feed.postPublic'
const FLAG = 'app.nearhorizon.spoiler'
const ref = {
  uri: 'at://did:plc:a/app.bsky.feed.post/3kquoted22',
  cid: RECORD_CID,
} as const

beforeEach(() => {
  mockContentWarnings = true
})

function record(fields: Record<string, unknown>) {
  return {
    $type: 'tools.kryphocron.feed.postPrivate',
    text: 'post',
    createdAt: '2026-10-18T12:00:00.000Z',
    audienceList: AUDIENCE,
    ...fields,
  }
}

const images = {
  $type: 'app.bsky.embed.images',
  images: [
    {image: blob(), alt: 'one'},
    {image: blob(), alt: 'two', [FLAG]: true},
  ],
} as unknown as $Typed<app.bsky.embed.images.Main>

const gallery = {
  $type: 'app.bsky.embed.gallery',
  items: [
    {
      $type: 'app.bsky.embed.gallery#image',
      image: blob(),
      alt: 'one',
      aspectRatio: {width: 4, height: 3},
      [FLAG]: true,
    },
    {
      $type: 'app.bsky.embed.gallery#image',
      image: blob(),
      alt: 'two',
      aspectRatio: {width: 4, height: 3},
    },
  ],
} as unknown as $Typed<app.bsky.embed.gallery.Main>

const video = {
  $type: 'app.bsky.embed.video',
  video: blob(5_000_000, 'video/mp4'),
  [FLAG]: true,
} as unknown as $Typed<app.bsky.embed.video.Main>

describe('the private adapter keeps the flag (T5)', () => {
  it('images, gallery and video, both ways', () => {
    const pImages = toPrivateEmbed(images) as {images: unknown[]}
    expect(pImages.images.map(isFlagged)).toEqual([false, true])
    const pGallery = toPrivateEmbed(gallery) as {items: unknown[]}
    expect(pGallery.items.map(isFlagged)).toEqual([true, false])
    const pVideo = toPrivateEmbed(video)
    expect(isFlagged(pVideo)).toBe(true)

    const back = (embed: unknown) =>
      toBskyRecord(record({embed}))?.embed as Record<string, unknown>
    expect((back(pImages).images as unknown[]).map(isFlagged)).toEqual([
      false,
      true,
    ])
    expect((back(pGallery).items as unknown[]).map(isFlagged)).toEqual([
      true,
      false,
    ])
    expect(isFlagged(back(pVideo))).toBe(true)
  })

  it('a quote with media keeps the flag on its media', () => {
    const embed = toPrivateEmbed({
      $type: 'app.bsky.embed.recordWithMedia',
      record: {$type: 'app.bsky.embed.record', record: ref},
      media: images,
    } as unknown as $Typed<app.bsky.embed.recordWithMedia.Main>)
    const media = (embed as {media: {images: unknown[]}}).media
    expect(media.images.map(isFlagged)).toEqual([false, true])
    const back = toBskyRecord(record({embed}))?.embed as {
      media: {images: unknown[]}
    }
    expect(back.media.images.map(isFlagged)).toEqual([false, true])
  })

  it('#contentWarning passes through both ways', () => {
    const facets = [
      {
        index: {byteStart: 0, byteEnd: 4},
        features: [{$type: SPOILER_FEATURE}, {$type: CONTENT_WARNING_FEATURE}],
      },
    ] as unknown as app.bsky.richtext.facet.Main[]
    const privateFacets = toPrivateFacets(facets)
    expect(privateFacets?.[0]?.features).toEqual([
      {$type: SPOILER_FEATURE},
      {$type: CONTENT_WARNING_FEATURE},
    ])
    const back = toBskyRecord(record({facets: privateFacets}))
    expect(back?.facets?.[0]?.features).toEqual([
      {$type: SPOILER_FEATURE},
      {$type: CONTENT_WARNING_FEATURE},
    ])
  })

  it('a record with both validates, and adapted matches the post lexicon', () => {
    const valid = validatePrivateRecord(
      record({
        text: 'cw\nbody',
        embed: toPrivateEmbed(images),
        facets: [
          {
            $type: `${PUB}#facet`,
            index: {byteStart: 3, byteEnd: 7},
            features: [
              {$type: SPOILER_FEATURE},
              {$type: CONTENT_WARNING_FEATURE},
            ],
          },
        ],
        labels: {$type: `${PUB}#selfLabels`, values: [{val: CW_SELF_LABEL}]},
      }),
    )
    expect(kryphocron.postPrivate.safeValidate(valid).success).toBe(true)
    const adapted = toBskyRecord(valid)
    expect(bsky.matches(app.bsky.feed.post, adapted)).toBe(true)
    expect(adapted?.labels).toEqual({
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{val: CW_SELF_LABEL}],
    })
  })
})

describe('validatePrivateRecord (T5)', () => {
  function withFlag(value: unknown) {
    return record({
      embed: {
        $type: `${PUB}#embedImage`,
        images: [{image: blob(), alt: '', [FLAG]: value}],
      },
    })
  }

  it('rejects a flag that is not true', () => {
    for (const value of [false, 'true', 1, {}]) {
      expect(() => validatePrivateRecord(withFlag(value))).toThrow(
        PrivatePostInvalidError,
      )
    }
    expect(() => validatePrivateRecord(withFlag(false))).toThrow(
      `embed.images[0].${FLAG}`,
    )
    expect(() => validatePrivateRecord(withFlag(true))).not.toThrow()
  })

  it('rejects a flag that is not true on a video', () => {
    expect(() =>
      validatePrivateRecord(
        record({
          embed: {
            $type: `${PUB}#embedVideo`,
            video: blob(5_000_000, 'video/mp4'),
            [FLAG]: 'yes',
          },
        }),
      ),
    ).toThrow(`embed.${FLAG}`)
  })

  it('rejects #contentWarning without #spoiler', () => {
    expect(() =>
      validatePrivateRecord(
        record({
          facets: [
            {
              $type: `${PUB}#facet`,
              index: {byteStart: 0, byteEnd: 4},
              features: [{$type: CONTENT_WARNING_FEATURE}],
            },
          ],
        }),
      ),
    ).toThrow('content warning without a spoiler')
  })
})

describe('toBskyRecord of a keep-mode CW without facets (T5)', () => {
  const appview = {
    resolve: () => Promise.resolve(undefined),
  } as unknown as Client
  const labels = {
    $type: `${PUB}#selfLabels`,
    values: [{val: CW_SELF_LABEL}],
  }

  async function keepText(body: string, line: string) {
    return (
      await resolveContentWarningRT(
        appview,
        new RichText({text: body}),
        line,
        'keep',
      )
    ).text
  }

  function hiddenRanges(facets: app.bsky.richtext.facet.Main[] | undefined) {
    return (facets ?? [])
      .filter(f =>
        f.features.some(x => (x as {$type?: string}).$type === SPOILER_FEATURE),
      )
      .map(f => ({
        range: [f.index.byteStart, f.index.byteEnd],
        cw: f.features.some(
          x => (x as {$type?: string}).$type === CONTENT_WARNING_FEATURE,
        ),
      }))
  }

  it('C3: "he dies" is inside the CW span, with #contentWarning', async () => {
    const text = await keepText('the end: ||he dies||', '')
    const adapted = toBskyRecord(record({text, labels}))
    expect(hiddenRanges(adapted?.facets)).toEqual([
      {range: [2, 11], cw: true},
      {range: [13, 20], cw: true},
    ])
  })

  it('C3 in the earlier shape (markers on their own lines) reads the same', () => {
    const text = '||\nthe end: ||he dies||\n||'
    const adapted = toBskyRecord(record({text, labels}))
    expect(hiddenRanges(adapted?.facets)).toEqual([
      {range: [3, 12], cw: true},
      {range: [14, 21], cw: true},
    ])
  })

  it('without the label, the existing local detection pairs the markers', async () => {
    const text = await keepText('the end: ||he dies||', '')
    const adapted = toBskyRecord(record({text}))
    const ranges = hiddenRanges(adapted?.facets)
    expect(ranges.length).toBeGreaterThan(0)
    expect(ranges.every(r => !r.cw)).toBe(true)
  })

  it('with content warnings off the body still gets the structural facets', async () => {
    mockContentWarnings = false
    const text = await keepText('it was a lot', 'a || b')
    const adapted = toBskyRecord(record({text, labels}))
    expect(hiddenRanges(adapted?.facets)).toEqual([{range: [9, 21], cw: true}])
  })
})
