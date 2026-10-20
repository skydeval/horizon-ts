import {describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; blob CIDs need the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockReading = true

jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {PRIVATE_READING: {get: () => mockReading, enumerable: true}},
  ),
)

import {
  attachDirectSource,
  directSourceUrl,
  isHlsPlaylist,
  playsAsDirectSource,
  POSTER_FRAME_FRAGMENT,
  videoPreload,
} from '#/horizon/video/playback'
import {HORIZON_VIDEO_SERVICE, videoPlaylistUrl} from '#/horizon/video/service'
import {type app} from '#/lexicons'
import {
  blobCid,
  embedViewFromRecord,
  recordQuoteUri,
  recordUsesPdsBlobs,
} from '../adapt/embed-view'
import {blob, BLOB_CID, DID, RECORD_CID} from './fixtures'

const PUB = 'tools.kryphocron.feed.postPublic'
const PDS = 'https://pds.example/'
const PUBLIC_QUOTE = `at://${DID}/app.bsky.feed.post/3kquoted2222`
const PRIVATE_QUOTE = `at://${DID}/tools.kryphocron.feed.postPrivate/3kquoted2222`
const BLOB_URL = `https://pds.example/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=${BLOB_CID}`

function record(embed: unknown) {
  return {
    $type: 'tools.kryphocron.feed.postPrivate',
    text: '',
    createdAt: '2026-10-15T12:00:00.000Z',
    embed,
  }
}

const ctx = {authorDid: DID, pdsUrl: PDS}

