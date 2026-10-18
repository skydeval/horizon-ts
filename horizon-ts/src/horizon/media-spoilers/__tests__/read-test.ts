import {beforeEach, describe, expect, it, jest} from '@jest/globals'

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

import {type app} from '#/lexicons'
import {CW_SELF_LABEL, MEDIA_SPOILER_FIELD} from '../nsid'
import {
  hasMediaSpoilers,
  MEDIA_SPOILER_BLUR_RADIUS,
  mediaSpoilerCardBlur,
  mediaSpoilerState,
  type MediaView,
  recordHasMediaSpoilers,
} from '../read'

beforeEach(() => {
  mockMediaSpoilers = true
  mockContentWarnings = true
})

const F = MEDIA_SPOILER_FIELD

function recordImage(flag?: unknown) {
  return {
    image: {
      $type: 'blob',
      ref: {$link: 'bafk'},
      mimeType: 'image/jpeg',
      size: 1,
    },
    alt: '',
    ...(flag === undefined ? {} : {[F]: flag}),
  }
}

function imagesRecord(flags: unknown[], extra: object = {}) {
  return {
    $type: 'app.bsky.feed.post',
    text: '',
    createdAt: '2026-10-18T12:00:00.000Z',
    embed: {$type: 'app.bsky.embed.images', images: flags.map(recordImage)},
    ...extra,
  }
}

function imagesView(count: number): MediaView {
  return {
    $type: 'app.bsky.embed.images#view',
    images: Array.from({length: count}, (_, i) => ({
      thumb: `https://cdn/thumb/${i}`,
      fullsize: `https://cdn/full/${i}`,
      alt: '',
    })),
  }
}

function galleryView(types: string[]): MediaView {
  return {
    $type: 'app.bsky.embed.gallery#view',
    items: types.map((type, i) => ({
      $type: type,
      thumbnail: `https://cdn/thumb/${i}`,
      fullsize: `https://cdn/full/${i}`,
      alt: '',
    })),
  } as unknown as MediaView
}

function videoView(): MediaView {
  return {
    $type: 'app.bsky.embed.video#view',
    cid: 'bafk',
    playlist: 'https://video/playlist.m3u8',
    thumbnail: 'https://video/thumb.jpg',
  }
}

const CW_LABELS = {
  labels: {
    $type: 'com.atproto.label.defs#selfLabels',
    values: [{val: CW_SELF_LABEL}],
  },
}

