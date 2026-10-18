import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; `computeCid` needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMediaSpoilers = true
let mockContentWarnings = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {
      MEDIA_SPOILERS: {get: () => mockMediaSpoilers, enumerable: true},
      CONTENT_WARNINGS: {get: () => mockContentWarnings, enumerable: true},
    },
  ),
)
let mockFlagKept = true
let mockLabelKept = true
jest.mock('#/horizon/media-spoilers/nsid', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/media-spoilers/nsid')},
    {
      PUBLIC_MEDIA_FLAG_KEPT: {get: () => mockFlagKept, enumerable: true},
      PUBLIC_CW_LABEL_KEPT: {get: () => mockLabelKept, enumerable: true},
    },
  ),
)
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))

import {type $Typed, type Client} from '@atproto/lex'
import {RichText} from '@bsky/sdk/richtext'

import {computeCid} from '#/lib/api/computeCid'
import {type PostDraft} from '#/view/com/composer/state/composer'
import {blob} from '#/horizon/private/__tests__/fixtures'
import {toPrivateSelfLabels} from '#/horizon/private/adapt/record'
import {type app} from '#/lexicons'
import {type ComposeSpoilers, EMPTY_COMPOSE_SPOILERS} from '../compose-store'
import {CW_SELF_LABEL, isFlagged, MEDIA_SPOILER_FIELD} from '../nsid'
import {
  contentWarningLabelValues,
  resolveComposeRT,
  withContentWarningLabel,
  withMediaSpoilers,
} from '../write'

beforeEach(() => {
  mockMediaSpoilers = true
  mockContentWarnings = true
  mockFlagKept = true
  mockLabelKept = true
})

function image(id: string) {
  return {alt: '', source: {id, path: `file:///${id}`, width: 4, height: 3}}
}

type Media = PostDraft['embed']['media']

function draft(media: Media, id = 'p1', labels: string[] = []): PostDraft {
  return {
    id,
    richtext: new RichText({text: 'body'}),
    labels,
    embed: {quote: undefined, link: undefined, media},
    shortenedGraphemeLength: 4,
  } as unknown as PostDraft
}

function snap(over: Partial<ComposeSpoilers> = {}): ComposeSpoilers {
  return {...EMPTY_COMPOSE_SPOILERS, ...over}
}

function imagesEmbed(count: number) {
  return {
    $type: 'app.bsky.embed.images',
    images: Array.from({length: count}, (_, i) => ({
      image: blob(),
      alt: `image ${i}`,
      aspectRatio: {width: 4, height: 3},
    })),
  } as unknown as $Typed<app.bsky.embed.images.Main>
}

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

const videoEmbed = {
  $type: 'app.bsky.embed.video',
  video: blob(5_000_000, 'video/mp4'),
} as unknown as $Typed<app.bsky.embed.video.Main>

const quoteRef = {
  $type: 'app.bsky.embed.record',
  record: {
    uri: 'at://did:plc:a/app.bsky.feed.post/3kq',
    cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
  },
} as const

const three = [image('a'), image('b'), image('c')]

