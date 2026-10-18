import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))

import {type FeedAPI} from '#/lib/api/feed/types'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'
import {toPostView} from '../adapt/post-view'
import {horizonFeedApi} from '../feed/legacy'
import {addPendingPost, clearPrivateStores} from '../store'
import {DID, OTHER_DID, RECORD_CID} from './fixtures'
import {
  at,
  AUDIENCE_URI,
  fakeAppview,
  fakePrism,
  PP,
  type PrivateView,
  privateView,
  publicItem,
} from './read-fixtures'

function stockApi(feed: unknown[]) {
  const calls: (string | undefined)[] = []
  const api: FeedAPI = {
    peekLatest: () => Promise.resolve(feed[0] as never),
    fetch: ({cursor}) => {
      calls.push(cursor)
      return Promise.resolve({
        cursor: cursor ? undefined : 'next',
        feed: feed as app.bsky.feed.defs.FeedViewPost[],
      })
    },
  }
  return {api, calls}
}

function source(
  {
    posts = [],
    pinned,
    authorFeed,
  }: {
    posts?: PrivateView[]
    pinned?: string
    authorFeed?: (cursor: string) => {feed: PrivateView[]; cursor?: string}
  } = {},
  did = DID,
) {
  const prismCalls: string[] = []
  const prism = fakePrism({
    posts,
    handler: (nsid, params) => {
      prismCalls.push(nsid)
      if (nsid === 'app.nearhorizon.private.getAuthorFeed' && authorFeed) {
        return {status: 200, body: authorFeed(params.get('cursor') ?? '')}
      }
      return undefined
    },
  })
  const appview = fakeAppview({
    profile: {
      did: OTHER_DID,
      handle: 'owner.test',
      ...(pinned ? {pinnedPost: {uri: pinned, cid: RECORD_CID}} : {}),
    },
  })
  return {
    source: {did, prism: prism.client, appview: appview.client},
    prismCalls,
  }
}

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
})

describe('the pinned private post', () => {
  const posts = `author|${OTHER_DID}|posts_and_author_threads`

  it('prefixes a private pin prism returns, with reasonPin, and removes it from the page', async () => {
    const pin = privateView('3kpin', {did: OTHER_DID})
    const {source: s} = source({posts: [pin], pinned: pin.uri})
    const stock = stockApi([
      publicItem('a', 5),
      {post: {...publicItem('b', 4).post, uri: pin.uri}},
    ])
    const api = horizonFeedApi(posts, s, stock.api)
    const res = await api.fetch({cursor: undefined, limit: 30})
    expect(res.feed.map(i => i.post.uri)).toEqual([
      pin.uri,
      publicItem('a', 5).post.uri,
    ])
    expect(res.feed[0].reason).toEqual({
      $type: 'app.bsky.feed.defs#reasonPin',
    })
    // The Posts merge's cursor (6.3.1): the stock page had more.
    expect(res.cursor).toMatch(/^hz1\./)
  })

  it('adds nothing on a miss', async () => {
    const pin = privateView('3kpin', {did: OTHER_DID})
    const {source: s} = source({posts: [], pinned: pin.uri})
    const stock = stockApi([publicItem('a', 5)])
    const res = await horizonFeedApi(posts, s, stock.api).fetch({
      cursor: undefined,
      limit: 30,
    })
    expect(res.feed.map(i => i.post.uri)).toEqual([publicItem('a', 5).post.uri])
  })

  it('leaves a public pin to the stock code, and a stock cursor to the stock API', async () => {
    const {source: s, prismCalls} = source({
      pinned: publicItem('pinned', 1).post.uri,
    })
    const stock = stockApi([publicItem('a', 5)])
    const api = horizonFeedApi(posts, s, stock.api)
    const first = await api.fetch({cursor: undefined, limit: 30})
    expect(first.feed.map(i => i.post.uri)).toEqual([
      publicItem('a', 5).post.uri,
    ])
    expect(prismCalls).not.toContain('app.nearhorizon.private.getPosts')
    const before = prismCalls.length
    await api.fetch({cursor: 'next', limit: 30})
    expect(prismCalls).toHaveLength(before)
    expect(stock.calls).toEqual([undefined, 'next'])
  })

  it('is the stock API without a private source', () => {
    const stock = stockApi([])
    expect(horizonFeedApi(posts, undefined, stock.api)).toBe(stock.api)
  })
})

describe('the Private tab feed', () => {
  it('reads the author’s private feed from prism and returns its cursor', async () => {
    const a = privateView('3ka', {did: OTHER_DID, minutes: 2})
    const b = privateView('3kb', {did: OTHER_DID, minutes: 1})
    const {source: s} = source({
      authorFeed: cursor =>
        cursor ? {feed: [b]} : {feed: [a], cursor: 'more'},
    })
    const api = horizonFeedApi(
      `author|${OTHER_DID}|horizon_private`,
      s,
      stockApi([]).api,
    )
    const first = await api.fetch({cursor: undefined, limit: 30})
    expect(first.feed.map(i => i.post.uri)).toEqual([a.uri])
    expect(first.cursor).toBe('more')
    const second = await api.fetch({cursor: 'more', limit: 30})
    expect(second.feed.map(i => i.post.uri)).toEqual([b.uri])
    expect(second.cursor).toBeUndefined()
  })

  it('adds the author’s own pending posts above the first page', async () => {
    publishCurrentClients({
      did: DID,
      handle: 'author.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: {} as never,
    })
    const record = {
      $type: PP,
      text: 'pending',
      createdAt: at(10),
      audienceList: AUDIENCE_URI,
    }
    const uri = `at://${DID}/${PP}/3kpending`
    const postView = toPostView(
      {
        uri,
        cid: RECORD_CID,
        author: {did: DID, handle: 'author.test'} as never,
        record,
        indexedAt: record.createdAt,
      },
      {isPending: true},
    ) as app.bsky.feed.defs.PostView
    addPendingPost({
      uri,
      cid: RECORD_CID,
      did: DID,
      record: record as never,
      audienceUri: AUDIENCE_URI,
      postView,
      feedItem: {post: postView},
      createdAt: record.createdAt,
      expiresAt: Date.now() + 60_000,
    })
    const served = privateView('3kserved', {minutes: 1})
    const {source: s} = source({authorFeed: () => ({feed: [served]})})
    const api = horizonFeedApi(
      `author|${DID}|horizon_private`,
      s,
      stockApi([]).api,
    )
    const res = await api.fetch({cursor: undefined, limit: 30})
    expect(res.feed.map(i => i.post.uri)).toEqual([uri, served.uri])
  })

  it('makes no request without a private source', async () => {
    const stock = stockApi([publicItem('x', 1)])
    const api = horizonFeedApi(
      `author|${OTHER_DID}|horizon_private`,
      undefined,
      stock.api,
    )
    const res = await api.fetch({cursor: undefined, limit: 30})
    expect(res.feed).toEqual([])
    expect(stock.calls).toEqual([])
  })
})