describe('mediaSpoilerState (T1)', () => {
  it('pairs images by index', () => {
    const state = mediaSpoilerState(
      imagesRecord([undefined, true, undefined]),
      imagesView(3),
    )
    expect(state).toEqual({flags: [false, true, false], contentWarning: false})
  })

  it('reads images inside a quote with media', () => {
    const record = {
      $type: 'app.bsky.feed.post',
      embed: {
        $type: 'app.bsky.embed.recordWithMedia',
        record: {
          $type: 'app.bsky.embed.record',
          record: {uri: 'at://x', cid: 'c'},
        },
        media: {
          $type: 'app.bsky.embed.images',
          images: [recordImage(), recordImage(true)],
        },
      },
    }
    expect(mediaSpoilerState(record, imagesView(2)).flags).toEqual([
      false,
      true,
    ])
  })

  it('only the JSON value true flags', () => {
    const state = mediaSpoilerState(
      imagesRecord(['true', 1, {}, false]),
      imagesView(4),
    )
    expect(state.flags).toEqual([false, false, false, false])
  })

  it('pairs a gallery on the unfiltered list, then filters as the cells do', () => {
    const record = {
      embed: {
        $type: 'app.bsky.embed.gallery',
        items: [
          {$type: 'app.bsky.embed.gallery#image'},
          {$type: 'app.bsky.embed.gallery#other', [F]: true},
          {$type: 'app.bsky.embed.gallery#image', [F]: true},
        ],
      },
    }
    const view = galleryView([
      'app.bsky.embed.gallery#viewImage',
      'app.bsky.embed.gallery#viewOther',
      'app.bsky.embed.gallery#viewImage',
    ])
    expect(mediaSpoilerState(record, view).flags).toEqual([false, true])
  })

  it('reads a video, top level and inside a quote with media', () => {
    const top = {embed: {$type: 'app.bsky.embed.video', [F]: true}}
    expect(mediaSpoilerState(top, videoView()).flags).toEqual([true])
    const quote = {
      embed: {
        $type: 'app.bsky.embed.recordWithMedia',
        media: {$type: 'app.bsky.embed.video', [F]: true},
      },
    }
    expect(mediaSpoilerState(quote, videoView()).flags).toEqual([true])
    const unflagged = {embed: {$type: 'app.bsky.embed.video'}}
    expect(mediaSpoilerState(unflagged, videoView()).flags).toEqual([false])
  })

  it('fails closed when the counts differ', () => {
    expect(
      mediaSpoilerState(imagesRecord([undefined, true]), imagesView(3)).flags,
    ).toEqual([true, true, true])
    expect(
      mediaSpoilerState(imagesRecord([undefined, undefined]), imagesView(3))
        .flags,
    ).toEqual([false, false, false])
  })

  it('fails closed when the kinds differ', () => {
    const record = {embed: {$type: 'app.bsky.embed.video', [F]: true}}
    expect(mediaSpoilerState(record, imagesView(2)).flags).toEqual([true, true])
  })

  it('covers every item of a CW post, with the CW wording', () => {
    const state = mediaSpoilerState(
      imagesRecord([undefined, undefined], CW_LABELS),
      imagesView(2),
    )
    expect(state).toEqual({flags: [true, true], contentWarning: true})
  })

  it('a label value cw that is not namespaced is no CW', () => {
    const record = imagesRecord([undefined], {
      labels: {
        $type: 'com.atproto.label.defs#selfLabels',
        values: [{val: 'cw'}],
      },
    })
    expect(mediaSpoilerState(record, imagesView(1))).toEqual({
      flags: [false],
      contentWarning: false,
    })
  })

  it('flags nothing without a record', () => {
    expect(mediaSpoilerState(undefined, imagesView(2)).flags).toEqual([
      false,
      false,
    ])
  })

  it('with MEDIA_SPOILERS off flags nothing', () => {
    mockMediaSpoilers = false
    expect(
      mediaSpoilerState(imagesRecord([true], CW_LABELS), imagesView(1)),
    ).toEqual({flags: [false], contentWarning: false})
  })

  it('with CONTENT_WARNINGS off a CW post keeps only its own flags', () => {
    mockContentWarnings = false
    expect(
      mediaSpoilerState(
        imagesRecord([true, undefined], CW_LABELS),
        imagesView(2),
      ),
    ).toEqual({flags: [true, false], contentWarning: false})
  })
})

describe('hasMediaSpoilers (T1)', () => {
  const imagesEmbed = imagesView(1) as app.bsky.feed.defs.PostView['embed']

  it('is true for a flagged item', () => {
    expect(hasMediaSpoilers({record: imagesRecord([undefined, true])})).toBe(
      true,
    )
    expect(recordHasMediaSpoilers(imagesRecord([undefined]))).toBe(false)
  })

  it('is true for a CW post with media, by its record or its view', () => {
    expect(
      hasMediaSpoilers({record: imagesRecord([undefined], CW_LABELS)}),
    ).toBe(true)
    expect(
      hasMediaSpoilers({record: {text: 'x', ...CW_LABELS}, embed: imagesEmbed}),
    ).toBe(true)
  })

  it('is false for a CW post without media', () => {
    expect(hasMediaSpoilers({record: {text: 'x', ...CW_LABELS}})).toBe(false)
  })

  it('reads the CW only while content warnings are on', () => {
    mockContentWarnings = false
    expect(
      hasMediaSpoilers({record: imagesRecord([undefined], CW_LABELS)}),
    ).toBe(false)
    expect(hasMediaSpoilers({record: imagesRecord([true], CW_LABELS)})).toBe(
      true,
    )
  })

  it('is false with MEDIA_SPOILERS off', () => {
    mockMediaSpoilers = false
    expect(hasMediaSpoilers({record: imagesRecord([true])})).toBe(false)
    expect(mediaSpoilerCardBlur({record: imagesRecord([true])})).toBe(0)
  })

  it('gives the card blur', () => {
    expect(mediaSpoilerCardBlur({record: imagesRecord([true])})).toBe(
      MEDIA_SPOILER_BLUR_RADIUS,
    )
    expect(mediaSpoilerCardBlur({record: imagesRecord([undefined])})).toBe(0)
  })
})