describe('withMediaSpoilers (T2)', () => {
  it('flags the flagged image of three, by index', () => {
    const embed = imagesEmbed(3)
    const out = withMediaSpoilers(
      embed,
      draft({type: 'images', images: three} as Media),
      snap({images: new Set(['b'])}),
    ) as typeof embed
    expect(out.images.map(isFlagged)).toEqual([false, true, false])
    expect(out.images[1]).toEqual({
      ...embed.images[1],
      [MEDIA_SPOILER_FIELD]: true,
    })
  })

  it('flags gallery items', () => {
    const embed = galleryEmbed(3)
    const out = withMediaSpoilers(
      embed,
      draft({type: 'gallery', images: three} as Media),
      snap({images: new Set(['c'])}),
    ) as typeof embed
    expect(out.items.map(isFlagged)).toEqual([false, false, true])
    expect(out.items[2]).toMatchObject({$type: 'app.bsky.embed.gallery#image'})
  })

  it('flags a video by its controller', () => {
    const controller = new AbortController()
    const media = {type: 'video', video: {abortController: controller}}
    const out = withMediaSpoilers(
      videoEmbed,
      draft(media as Media),
      snap({videos: new Set([controller])}),
    )
    expect(isFlagged(out)).toBe(true)
    const other = withMediaSpoilers(
      videoEmbed,
      draft({
        type: 'video',
        video: {abortController: new AbortController()},
      } as Media),
      snap({videos: new Set([controller])}),
    )
    expect(other).toBe(videoEmbed)
  })

  it('flags the media of a quote with media, not the quote', () => {
    const embed = {
      $type: 'app.bsky.embed.recordWithMedia',
      record: quoteRef,
      media: imagesEmbed(2),
    } as unknown as $Typed<app.bsky.embed.recordWithMedia.Main>
    const out = withMediaSpoilers(
      embed,
      draft({type: 'images', images: three.slice(0, 2)} as Media),
      snap({images: new Set(['a'])}),
    ) as typeof embed
    const media = out.media as $Typed<app.bsky.embed.images.Main>
    expect(media.images.map(isFlagged)).toEqual([true, false])
    expect(out.record).toBe(embed.record)
    expect(isFlagged(out.record)).toBe(false)
  })

  it('a content warning flags every image and the video', () => {
    const cw = snap({cw: new Map([['p1', {line: ''}]])})
    const embed = imagesEmbed(3)
    const out = withMediaSpoilers(
      embed,
      draft({type: 'images', images: three} as Media),
      cw,
    ) as typeof embed
    expect(out.images.map(isFlagged)).toEqual([true, true, true])
    const video = withMediaSpoilers(
      videoEmbed,
      draft({
        type: 'video',
        video: {abortController: new AbortController()},
      } as Media),
      cw,
    )
    expect(isFlagged(video)).toBe(true)
  })

  it('another post s content warning flags nothing', () => {
    const embed = imagesEmbed(1)
    const out = withMediaSpoilers(
      embed,
      draft({type: 'images', images: [image('a')]} as Media),
      snap({cw: new Map([['p2', {line: ''}]])}),
    )
    expect(out).toBe(embed)
  })

  it('returns the same object with nothing flagged, and for other embeds', () => {
    const embed = imagesEmbed(2)
    expect(
      withMediaSpoilers(
        embed,
        draft({type: 'images', images: three.slice(0, 2)} as Media),
        snap(),
      ),
    ).toBe(embed)
    const cw = snap({cw: new Map([['p1', {line: ''}]])})
    expect(withMediaSpoilers(quoteRef, draft(undefined), cw)).toBe(quoteRef)
    const external = {
      $type: 'app.bsky.embed.external',
      external: {uri: 'https://example.com', title: '', description: ''},
    } as const
    expect(withMediaSpoilers(external, draft(undefined), cw)).toBe(external)
    expect(withMediaSpoilers(undefined, draft(undefined), cw)).toBeUndefined()
  })

  it('a count mismatch flags every item when any draft image is flagged', () => {
    const embed = imagesEmbed(2)
    const out = withMediaSpoilers(
      embed,
      draft({type: 'images', images: three} as Media),
      snap({images: new Set(['c'])}),
    ) as typeof embed
    expect(out.images.map(isFlagged)).toEqual([true, true])
    expect(
      withMediaSpoilers(
        embed,
        draft({type: 'images', images: three} as Media),
        snap(),
      ),
    ).toBe(embed)
  })

  it('does not mutate its input', () => {
    const embed = imagesEmbed(2)
    const before = JSON.stringify(embed)
    withMediaSpoilers(
      embed,
      draft({type: 'images', images: three.slice(0, 2)} as Media),
      snap({images: new Set(['a', 'b'])}),
    )
    expect(JSON.stringify(embed)).toBe(before)
  })

  it('flags nothing with media spoilers off, a content warning included', () => {
    mockMediaSpoilers = false
    const embed = imagesEmbed(2)
    expect(
      withMediaSpoilers(
        embed,
        draft({type: 'images', images: three.slice(0, 2)} as Media),
        snap({images: new Set(['a']), cw: new Map([['p1', {line: ''}]])}),
      ),
    ).toBe(embed)
  })

  it('a record with a flag has a stable CID', async () => {
    const embed = withMediaSpoilers(
      imagesEmbed(1),
      draft({type: 'images', images: [image('a')]} as Media),
      snap({images: new Set(['a'])}),
    )
    const record = {
      $type: 'app.bsky.feed.post',
      text: 'x',
      createdAt: '2026-10-18T12:00:00.000Z',
      embed,
    } as app.bsky.feed.post.Main
    const first = await computeCid(record)
    expect(await computeCid(structuredClone(record))).toBe(first)
    const plain = {...record, embed: imagesEmbed(1)}
    expect(await computeCid(plain)).not.toBe(first)
  })
})