describe('embedViewFromRecord (6.1.3)', () => {
  it('images: getBlob URLs on the author’s PDS, alt and aspect ratio', () => {
    const view = embedViewFromRecord(
      record({
        $type: `${PUB}#embedImage`,
        images: [
          {image: blob(), alt: 'a cat', aspectRatio: {width: 4, height: 3}},
        ],
      }),
      ctx,
    )
    expect(view).toEqual({
      $type: 'app.bsky.embed.images#view',
      images: [
        {
          thumb: BLOB_URL,
          fullsize: BLOB_URL,
          alt: 'a cat',
          aspectRatio: {width: 4, height: 3},
        },
      ],
    })
  })

  it('images and gallery items are omitted without a PDS URL', () => {
    const images = record({
      $type: `${PUB}#embedImage`,
      images: [{image: blob(), alt: ''}],
    })
    const gallery = record({
      $type: `${PUB}#embedGallery`,
      items: [
        {
          $type: `${PUB}#galleryImage`,
          image: blob(),
          alt: '',
          aspectRatio: {width: 1, height: 1},
        },
      ],
    })
    expect(embedViewFromRecord(images, {authorDid: DID})).toBeUndefined()
    expect(embedViewFromRecord(gallery, {authorDid: DID})).toBeUndefined()
    expect(recordUsesPdsBlobs(images)).toBe(true)
    expect(recordUsesPdsBlobs(gallery)).toBe(true)
  })

  it('a gallery becomes app.bsky.embed.gallery#view', () => {
    const view = embedViewFromRecord(
      record({
        $type: `${PUB}#embedGallery`,
        items: Array.from({length: 5}, () => ({
          $type: `${PUB}#galleryImage`,
          image: blob(),
          alt: 'x',
          aspectRatio: {width: 2, height: 1},
        })),
      }),
      ctx,
    ) as app.bsky.embed.gallery.View
    expect(view.$type).toBe('app.bsky.embed.gallery#view')
    expect(view.items).toHaveLength(5)
    expect(view.items[0]).toEqual({
      $type: 'app.bsky.embed.gallery#viewImage',
      thumbnail: BLOB_URL,
      fullsize: BLOB_URL,
      alt: 'x',
      aspectRatio: {width: 2, height: 1},
    })
  })

  it('a link card as written, its thumbnail from the PDS', () => {
    expect(
      embedViewFromRecord(
        record({
          $type: `${PUB}#embedExternal`,
          external: {
            uri: 'https://example.com',
            title: 'Example',
            description: 'An example',
            thumb: blob(),
          },
        }),
        ctx,
      ),
    ).toEqual({
      $type: 'app.bsky.embed.external#view',
      external: {
        uri: 'https://example.com',
        title: 'Example',
        description: 'An example',
        thumb: BLOB_URL,
      },
    })
  })

  it('a video plays its MP4 blob from the author’s PDS, with no thumbnail', () => {
    const view = embedViewFromRecord(
      record({
        $type: `${PUB}#embedVideo`,
        video: blob(5_000_000, 'video/mp4'),
        alt: 'clip',
        aspectRatio: {width: 16, height: 9},
        presentation: 'gif',
      }),
      ctx,
    )
    expect(view).toEqual({
      $type: 'app.bsky.embed.video#view',
      cid: BLOB_CID,
      playlist: BLOB_URL,
      alt: 'clip',
      aspectRatio: {width: 16, height: 9},
      presentation: 'gif',
    })
    expect(JSON.stringify(view)).not.toContain('video.bsky.app')
  })

  it('a video has no view without the author’s PDS, alone or as media', () => {
    const video = record({
      $type: `${PUB}#embedVideo`,
      video: blob(10, 'video/mp4'),
    })
    expect(embedViewFromRecord(video, {authorDid: DID})).toBeUndefined()
    expect(recordUsesPdsBlobs(video)).toBe(true)
    const withMedia = record({
      $type: `${PUB}#embedRecordWithMedia`,
      record: {record: {uri: PRIVATE_QUOTE, cid: RECORD_CID}},
      media: {$type: `${PUB}#embedVideo`, video: blob(10, 'video/mp4')},
    })
    expect(recordUsesPdsBlobs(withMedia)).toBe(true)
    const view = embedViewFromRecord(withMedia, {authorDid: DID})
    expect(view?.$type).toBe('app.bsky.embed.record#view')
    expect(JSON.stringify(view)).not.toContain('video.bsky.app')
  })

  it('a quote: a private one as not found (the private quote resolves it), a public one from the fetched views', () => {
    const quoteView = {
      uri: PUBLIC_QUOTE,
      cid: RECORD_CID,
      author: {did: DID, handle: 'alice.test'},
      record: {$type: 'app.bsky.feed.post', text: 'q', createdAt: ''},
      indexedAt: '2026-10-15T12:00:00.000Z',
    } as unknown as app.bsky.feed.defs.PostView
    const quoteViews = new Map([[PUBLIC_QUOTE, quoteView]])
    const privateQuote = embedViewFromRecord(
      record({
        $type: `${PUB}#embedRecord`,
        record: {uri: PRIVATE_QUOTE, cid: RECORD_CID},
      }),
      {...ctx, quoteViews},
    )
    expect(privateQuote).toEqual({
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewNotFound',
        uri: PRIVATE_QUOTE,
        notFound: true,
      },
    })
    const publicQuote = embedViewFromRecord(
      record({
        $type: `${PUB}#embedRecord`,
        record: {uri: PUBLIC_QUOTE, cid: RECORD_CID},
      }),
      {...ctx, quoteViews},
    ) as app.bsky.embed.record.View
    expect(publicQuote.record).toMatchObject({
      $type: 'app.bsky.embed.record#viewRecord',
      uri: PUBLIC_QUOTE,
      value: quoteView.record,
    })
    const missing = embedViewFromRecord(
      record({
        $type: `${PUB}#embedRecord`,
        record: {uri: PUBLIC_QUOTE, cid: RECORD_CID},
      }),
      ctx,
    ) as app.bsky.embed.record.View
    expect(missing.record.$type).toBe('app.bsky.embed.record#viewNotFound')
  })

  it('a quote with media from its two parts', () => {
    const embed = {
      $type: `${PUB}#embedRecordWithMedia`,
      record: {record: {uri: PRIVATE_QUOTE, cid: RECORD_CID}},
      media: {$type: `${PUB}#embedVideo`, video: blob(10, 'video/mp4')},
    }
    const view = embedViewFromRecord(
      record(embed),
      ctx,
    ) as app.bsky.embed.recordWithMedia.View
    expect(view.$type).toBe('app.bsky.embed.recordWithMedia#view')
    expect(view.record.record.$type).toBe('app.bsky.embed.record#viewNotFound')
    expect(view.media.$type).toBe('app.bsky.embed.video#view')
    expect((view.media as app.bsky.embed.video.View).playlist).toBe(BLOB_URL)
    expect((view.media as app.bsky.embed.video.View).thumbnail).toBeUndefined()
    expect(recordQuoteUri(record(embed))).toBe(PRIVATE_QUOTE)
  })

  it('reads blob CIDs as lex values, as JSON and as legacy blobs; nothing for junk', () => {
    expect(blobCid(blob())).toBe(BLOB_CID)
    expect(blobCid({$type: 'blob', ref: {$link: BLOB_CID}})).toBe(BLOB_CID)
    expect(blobCid({cid: BLOB_CID, mimeType: 'image/jpeg'})).toBe(BLOB_CID)
    expect(blobCid('nope')).toBeUndefined()
    expect(
      embedViewFromRecord(record({$type: `${PUB}#embedVideo`}), ctx),
    ).toBeUndefined()
    expect(embedViewFromRecord({text: 'no embed'}, ctx)).toBeUndefined()
  })
})

