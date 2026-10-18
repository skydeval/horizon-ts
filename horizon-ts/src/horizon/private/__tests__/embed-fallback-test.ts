import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

const mockAuthorPdsUrl = jest.fn((did: string) =>
  Promise.resolve(did ? 'https://other-pds.example' : undefined),
)
jest.mock('#/horizon/private/adapt/pds', () => ({
  authorPdsUrl: (did: string) => mockAuthorPdsUrl(did),
}))

import {clearCurrentClients} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'
import {toFeedViewPosts} from '../adapt/feed-view'
import {clearPrivateStores} from '../store'
import {blob, BLOB_CID, OTHER_DID, RECORD_CID} from './fixtures'
import {fakeAppview, fakePrism, privateView} from './read-fixtures'

const PUB = 'tools.kryphocron.feed.postPublic'
const PUBLIC_QUOTE =
  'at://did:plc:publicccccccccccccccccccc/app.bsky.feed.post/3kquoted2222'

function withEmbed(rkey: string, embed: unknown, did?: string) {
  const view = privateView(rkey, did ? {did, handle: 'other.test'} : {})
  return {...view, record: {...view.record, embed}}
}

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
  mockAuthorPdsUrl.mockClear()
})

describe('record embeds in served views (6.1.3)', () => {
  it('builds images from the author’s PDS, a video from the video service and a public quote from the AppView', async () => {
    const appview = fakeAppview({
      posts: [
        {
          uri: PUBLIC_QUOTE,
          cid: RECORD_CID,
          author: {did: 'did:plc:publicccccccccccccccccccc', handle: 'p.test'},
          record: {
            $type: 'app.bsky.feed.post',
            text: 'quoted',
            createdAt: '2026-10-15T12:00:00.000Z',
          },
          indexedAt: '2026-10-15T12:00:00.000Z',
        },
      ],
    })
    const items = await toFeedViewPosts(
      [
        {
          view: withEmbed(
            '3kimg',
            {$type: `${PUB}#embedImage`, images: [{image: blob(), alt: 'a'}]},
            OTHER_DID,
          ),
        },
        {
          view: withEmbed('3kvid', {
            $type: `${PUB}#embedVideo`,
            video: blob(10, 'video/mp4'),
          }),
        },
        {
          view: withEmbed('3kquo', {
            $type: `${PUB}#embedRecord`,
            record: {uri: PUBLIC_QUOTE, cid: RECORD_CID},
          }),
        },
      ],
      {prism: fakePrism().client, appview: appview.client},
    )
    const byRkey = new Map(
      items.map(item => [item.post.uri.split('/').pop(), item.post]),
    )
    const images = byRkey.get('3kimg')?.embed as app.bsky.embed.images.View
    expect(images.images[0].thumb).toBe(
      `https://other-pds.example/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(OTHER_DID)}&cid=${BLOB_CID}`,
    )
    expect(mockAuthorPdsUrl).toHaveBeenCalledWith(OTHER_DID)
    expect(mockAuthorPdsUrl).toHaveBeenCalledTimes(1)
    const video = byRkey.get('3kvid')?.embed as app.bsky.embed.video.View
    expect(video.$type).toBe('app.bsky.embed.video#view')
    expect(video.playlist).toMatch(/^https:\/\/video\.bsky\.app\/watch\//)
    const quote = byRkey.get('3kquo')?.embed as app.bsky.embed.record.View
    expect(quote.record).toMatchObject({
      $type: 'app.bsky.embed.record#viewRecord',
      uri: PUBLIC_QUOTE,
    })
    expect(
      appview.calls.some(call => call.nsid === 'app.bsky.feed.getPosts'),
    ).toBe(true)
  })

  it('a view prism serves with an embed keeps it', async () => {
    const served = {
      $type: 'app.bsky.embed.external#view',
      external: {uri: 'https://example.com', title: 't', description: 'd'},
    }
    const view = {
      ...withEmbed('3kext', {
        $type: `${PUB}#embedExternal`,
        external: {uri: 'https://other.example', title: '', description: ''},
      }),
      embed: served,
    }
    const items = await toFeedViewPosts([{view}], {
      prism: fakePrism().client,
      appview: fakeAppview().client,
    })
    expect(items[0].post.embed).toEqual(served)
  })
})