describe('withContentWarningLabel and contentWarningLabelValues (T4)', () => {
  const cw = snap({cw: new Map([['p1', {line: 'cw'}]])})

  it('adds the label once and keeps existing values', () => {
    const labels = {
      $type: 'com.atproto.label.defs#selfLabels' as const,
      values: [{val: 'graphic-media'}],
    }
    const out = withContentWarningLabel(labels, draft(undefined), cw)
    expect(out?.values).toEqual([{val: 'graphic-media'}, {val: CW_SELF_LABEL}])
    expect(withContentWarningLabel(out, draft(undefined), cw)).toBe(out)
    expect(withContentWarningLabel(undefined, draft(undefined), cw)).toEqual({
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{val: CW_SELF_LABEL}],
    })
  })

  it('leaves labels alone without a content warning or with the switch off', () => {
    expect(
      withContentWarningLabel(undefined, draft(undefined), snap()),
    ).toBeUndefined()
    expect(
      withContentWarningLabel(undefined, draft(undefined, 'p2'), cw),
    ).toBeUndefined()
    mockContentWarnings = false
    expect(
      withContentWarningLabel(undefined, draft(undefined), cw),
    ).toBeUndefined()
  })

  it('B-MS2: no label on a public post while the label is not kept', () => {
    mockLabelKept = false
    expect(
      withContentWarningLabel(undefined, draft(undefined), cw),
    ).toBeUndefined()
    expect(contentWarningLabelValues(draft(undefined), cw)).toEqual([
      CW_SELF_LABEL,
    ])
  })

  it('B-MS1: a flagged item labels a public post while the flag is not kept', () => {
    const flagged = snap({images: new Set(['a'])})
    const d = draft({type: 'images', images: [image('a')]} as Media)
    expect(withContentWarningLabel(undefined, d, flagged)).toBeUndefined()
    mockFlagKept = false
    expect(withContentWarningLabel(undefined, d, flagged)?.values).toEqual([
      {val: CW_SELF_LABEL},
    ])
  })

  it('private: the draft labels plus the CW label, into #selfLabels', () => {
    const values = contentWarningLabelValues(
      draft(undefined, 'p1', ['graphic-media']),
      cw,
    )
    expect(values).toEqual(['graphic-media', CW_SELF_LABEL])
    expect(toPrivateSelfLabels(values)).toEqual({
      $type: 'tools.kryphocron.feed.postPublic#selfLabels',
      values: [{val: 'graphic-media'}, {val: CW_SELF_LABEL}],
    })
    expect(contentWarningLabelValues(draft(undefined), snap())).toEqual([])
  })
})

describe('resolveComposeRT', () => {
  const appview = {
    resolve: () => Promise.resolve(undefined),
  } as unknown as Client

  it('gives the CW text for a post with a content warning only', async () => {
    const cw = snap({cw: new Map([['p1', {line: 'cw'}]])})
    const rt = await resolveComposeRT(appview, draft(undefined), cw, 'strip')
    expect(rt?.text).toBe('cw\nbody')
    const keep = await resolveComposeRT(appview, draft(undefined), cw, 'keep')
    expect(keep?.text).toBe('cw\n||body||')
    expect(resolveComposeRT(appview, draft(undefined, 'p2'), cw, 'keep')).toBe(
      undefined,
    )
    mockContentWarnings = false
    expect(resolveComposeRT(appview, draft(undefined), cw, 'keep')).toBe(
      undefined,
    )
  })
})