describe('the video service and web playback', () => {
  it('the service DID and URL live in one constant', () => {
    expect(HORIZON_VIDEO_SERVICE).toEqual({
      did: 'did:web:video.bsky.app',
      url: 'https://video.bsky.app',
    })
    expect(videoPlaylistUrl('did:plc:x', 'bafy')).toBe(
      'https://video.bsky.app/watch/did%3Aplc%3Ax/bafy/playlist.m3u8',
    )
  })

  it('a playlist whose path does not end in .m3u8 plays as a direct source', () => {
    const hls = 'https://video.bsky.app/watch/did/cid/playlist.m3u8'
    const hlsWithQuery = 'https://cdn.example/v/playlist.M3U8?token=1'
    const mp4 = `https://pds.example/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${BLOB_CID}`
    expect(isHlsPlaylist(hls)).toBe(true)
    expect(isHlsPlaylist(hlsWithQuery)).toBe(true)
    expect(isHlsPlaylist(mp4)).toBe(false)
    expect(isHlsPlaylist('not a url')).toBe(true)
    expect(playsAsDirectSource(hls)).toBe(false)
    expect(playsAsDirectSource(mp4)).toBe(true)
    mockReading = false
    expect(playsAsDirectSource(mp4)).toBe(false)
    mockReading = true
  })

  it('attachDirectSource sets the source and its cleanup removes it', () => {
    const removed: string[] = []
    let loads = 0
    const video = {
      src: '',
      removeAttribute: (name: string) => {
        removed.push(name)
      },
      load: () => {
        loads++
      },
    }
    const cleanup = attachDirectSource(video, 'https://pds.example/blob')
    expect(video.src).toBe('https://pds.example/blob')
    cleanup()
    expect(removed).toEqual(['src'])
    expect(loads).toBe(1)
  })

  it('a direct source without a thumbnail preloads metadata and seeks into its first frame', () => {
    const mp4 = `https://pds.example/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${BLOB_CID}`
    const hls = 'https://video.bsky.app/watch/did/cid/playlist.m3u8'
    expect(directSourceUrl(mp4)).toBe(mp4 + POSTER_FRAME_FRAGMENT)
    expect(POSTER_FRAME_FRAGMENT).toBe('#t=0.1')
    expect(directSourceUrl(`${mp4}#t=3`)).toBe(`${mp4}#t=3`)
    expect(videoPreload({playlist: mp4})).toBe('metadata')
    expect(videoPreload({playlist: mp4, thumbnail: 'https://x/t.jpg'})).toBe(
      'none',
    )
    expect(videoPreload({playlist: hls})).toBe('none')
    mockReading = false
    expect(videoPreload({playlist: mp4})).toBe('none')
    mockReading = true
  })

  it('a direct source that fails to load reports whether it was not found, until cleaned up', () => {
    const listeners = new Set<() => void>()
    const video = {
      src: '',
      error: null as {code: number} | null,
      removeAttribute: () => {},
      load: () => {},
      addEventListener: (_type: 'error', listener: () => void) => {
        listeners.add(listener)
      },
      removeEventListener: (_type: 'error', listener: () => void) => {
        listeners.delete(listener)
      },
    }
    const reports: boolean[] = []
    const cleanup = attachDirectSource(video, 'https://pds.example/blob', nf =>
      reports.push(nf),
    )
    video.error = {code: 4}
    listeners.forEach(listener => listener())
    video.error = {code: 2}
    listeners.forEach(listener => listener())
    expect(reports).toEqual([true, false])
    cleanup()
    expect(listeners.size).toBe(0)
  })
})
