import {describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {type app} from '#/lexicons'
import {withRecordPresentation} from '../adapt/embed-view'
import {adaptPosts} from '../adapt/feed-view'
import {blob, BLOB_CID, OTHER_DID, privateUri} from './fixtures'
import {fakeAppview, privateView} from './read-fixtures'

const PP = 'tools.kryphocron.feed.postPrivate'
const POST_PUBLIC = 'tools.kryphocron.feed.postPublic'

/** prism's video view: no `presentation` (its private video reply). */
const servedVideo = {
  $type: 'app.bsky.embed.video#view',
  cid: BLOB_CID,
  playlist: `https://video.bsky.app/watch/x/${BLOB_CID}/playlist.m3u8`,
  thumbnail: `https://video.bsky.app/watch/x/${BLOB_CID}/thumbnail.jpg`,
} as const

function videoEmbed(type: string, presentation?: string) {
  return {
    $type: type,
    video: blob(1000, 'video/mp4'),
    ...(presentation ? {presentation} : {}),
  }
}

type EmbedView = NonNullable<app.bsky.feed.defs.PostView['embed']>

describe("a served video view takes the record's presentation", () => {
  it('at the top level, from either embed type', () => {
    for (const type of [`${POST_PUBLIC}#embedVideo`, 'app.bsky.embed.video']) {
      const view = withRecordPresentation(servedVideo, {
        $type: PP,
        embed: videoEmbed(type, 'gif'),
      })
      expect((view as {presentation?: string}).presentation).toBe('gif')
    }
  })

  it('as the media of a quote with media, from either embed type', () => {
    const served = {
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewNotFound',
          uri: privateUri('3kquoted', OTHER_DID),
          notFound: true,
        },
      },
      media: servedVideo,
    } as unknown as EmbedView
    for (const [withMedia, video] of [
      [`${POST_PUBLIC}#embedRecordWithMedia`, `${POST_PUBLIC}#embedVideo`],
      ['app.bsky.embed.recordWithMedia', 'app.bsky.embed.video'],
    ]) {
      const view = withRecordPresentation(served, {
        $type: PP,
        embed: {
          $type: withMedia,
          record: {
            $type: `${POST_PUBLIC}#embedRecord`,
            record: {uri: privateUri('3kquoted', OTHER_DID)},
          },
          media: videoEmbed(video, 'gif'),
        },
      }) as app.bsky.embed.recordWithMedia.View
      expect((view.media as {presentation?: string}).presentation).toBe('gif')
      // The quote part is left as served.
      expect(view.record).toBe(
        (served as app.bsky.embed.recordWithMedia.View).record,
      )
    }
  })

  it('leaves the view as served without a record presentation, or with its own', () => {
    const plain = withRecordPresentation(servedVideo, {
      $type: PP,
      embed: videoEmbed(`${POST_PUBLIC}#embedVideo`),
    })
    expect(plain).toBe(servedVideo)
    const own = {...servedVideo, presentation: 'default'} as EmbedView
    expect(
      withRecordPresentation(own, {
        $type: PP,
        embed: videoEmbed(`${POST_PUBLIC}#embedVideo`, 'gif'),
      }),
    ).toBe(own)
  })

  it('through the adapter, on a post prism serves', async () => {
    const view = {
      ...privateView('3kgif', {did: OTHER_DID}),
      embed: servedVideo,
    }
    view.record = {
      ...view.record,
      embed: videoEmbed(`${POST_PUBLIC}#embedVideo`, 'gif'),
    } as typeof view.record
    const {views} = await adaptPosts(
      [{view}],
      fakeAppview().client,
      () => undefined,
    )
    const embed = views.get(view.uri)?.embed as {presentation?: string}
    expect(embed.presentation).toBe('gif')
  })
})
