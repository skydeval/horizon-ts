import {describe, expect, it, jest} from '@jest/globals'
import {renderHook} from '@testing-library/react-native'

jest.mock('#/state/queries/preferences', () => ({
  usePreferencesQuery: () => ({data: undefined}),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: 'did:plc:viewer'}}),
}))
jest.mock('#/state/preferences/languages', () => ({
  useLanguagePrefs: () => ({contentLanguages: []}),
}))

import {FeedTuner, type FeedViewPostsSlice} from '#/lib/api/feed-manip'
import {useFeedTuners} from '#/state/preferences/feed-tuners'
import {type FeedDescriptor} from '#/state/queries/post-feed'
import {type app} from '#/lexicons'
import {gridMediaOf, isPostGridFeed} from '../grid'

const DID = 'did:plc:authorrrrrrrrrrrrrrrrrrr'
const FIRST = `at://${DID}/app.bsky.feed.post/3kfirst`
const SECOND = `at://${DID}/app.bsky.feed.post/3ksecond`
const author = {did: DID, handle: 'author.test'}

const imagesView = {
  $type: 'app.bsky.embed.images#view',
  images: [
    {
      thumb: 'https://cdn.test/t.jpg',
      fullsize: 'https://cdn.test/f.jpg',
      alt: '',
    },
  ],
}
const videoView = {
  $type: 'app.bsky.embed.video#view',
  cid: 'bafy',
  playlist: 'https://video.test/p.m3u8',
  thumbnail: 'https://video.test/t.jpg',
}

function postView(uri: string, embed: unknown) {
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri,
    cid: 'bafyreigq2mrjcbqlzfnjzki45ey3se5ltmdwhimmrzq7lw2m6b6jheyejy',
    author,
    record: {
      $type: 'app.bsky.feed.post',
      text: 'x',
      createdAt: '2026-10-22T11:23:00.000Z',
    },
    embed,
    indexedAt: '2026-10-22T11:23:00.000Z',
  }
}

/*
 * The author feed's page, newest first: the reply (with the first post as
 * its parent and root), then the first post on its own. The slice takes its
 * context from the feed item's `reply`; the reply record's own `reply` ref
 * is left out because CID strings don't validate under jest.
 */
function selfThread(embed: unknown) {
  const first = postView(FIRST, embed)
  const second = postView(SECOND, embed)
  return [
    {post: second, reply: {root: first, parent: first}},
    {post: first},
  ] as unknown as app.bsky.feed.defs.FeedViewPost[]
}

/** The tiles a grid draws: each slice's own post, as `PostFeed` does. */
function tiles(slices: FeedViewPostsSlice[]): string[] {
  return slices.flatMap(slice => {
    const leaf = slice.items.find(i => i.post.uri === slice.feedPostUri)
    return leaf && gridMediaOf(leaf.post.embed) ? [leaf.post.uri] : []
  })
}

function tunedTiles(feed: FeedDescriptor, embed: unknown): string[] {
  const {result} = renderHook(() => useFeedTuners(feed))
  return tiles(new FeedTuner(result.current).tune(selfThread(embed)))
}

describe('a self-thread on the grids', () => {
  it('the media grid shows both image posts', () => {
    expect(tunedTiles(`author|${DID}|posts_with_media`, imagesView)).toEqual([
      SECOND,
      FIRST,
    ])
  })

  it('the video grid shows both video posts', () => {
    expect(tunedTiles(`author|${DID}|posts_with_video`, videoView)).toEqual([
      SECOND,
      FIRST,
    ])
  })

  it('without the grid tuner the earlier post is lost (the cause)', () => {
    expect(tiles(new FeedTuner([]).tune(selfThread(imagesView)))).toEqual([
      SECOND,
    ])
  })

  it('other author tabs keep their thread context', () => {
    expect(isPostGridFeed(`author|${DID}|posts_and_author_threads`)).toBe(false)
    expect(isPostGridFeed(`author|${DID}|posts_with_replies`)).toBe(false)
    const {result} = renderHook(() =>
      useFeedTuners(`author|${DID}|posts_and_author_threads`),
    )
    const [reply] = new FeedTuner(result.current).tune(selfThread(imagesView))
    expect(reply.items.map(i => i.post.uri)).toEqual([FIRST, SECOND])
  })
})
