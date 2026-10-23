import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {FALLBACK_MARKER_POST} from '#/features/followingV2/home/api/home'
import {
  type FeedAPI,
  type FeedAPIResponse,
  type FeedSource,
} from '#/features/followingV2/home/api/types'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {getPrismHealth, resetPrismHealth} from '#/horizon/routing/health'
import {type app} from '#/lexicons'
import {toFeedViewPosts} from '../adapt/feed-view'
import {toPostView} from '../adapt/post-view'
import {getPrivatePosts} from '../api/reads'
import {carryGapBoundary, carryStagedPrivate, judgeStaged} from '../feed/carry'
import {
  decodeMergeCursor,
  decodeMergeStart,
  encodeMergeCursor,
  encodeMergeStart,
  guardMergeStart,
  initialMergeState,
  isHeldMarker,
  type MergeStart,
  type MergeStartWalk,
  PRIVATE_LOOKBACK_MS,
  PRIVATE_SEEN_MAX,
} from '../feed/cursor'
import {
  PRIVATE_SINCE_MAX_PAGES,
  rejectMergeCursors,
  resetPrivateHead,
  withPrivateTimeline,
} from '../feed/timeline-merge'
import {isSyncing, missVerdict, resetKnown} from '../known'
import {unwrapPrivateQuotes} from '../quotes/resolve'
import {addPendingPost, clearPrivateStores} from '../store'
import {
  type Call,
  DID,
  fakeClient,
  OTHER_DID,
  privateUri,
  RECORD_CID,
  type Reply,
} from './fixtures'
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

type PublicPage = {feed: unknown[]; cursor?: string; startCursor?: string}

/**
 * A stock Following API over fixed pages, keyed by the cursor that asks for
 * them ('' for the first). `discover` pages answer `source: 'discover'`.
 */
function fakeStock(
  pages: Record<string, PublicPage | Error>,
  discover: Record<string, PublicPage> = {},
) {
  const calls: {cursor?: string; since?: string; source?: FeedSource}[] = []
  const api: FeedAPI = {
    peekLatest: () => Promise.resolve(undefined),
    fetch: ({cursor, since, source}) => {
      calls.push({cursor, since, source})
      if (source === 'discover') {
        const page = discover[cursor ?? '']
        return Promise.resolve({
          ...(page ?? {feed: []}),
          source: 'discover',
        } as FeedAPIResponse)
      }
      const page = pages[cursor ?? '']
      if (page instanceof Error) return Promise.reject(page)
      if (!page) return Promise.reject(new Error(`no page ${cursor}`))
      return Promise.resolve(page as FeedAPIResponse)
    },
  }
  return {api, calls}
}

/**
 * A prism whose private timeline answers fixed pages, keyed by cursor.
 */
function timelinePrism(
  pages: Record<string, {feed: PrivateView[]; cursor?: string} | 'fail'>,
) {
  const cursors: string[] = []
  const prism = fakePrism({
    handler: (nsid, params) => {
      if (nsid !== 'app.nearhorizon.private.getTimeline') return undefined
      const cursor = params.get('cursor') ?? ''
      cursors.push(cursor)
      const page = pages[cursor]
      if (!page || page === 'fail') {
        return {status: 500, body: {error: 'InternalServerError'}}
      }
      return {status: 200, body: page}
    },
  })
  return {client: prism.client, cursors}
}

/**
 * Page through the merged feed to its end, as the feed query does.
 */
async function pageToEnd(api: FeedAPI, limit = 30) {
  const responses: FeedAPIResponse[] = []
  let cursor: string | undefined
  let source: FeedSource | undefined
  for (let i = 0; i < 50; i++) {
    const res = await api.fetch({cursor, source, limit})
    responses.push(res)
    if (!res.cursor) break
    cursor = res.cursor
    source = res.source
  }
  return {
    responses,
    uris: responses.flatMap(res => res.feed.map(item => item.post.uri)),
  }
}

function uriOf(item: {post: {uri: string}} | PrivateView) {
  return 'post' in item ? item.post.uri : item.uri
}

function merged(
  stock: FeedAPI,
  prism: ReturnType<typeof timelinePrism>,
): FeedAPI {
  return withPrivateTimeline(
    'following',
    {did: DID, prism: prism.client, appview: fakeAppview().client},
    stock,
  )
}

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
  resetPrivateHead()
})

describe('withPrivateTimeline', () => {
  it('returns the stock API for other feeds (resolving quotes) and without a private source', async () => {
    const {api, calls} = fakeStock({'': {feed: [publicItem('x', 1)]}})
    const source = {
      did: DID,
      prism: fakePrism().client,
      appview: fakeAppview().client,
    }
    // With a source the stock API resolves its pages' private quotes.
    const other = unwrapPrivateQuotes(
      withPrivateTimeline('author|x|posts_no_replies', source, api),
    )
    const plain = withPrivateTimeline('following', undefined, api)
    expect(
      (await other.fetch({cursor: undefined, limit: 30})).feed,
    ).toHaveLength(1)
    expect(
      (await plain.fetch({cursor: undefined, limit: 30})).feed,
    ).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  it('emits every item of both sides once, each side in order, merged by time, fetching no page twice', async () => {
    const p = [publicItem('p10', 10), publicItem('p8', 8), publicItem('p6', 6)]
    const q = [publicItem('p4', 4), publicItem('p2', 2)]
    const stock = fakeStock({
      '': {feed: p, cursor: 'pub1', startCursor: 'start'},
      pub1: {feed: q},
    })
    const v = [
      privateView('3k9', {minutes: 9}),
      privateView('3k7', {minutes: 7}),
    ]
    const w = [
      privateView('3k5', {minutes: 5}),
      privateView('3k3', {minutes: 3}),
      privateView('3k1', {minutes: 1}),
    ]
    const prism = timelinePrism({
      '': {feed: v, cursor: 'priv1'},
      priv1: {feed: w},
    })
    const {uris, responses} = await pageToEnd(merged(stock.api, prism))
    expect(uris).toEqual(
      [p[0], v[0], p[1], v[1], p[2], w[0], q[0], w[1], q[1], w[2]].map(uriOf),
    )
    // The start is the private marker around the stock one (item 7 3.1).
    expect(decodeMergeStart(responses[0].startCursor)?.pub).toBe('start')
    expect(stock.calls.map(c => c.cursor)).toEqual([undefined, 'pub1'])
    expect(prism.cursors).toEqual(['', 'priv1'])
    expect(responses.at(-1)?.cursor).toBeUndefined()
  })

  it('drains a private run longer than several pages between two public items', async () => {
    const stock = fakeStock({
      '': {feed: [publicItem('new', 100), publicItem('old', 1)]},
    })
    const prism = timelinePrism({
      '': {
        feed: [
          privateView('3k90', {minutes: 90}),
          privateView('3k80', {minutes: 80}),
        ],
        cursor: 'a',
      },
      a: {
        feed: [
          privateView('3k70', {minutes: 70}),
          privateView('3k60', {minutes: 60}),
        ],
        cursor: 'b',
      },
      b: {
        feed: [
          privateView('3k50', {minutes: 50}),
          privateView('3k40', {minutes: 40}),
        ],
      },
    })
    const {uris} = await pageToEnd(merged(stock.api, prism))
    expect(uris.map(uri => uri.split('/').pop())).toEqual([
      'new',
      '3k90',
      '3k80',
      '3k70',
      '3k60',
      '3k50',
      '3k40',
      'old',
    ])
    expect(stock.calls).toHaveLength(1)
    expect(prism.cursors).toEqual(['', 'a', 'b'])
  })

  it('keeps prism’s order for two private items in the same millisecond', async () => {
    const stock = fakeStock({'': {feed: [publicItem('p', 0)]}})
    // Prism orders 3kaa before 3kzz; the client's key would order them the other way.
    const prism = timelinePrism({
      '': {
        feed: [
          privateView('3kaa', {minutes: 5}),
          privateView('3kzz', {minutes: 5}),
        ],
      },
    })
    const {uris} = await pageToEnd(merged(stock.api, prism))
    expect(uris.map(uri => uri.split('/').pop())).toEqual(['3kaa', '3kzz', 'p'])
  })

  it('emits a public run with non-monotonic times in its own order', async () => {
    const stock = fakeStock({
      '': {
        feed: [publicItem('p5', 5), publicItem('p9', 9), publicItem('p3', 3)],
      },
    })
    const prism = timelinePrism({
      '': {feed: [privateView('3k7', {minutes: 7})]},
    })
    const {uris} = await pageToEnd(merged(stock.api, prism))
    expect(uris.map(uri => uri.split('/').pop())).toEqual([
      '3k7',
      'p5',
      'p9',
      'p3',
    ])
  })

  it('follows a public page with no Following items but a cursor', async () => {
    const stock = fakeStock({
      '': {feed: [], cursor: 'next'},
      next: {feed: [publicItem('p1', 1)]},
    })
    const prism = timelinePrism({
      '': {feed: [privateView('3k2', {minutes: 2})]},
    })
    const {uris, responses} = await pageToEnd(merged(stock.api, prism))
    expect(uris.map(uri => uri.split('/').pop())).toEqual(['3k2', 'p1'])
    expect(responses).toHaveLength(1)
  })

  it('appends the Discover tail only on the call that drains the private side', async () => {
    const stock = fakeStock(
      {
        '': {
          feed: [
            publicItem('p10', 10),
            FALLBACK_MARKER_POST,
            publicItem('d1', 50),
            publicItem('d2', 40),
          ],
          cursor: 'disc1',
        },
      },
      {disc1: {feed: [publicItem('d3', 30)]}},
    )
    const prism = timelinePrism({
      '': {
        feed: [
          privateView('3k9', {minutes: 9}),
          privateView('3k8', {minutes: 8}),
        ],
        cursor: 'c',
      },
      c: {feed: [privateView('3k7', {minutes: 7})]},
    })
    const api = merged(stock.api, prism)
    const first = await api.fetch({cursor: undefined, limit: 30})
    expect(first.feed.map(i => i.post.uri.split('/').pop())).toEqual([
      'p10',
      '3k9',
      '3k8',
    ])
    expect(first.source).toBeUndefined()
    const second = await api.fetch({
      cursor: first.cursor,
      source: first.source,
      limit: 30,
    })
    expect(second.feed.map(i => i.post.uri.split('/').pop())).toEqual([
      '3k7',
      FALLBACK_MARKER_POST.post.uri,
      'd1',
      'd2',
    ])
    expect(second.cursor).toBe('disc1')
    expect(second.source).toBe('discover')
    const third = await api.fetch({
      cursor: second.cursor,
      source: second.source,
      limit: 30,
    })
    expect(third.feed.map(i => i.post.uri.split('/').pop())).toEqual(['d3'])
    expect(stock.calls.at(-1)).toEqual({
      cursor: 'disc1',
      since: undefined,
      source: 'discover',
    })
  })

  it('ends the feed after the private side drains on the development fallback page', async () => {
    const stock = fakeStock({
      '': {feed: [publicItem('p10', 10), FALLBACK_MARKER_POST]},
    })
    const prism = timelinePrism({
      '': {feed: [privateView('3k9', {minutes: 9})], cursor: 'c'},
      c: {feed: [privateView('3k1', {minutes: 1})]},
    })
    const {uris, responses} = await pageToEnd(merged(stock.api, prism))
    expect(uris.map(uri => uri.split('/').pop())).toEqual([
      'p10',
      '3k9',
      '3k1',
      FALLBACK_MARKER_POST.post.uri,
    ])
    expect(responses.at(-1)?.cursor).toBeUndefined()
  })

  it('continues public-only after a private failure, still emitting what was buffered', async () => {
    const stock = fakeStock({
      '': {feed: [publicItem('p10', 10), publicItem('p8', 8)], cursor: 'n'},
      n: {feed: [publicItem('p6', 6), publicItem('p5', 5)]},
    })
    const prism = timelinePrism({
      '': {
        feed: [
          privateView('3k9', {minutes: 9}),
          privateView('3k7', {minutes: 7}),
        ],
        cursor: 'c',
      },
      c: 'fail',
    })
    const {uris} = await pageToEnd(merged(stock.api, prism))
    expect(uris.map(uri => uri.split('/').pop())).toEqual([
      'p10',
      '3k9',
      'p8',
      '3k7',
      'p6',
      'p5',
    ])
    expect(prism.cursors).toEqual(['', 'c'])
  })

  it('fails the call on a public failure and repeats it from the same cursor', async () => {
    const pages: Record<string, PublicPage | Error> = {
      '': {feed: [publicItem('p10', 10)], cursor: 'n'},
      n: new Error('public down'),
    }
    const stock = fakeStock(pages)
    const prism = timelinePrism({
      '': {feed: [privateView('3k9', {minutes: 9})], cursor: 'c'},
      c: {feed: [privateView('3k1', {minutes: 1})]},
    })
    const api = merged(stock.api, prism)
    // The public head is emitted; the public side then needs its next page.
    const first = await api.fetch({cursor: undefined, limit: 30})
    expect(first.feed.map(i => i.post.uri.split('/').pop())).toEqual(['p10'])
    await expect(api.fetch({cursor: first.cursor, limit: 30})).rejects.toThrow(
      'public down',
    )
    pages.n = {feed: [publicItem('p5', 5)]}
    const retry = await api.fetch({cursor: first.cursor, limit: 30})
    expect(retry.feed.map(i => i.post.uri.split('/').pop())).toEqual(['3k9'])
    const last = await api.fetch({cursor: retry.cursor, limit: 30})
    expect(last.feed.map(i => i.post.uri.split('/').pop())).toEqual([
      'p5',
      '3k1',
    ])
    expect(last.cursor).toBeUndefined()
  })

  it('passes a foreign cursor, a since and a Discover source through to the stock API', async () => {
    const stock = fakeStock({abc: {feed: [publicItem('x', 1)]}, '': {feed: []}})
    const prism = timelinePrism({})
    const api = merged(stock.api, prism)
    await api.fetch({cursor: 'abc', limit: 30})
    await api.fetch({cursor: undefined, since: 'start', limit: 30})
    await api.fetch({cursor: 'abc', source: 'discover', limit: 30})
    expect(stock.calls).toEqual([
      {cursor: 'abc', since: undefined, source: undefined},
      {cursor: undefined, since: 'start', source: undefined},
      {cursor: 'abc', since: undefined, source: 'discover'},
    ])
    expect(prism.cursors).toEqual([])
  })

  it('inserts the current account’s pending posts on the first call only', async () => {
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
      text: 'just written',
      createdAt: at(20),
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
    const stock = fakeStock({
      '': {feed: [publicItem('p10', 10)], cursor: 'n'},
      n: {feed: [publicItem('p5', 5)]},
    })
    // The first private page fails: the pending post is still emitted.
    const prism = timelinePrism({'': 'fail'})
    const {uris} = await pageToEnd(merged(stock.api, prism))
    expect(uris.map(u => u.split('/').pop())).toEqual([
      '3kpending',
      'p10',
      'p5',
    ])
  })

  it('keeps requesting through empty private pages that carry a cursor, within one load', async () => {
    const stock = fakeStock({
      '': {feed: [publicItem('p100', 100), publicItem('p1', 1)]},
    })
    const prism = timelinePrism({
      '': {feed: [privateView('3k90', {minutes: 90})], cursor: 'a'},
      a: {feed: [], cursor: 'b'},
      b: {feed: [], cursor: 'c'},
      c: {feed: [privateView('3k50', {minutes: 50})]},
    })
    const {uris, responses} = await pageToEnd(merged(stock.api, prism))
    expect(uris.map(uri => uri.split('/').pop())).toEqual([
      'p100',
      '3k90',
      '3k50',
      'p1',
    ])
    expect(prism.cursors).toEqual(['', 'a', 'b', 'c'])
    // No load came back empty while items remained.
    expect(responses.slice(0, -1).every(res => res.feed.length > 0)).toBe(true)
  })
})

describe('new private posts in Following (item 7)', () => {
  const T = (minutes: number) => Date.parse(at(minutes))
  let clock: number
  let pdsState: 'present' | 'absent'

  type TimelinePage = {
    feed: PrivateView[]
    cursor?: string
    degraded?: boolean
    unavailable?: unknown[]
  }
  type PageReply = TimelinePage | 'fail' | (() => Promise<Reply>)

  /** A prism whose timeline answers `pages` by cursor ('' for the head). */
  function livePrism(
    pages: Record<string, PageReply>,
    posts: PrivateView[] = [],
  ) {
    const timeline: string[] = []
    const getPosts: string[][] = []
    const {client} = fakeClient(DID, (call: Call) => {
      if (call.nsid === 'app.nearhorizon.private.getTimeline') {
        const cursor = call.params.get('cursor') ?? ''
        timeline.push(cursor)
        const page = pages[cursor]
        if (typeof page === 'function') return page()
        if (!page || page === 'fail') {
          return {status: 500, body: {error: 'InternalServerError'}}
        }
        return {status: 200, body: page}
      }
      if (call.nsid === 'app.nearhorizon.private.getPosts') {
        const wanted = call.params.getAll('uris')
        getPosts.push(wanted)
        return {
          status: 200,
          body: {posts: posts.filter(p => wanted.includes(p.uri))},
        }
      }
      return {status: 501, body: {error: 'MethodNotImplemented'}}
    })
    return {client, timeline, getPosts, pages}
  }

  /** A stock Following API: pages by cursor, `since:<s>` for a since fetch. */
  function liveStock(
    pages: Record<string, PublicPage | Error>,
    peek: () => Promise<app.bsky.feed.defs.FeedViewPost | undefined> = () =>
      Promise.resolve(undefined),
  ) {
    const calls: string[] = []
    const api: FeedAPI = {
      peekLatest: () => {
        calls.push('peek')
        return peek()
      },
      fetch: ({cursor, since}) => {
        const key = since !== undefined ? `since:${since}` : (cursor ?? '')
        calls.push(key)
        const page = pages[key]
        if (page instanceof Error) return Promise.reject(page)
        if (!page) return Promise.reject(new Error(`no page ${key}`))
        return Promise.resolve(page as FeedAPIResponse)
      },
    }
    return {api, calls, pages}
  }

  function liveMerged(
    stock: ReturnType<typeof liveStock>,
    prism: ReturnType<typeof livePrism>,
    appview = fakeAppview(),
  ) {
    return withPrivateTimeline(
      'following',
      {did: DID, prism: prism.client, appview: appview.client},
      stock.api,
    )
  }

  function other(rkey: string, minutes: number, extra = {}) {
    return privateView(rkey, {
      did: OTHER_DID,
      handle: 'other.test',
      minutes,
      ...extra,
    })
  }

  function rkeys(feed: {post: {uri: string}}[]) {
    return feed.map(item => item.post.uri.split('/').pop())
  }

  function markerOf(res: FeedAPIResponse): MergeStart {
    return decodeMergeStart(res.startCursor)!
  }

  function seenKeys(start: MergeStart) {
    return start.seen.map(([key]) => key.split('/').pop())
  }

  function addPending(rkey: string, minutes: number) {
    const record = {
      $type: PP,
      text: `pending ${rkey}`,
      createdAt: at(minutes),
      audienceList: AUDIENCE_URI,
    }
    const uri = privateUri(rkey)
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
      expiresAt: clock + 60_000,
    })
    return uri
  }

  /** Lets queued promise callbacks run (the PDS check). */
  async function settle() {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
  }

  beforeEach(() => {
    clock = T(60)
    pdsState = 'present'
    resetPrismHealth({now: () => clock})
    resetKnown()
    const pds = fakeClient(DID, () =>
      pdsState === 'absent'
        ? {status: 400, body: {error: 'RecordNotFound'}}
        : {
            status: 200,
            body: {
              uri: privateUri('x'),
              cid: RECORD_CID,
              value: {$type: PP, text: 'x', createdAt: at(0)},
            },
          },
    )
    publishCurrentClients({
      did: DID,
      handle: 'author.test',
      pdsUrl: undefined,
      pdsClient: pds.client,
      prismClient: {} as never,
      appviewClient: {} as never,
    })
  })

  afterAll(() => {
    resetPrismHealth()
  })

  /**
   * The first page: p50 public; 3k55 and 3k45 private (own), so `priv` is
   * 55 and `floor` 45.
   */
  async function firstPage(
    prismPages: Record<string, PageReply> = {
      '': {feed: [privateView('3k55', {minutes: 55}), other('3k45', 45)]},
    },
    stockPages: Record<string, PublicPage | Error> = {},
  ) {
    const stock = liveStock({
      '': {feed: [publicItem('p50', 50)], cursor: 'pub1', startCursor: 'S0'},
      ...stockPages,
    })
    const prism = livePrism(prismPages)
    const appview = fakeAppview()
    const api = liveMerged(stock, prism, appview)
    const first = await api.fetch({cursor: undefined, limit: 30})
    return {api, stock, prism, appview, first, since: first.startCursor!}
  }

  /** Lets the head memo expire, as the next check finds it. */
  function nextCheck(ms = 61_000) {
    clock += ms
  }

  describe('the stock boundary (F-17)', () => {
    it('rejects hz1. and hz1s. strings with no request', async () => {
      const {api, calls} = fakeStock({'': {feed: []}})
      const guarded = rejectMergeCursors(api)
      await expect(
        guarded.fetch({cursor: 'hz1.abc', limit: 30}),
      ).rejects.toThrow()
      await expect(
        guarded.fetch({cursor: undefined, since: 'hz1s.abc', limit: 30}),
      ).rejects.toThrow()
      const noSource = withPrivateTimeline('following', undefined, api)
      await expect(
        noSource.fetch({cursor: undefined, since: 'hz1s.x', limit: 30}),
      ).rejects.toThrow()
      expect(calls).toEqual([])
    })

    it('reads a startCursor misused as a cursor as its stock one', async () => {
      const {api, stock} = await firstPage(undefined, {
        S0: {feed: [publicItem('p40', 40)]},
      })
      const start = encodeMergeStart({
        pub: 'S0',
        priv: {time: T(55), uri: ''},
        floor: T(45),
        seen: [],
      })
      await api.fetch({cursor: start, limit: 30})
      expect(stock.calls.at(-1)).toBe('S0')
    })
  })

  describe('the first page marker (F-1)', () => {
    it('carries the stock start, a capped priv, the floor and every input fetched, pending included', async () => {
      addPending('3kpend', 58)
      const {first} = await firstPage({
        '': {
          feed: [
            privateView('3kfast', {minutes: 63}),
            privateView('3k55', {minutes: 55}),
            other('3k51', 51),
          ],
        },
      })
      const start = markerOf(first)
      expect(start.pub).toBe('S0')
      // The fast item is capped at the fetch time.
      expect(start.priv.time).toBe(clock)
      expect(start.floor).toBe(clock - PRIVATE_LOOKBACK_MS)
      expect(seenKeys(start)).toEqual(['3kfast', '3kpend', '3k55', '3k51'])
      expect(start.held).toBeUndefined()
      expect(first).not.toHaveProperty('privateDegraded')
    })

    it('starts five minutes before the fetch when the private read fails or is empty, unless a newer pending post wins', async () => {
      const failed = await firstPage({'': 'fail'})
      expect(markerOf(failed.first).priv.time).toBe(clock - 5 * 60_000)
      resetPrismHealth({now: () => clock})
      const empty = await firstPage({'': {feed: []}})
      expect(markerOf(empty.first).priv.time).toBe(clock - 5 * 60_000)

      addPending('3kpend', 58)
      resetPrismHealth({now: () => clock})
      const pending = await firstPage({'': 'fail'})
      expect(markerOf(pending.first).priv.time).toBe(T(58))
      expect(seenKeys(markerOf(pending.first))).toEqual(['3kpend'])
    })

    it('raises the floor to the oldest key read when the read stopped with a cursor', async () => {
      const {first} = await firstPage({
        '': {
          feed: [
            privateView('3k58', {minutes: 58}),
            privateView('3k56', {minutes: 56}),
          ],
          cursor: 'more',
        },
      })
      expect(markerOf(first).floor).toBe(T(56))
    })

    it('has no start without a stock one', async () => {
      const stock = liveStock({'': {feed: [publicItem('p50', 50)]}})
      const prism = livePrism({'': {feed: []}})
      const res = await liveMerged(stock, prism).fetch({
        cursor: undefined,
        limit: 30,
      })
      expect(res.startCursor).toBeUndefined()
    })
  })

  describe('the merged since fetch', () => {
    it('interleaves both sides and echoes since when both are exhausted (F-2)', async () => {
      const {api, prism, since} = await firstPage(undefined, {
        'since:S0': {
          feed: [publicItem('p58', 58)],
          cursor: 'S0',
          startCursor: 'S1',
        },
      })
      nextCheck()
      prism.pages[''] = {
        feed: [
          privateView('3k59', {minutes: 59}),
          other('3k57', 57),
          privateView('3k55', {minutes: 55}),
          other('3k45', 45),
        ],
      }
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(rkeys(res.feed)).toEqual(['3k59', 'p58', '3k57'])
      expect(res.cursor).toBe(since)
      const next = markerOf(res)
      expect(next.pub).toBe('S1')
      expect(next.priv.time).toBe(T(59))
      expect(next.floor).toBe(T(49))
      expect(seenKeys(next)).toEqual(['3k59', '3k57', '3k55'])
      expect(next.held).toBeUndefined()
      expect(next.walk?.outcome).toBe('answered')
      expect(res).not.toHaveProperty('privateDegraded')
    })

    it('keeps unemitted private items in the merge cursor past a public gap, and brings them back from it (F-3)', async () => {
      const {api, prism, since} = await firstPage(undefined, {
        'since:S0': {
          feed: [publicItem('p58', 58), publicItem('p52', 52)],
          cursor: 'gap',
          startCursor: 'S1',
        },
        gap: {feed: [publicItem('p51', 51)], cursor: 'more'},
      })
      nextCheck()
      prism.pages[''] = {
        feed: [
          privateView('3k59', {minutes: 59}),
          privateView('3k55', {minutes: 55}),
          other('3k50', 50),
          other('3k45', 45),
        ],
      }
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(rkeys(res.feed)).toEqual(['3k59', 'p58', 'p52'])
      const state = decodeMergeCursor(res.cursor!)
      expect(state.pub.cursor).toBe('gap')
      expect(
        state.priv.buf.map(input => input.view.uri.split('/').pop()),
      ).toEqual(['3k55', '3k50', '3k45'])
      expect(state.resumesAtBoundary).toBeUndefined()

      const fill = await api.fetch({cursor: res.cursor, limit: 30})
      // A seen item skipped above sorts just below the gap row, then in order.
      expect(rkeys(fill.feed)).toEqual(['3k55', 'p51'])
      expect(
        decodeMergeCursor(fill.cursor!).priv.buf.map(input =>
          input.view.uri.split('/').pop(),
        ),
      ).toEqual(['3k50', '3k45'])
    })

    it('holds prism’s cursor and resumesAtBoundary in the merge cursor on a private overflow (F-4)', async () => {
      const {api, prism, since} = await firstPage(
        {'': {feed: [privateView('3k50', {minutes: 50})]}},
        {
          'since:S0': {
            feed: [publicItem('p52', 52)],
            cursor: 'S0',
            startCursor: 'S1',
          },
        },
      )
      nextCheck()
      prism.pages[''] = {
        feed: [
          privateView('3k59', {minutes: 59}),
          privateView('3k58', {minutes: 58}),
        ],
        cursor: 'h1',
      }
      prism.pages.h1 = {
        feed: [privateView('3k57', {minutes: 57})],
        cursor: 'h2',
      }
      for (let i = 2; i < 2 + PRIVATE_SINCE_MAX_PAGES; i++) {
        prism.pages[`h${i}`] = {
          feed: [privateView(`3k5${8 - i}`, {minutes: 58 - i})],
          cursor: `h${i + 1}`,
        }
      }
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(rkeys(res.feed)).toEqual([
        '3k59',
        '3k58',
        '3k57',
        '3k56',
        '3k55',
        '3k54',
        '3k53',
      ])
      expect(res).not.toHaveProperty('resumesAtBoundary')
      const state = decodeMergeCursor(res.cursor!)
      expect(state.resumesAtBoundary).toBe(true)
      expect(state.pub.cursor).toBe('S0')
      expect(state.priv.cursor).toBe('h6')
      expect(rkeys(state.pub.buf)).toEqual(['p52'])
      // The head (its short first page followed once) and four pages of 30 (3.6).
      expect(prism.timeline.slice(1)).toEqual([
        '',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
      ])

      // The fill keeps the old top's boundary posts: the first public and two at its time.
      const lower = {
        feed: [
          publicItem('b1', 50),
          publicItem('b2', 50),
          publicItem('b3', 50),
          publicItem('b4', 49),
        ] as never[],
      }
      const upper = {feed: [publicItem('p52', 52)] as never[]}
      expect(rkeys(carryGapBoundary(res.cursor, upper, lower).feed)).toEqual([
        'p52',
        'b1',
        'b2',
        'b3',
      ])
      expect(carryGapBoundary('plain', upper, lower)).toBe(upper)
      expect(
        carryGapBoundary(encodeMergeCursor(initialMergeState()), upper, lower),
      ).toBe(upper)
    })

    it('goes public-only on a failed walk, holds the marker, and offers what it missed next time (F-5, F-10)', async () => {
      const {api, prism, since, first} = await firstPage(undefined, {
        'since:S0': {
          feed: [publicItem('p58', 58), publicItem('p52', 52)],
          cursor: 'gap',
          startCursor: 'S1',
        },
        'since:S1': {feed: [], cursor: 'S1', startCursor: 'S1'},
      })
      nextCheck()
      prism.pages[''] = 'fail'
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(rkeys(res.feed)).toEqual(['p58', 'p52'])
      expect(res).not.toHaveProperty('privateDegraded')
      const held = markerOf(res)
      expect(held.held).toBe(true)
      expect(held.priv).toEqual(markerOf(first).priv)
      expect(held.floor).toBe(markerOf(first).floor)
      expect(held.walk?.outcome).toBe('none')
      expect(decodeMergeCursor(res.cursor!).priv.failed).toBe(true)

      // While retryAt is ahead, no private call (F-10).
      expect(getPrismHealth(DID).retryAt).toBeGreaterThan(clock)
      prism.pages[''] = {
        feed: [
          privateView('3k59', {minutes: 59}),
          privateView('3k55', {minutes: 55}),
        ],
      }
      const calls = prism.timeline.length
      const skipped = await api.fetch({
        cursor: undefined,
        since: res.startCursor,
        limit: 100,
      })
      expect(prism.timeline).toHaveLength(calls)
      expect(markerOf(skipped).walk?.outcome).toBe('none')

      // A 2xx from another private read brings the retry forward.
      await getPrivatePosts(prism.client, [privateUri('3k59')])
      const next = await api.fetch({
        cursor: undefined,
        since: res.startCursor,
        limit: 100,
      })
      expect(prism.timeline.length).toBeGreaterThan(calls)
      expect(rkeys(next.feed)).toEqual(['3k59'])
      expect(markerOf(next).held).toBeUndefined()
    })

    it('calls prism again at the first check after retryAt passes (F-10)', async () => {
      const {api, prism, since} = await firstPage(undefined, {
        'since:S0': {feed: [], cursor: 'S0', startCursor: 'S0'},
      })
      nextCheck()
      prism.pages[''] = 'fail'
      await api.fetch({cursor: undefined, since, limit: 100})
      const calls = prism.timeline.length
      await api.fetch({cursor: undefined, since, limit: 100})
      expect(prism.timeline).toHaveLength(calls)
      clock = getPrismHealth(DID).retryAt + 1
      await api.fetch({cursor: undefined, since, limit: 100})
      expect(prism.timeline.length).toBeGreaterThan(calls)
    })

    it('offers nothing and keeps priv when the newest head item is gone (F-6)', async () => {
      const {api, prism, since, first} = await firstPage(undefined, {
        'since:S0': {feed: [], cursor: 'S0', startCursor: 'S0'},
      })
      nextCheck()
      prism.pages[''] = {feed: [other('3k45', 45)]}
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(res.feed).toEqual([])
      expect(markerOf(res).priv).toEqual(markerOf(first).priv)
    })

    it('offers each item at most once: seen, pending and its confirmed copy, a repost (F-7)', async () => {
      const {api, prism, since} = await firstPage(undefined, {
        'since:S0': {feed: [], cursor: 'S0', startCursor: 'S0'},
      })
      nextCheck()
      addPending('3kpend', 58)
      const repost = {
        ...other('3k57', 57),
        reason: {
          $type: 'app.bsky.feed.defs#reasonRepost',
          by: {did: DID, handle: 'author.test'},
          uri: `at://${DID}/app.bsky.feed.repost/3krepost`,
          indexedAt: at(59),
        },
      }
      prism.pages[''] = {
        feed: [repost, other('3k57', 57), privateView('3k55', {minutes: 55})],
      }
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(rkeys(res.feed)).toEqual(['3k57', '3kpend', '3k57'])
      expect(res.feed[0].reason).toBeDefined()

      // The pending post confirmed: nothing new.
      nextCheck()
      prism.pages[''] = {
        feed: [
          repost,
          privateView('3kpend', {minutes: 58}),
          other('3k57', 57),
          privateView('3k55', {minutes: 55}),
        ],
      }
      const again = await api.fetch({
        cursor: undefined,
        since: res.startCursor,
        limit: 100,
      })
      expect(again.feed).toEqual([])
    })

    it('passes a plain since and Discover through (F-8)', async () => {
      const {api, stock} = await firstPage(undefined, {
        'since:plain': {feed: [publicItem('p58', 58)], cursor: 'plain'},
      })
      const res = await api.fetch({
        cursor: undefined,
        since: 'plain',
        limit: 100,
      })
      expect(rkeys(res.feed)).toEqual(['p58'])
      expect(res.startCursor).toBeUndefined()
      expect(stock.calls.at(-1)).toBe('since:plain')
    })

    it('offers a late item once, never a fast author’s twice, and only inside the window (F-14)', async () => {
      const {api, prism, since} = await firstPage(
        {
          '': {
            feed: [
              privateView('3kfast', {minutes: 63}),
              privateView('3k55', {minutes: 55}),
            ],
          },
        },
        {'since:S0': {feed: [], cursor: 'S0', startCursor: 'S0'}},
      )
      // priv is capped at 60, so the floor is 50.
      expect(markerOf({feed: [], startCursor: since}).floor).toBe(T(50))
      nextCheck()
      prism.pages[''] = {
        feed: [
          privateView('3kfast', {minutes: 63}),
          privateView('3k55', {minutes: 55}),
          // Late, older than priv: 8 minutes below it.
          other('3k52', 52),
          // 12 minutes below priv: below the floor.
          other('3k48', 48),
        ],
      }
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(rkeys(res.feed)).toEqual(['3k52'])
      nextCheck()
      const again = await api.fetch({
        cursor: undefined,
        since: res.startCursor,
        limit: 100,
      })
      expect(again.feed).toEqual([])
    })

    it('keeps at most 200 seen keys, raising the floor past those it drops, on a held marker too (F-14)', async () => {
      const seen: [string, number][] = Array.from({length: 250}, (_, i) => [
        privateUri(`3k${String(i).padStart(3, '0')}`),
        T(10) + i * 1000,
      ])
      for (const held of [undefined, true as const]) {
        const guarded = guardMergeStart({
          pub: 'S0',
          priv: {time: T(20), uri: ''},
          floor: T(0),
          seen,
          ...(held ? {held} : {}),
        })
        expect(guarded.seen).toHaveLength(PRIVATE_SEEN_MAX)
        expect(guarded.floor).toBe(T(10) + 49 * 1000)
        expect(guarded.held).toBe(held)
      }
      // A post missed below the raised floor is not offered by a check.
      const {api, prism} = await firstPage(undefined, {
        'since:S0': {feed: [], cursor: 'S0', startCursor: 'S0'},
      })
      nextCheck()
      prism.pages[''] = {feed: [other('3kmissed', 10.5)]}
      const res = await api.fetch({
        cursor: undefined,
        since: encodeMergeStart({
          pub: 'S0',
          priv: {time: T(20), uri: ''},
          floor: T(0),
          seen,
          held: true,
        }),
        limit: 100,
      })
      expect(res.feed).toEqual([])
    })

    it('holds on a degraded answer, and the next clean one offers what was missed (F-15)', async () => {
      const {api, prism, since, first} = await firstPage(undefined, {
        'since:S0': {feed: [], cursor: 'S0', startCursor: 'S0'},
      })
      nextCheck()
      prism.pages[''] = {
        feed: [
          privateView('3k59', {minutes: 59}),
          privateView('3k55', {minutes: 55}),
        ],
        degraded: true,
      }
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(rkeys(res.feed)).toEqual(['3k59'])
      const held = markerOf(res)
      expect(held.held).toBe(true)
      expect(held.floor).toBe(markerOf(first).floor)
      expect(held.walk?.outcome).toBe('degraded')

      nextCheck()
      prism.pages[''] = {
        feed: [
          privateView('3k59', {minutes: 59}),
          other('3k58', 58),
          privateView('3k55', {minutes: 55}),
        ],
      }
      const clean = await api.fetch({
        cursor: undefined,
        since: res.startCursor,
        limit: 100,
      })
      expect(rkeys(clean.feed)).toEqual(['3k58'])
      expect(markerOf(clean).held).toBeUndefined()
    })

    it('holds on a suspect miss of a seen own post; a real one holds nothing and leaves seen (F-15)', async () => {
      const {api, prism, since} = await firstPage(undefined, {
        'since:S0': {feed: [], cursor: 'S0', startCursor: 'S0'},
      })
      nextCheck()
      // 3k55, the reader's own and seen, is left out of a head that covers it.
      prism.pages[''] = {feed: [other('3k45', 45)]}
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(missVerdict(DID, privateUri('3k55'))).toBe('suspect')
      expect(markerOf(res).held).toBe(true)

      // The PDS says it is gone: the next miss is real.
      pdsState = 'absent'
      resetKnown()
      nextCheck()
      const first = await api.fetch({cursor: undefined, since, limit: 100})
      expect(markerOf(first).held).toBe(true)
      await settle()
      nextCheck()
      const real = await api.fetch({cursor: undefined, since, limit: 100})
      expect(missVerdict(DID, privateUri('3k55'))).toBe('real')
      expect(markerOf(real).held).toBeUndefined()
      expect(seenKeys(markerOf(real))).not.toContain('3k55')
    })
  })

  describe('the merged peek (F-9)', () => {
    it('returns the newest of public, private and pending', async () => {
      const latestPublic = publicItem('p58', 58)
      const stock = liveStock({}, () => Promise.resolve(latestPublic as never))
      const prism = livePrism({
        '': {feed: [other('3k59', 59), other('3k57', 57)]},
      })
      const api = liveMerged(stock, prism)
      expect((await api.peekLatest())?.post.uri).toBe(
        privateUri('3k59', OTHER_DID),
      )

      addPending('3kpend', 59.5)
      expect((await api.peekLatest())?.post.uri).toBe(privateUri('3kpend'))
    })

    it('follows a short head page with a cursor once', async () => {
      const stock = liveStock({})
      const prism = livePrism({
        '': {feed: [], cursor: 'c1'},
        c1: {feed: [other('3k59', 59)], cursor: 'c2'},
      })
      const api = liveMerged(stock, prism)
      expect((await api.peekLatest())?.post.uri).toBe(
        privateUri('3k59', OTHER_DID),
      )
      expect(prism.timeline).toEqual(['', 'c1'])
    })

    it('gives the public or pending post when prism fails', async () => {
      const latestPublic = publicItem('p58', 58)
      const stock = liveStock({}, () => Promise.resolve(latestPublic as never))
      const prism = livePrism({'': 'fail'})
      const api = liveMerged(stock, prism)
      expect((await api.peekLatest())?.post.uri).toBe(latestPublic.post.uri)
      addPending('3kpend', 59)
      expect((await api.peekLatest())?.post.uri).toBe(privateUri('3kpend'))
    })

    it('answers at once when public posts already differ, and waits for the head when they do not', async () => {
      const latestPublic = publicItem('p58', 58)
      const stock = liveStock({}, () => Promise.resolve(latestPublic as never))
      let release!: () => void
      const prism = livePrism({
        '': () =>
          new Promise<Reply>(resolve => {
            release = () =>
              resolve({status: 200, body: {feed: [other('3k59', 59)]}})
          }),
      })
      const api = liveMerged(stock, prism)
      const differs = await api.peekLatest({isCurrent: () => false})
      expect(differs?.post.uri).toBe(latestPublic.post.uri)

      const waiting = api.peekLatest({
        isCurrent: item => item.post.uri === latestPublic.post.uri,
      })
      while (!release) await new Promise(r => setTimeout(r, 0))
      release()
      expect((await waiting)?.post.uri).toBe(privateUri('3k59', OTHER_DID))
    })
  })

  describe('the head view cache (F-19)', () => {
    function profileCalls(appview: ReturnType<typeof fakeAppview>) {
      return appview.calls.filter(c => c.nsid === 'app.bsky.actor.getProfiles')
        .length
    }

    it('adapts an unchanged head once: ten checks, ten getTimeline, no getProfiles', async () => {
      const {api, prism, appview} = await firstPage({
        '': {feed: [privateView('3k55', {minutes: 55})]},
      })
      const profiles = profileCalls(appview)
      const timeline = prism.timeline.length
      for (let i = 0; i < 10; i++) {
        nextCheck(16_000)
        await api.peekLatest()
      }
      expect(prism.timeline.length - timeline).toBe(10)
      expect(profileCalls(appview)).toBe(profiles)
      expect(prism.getPosts).toEqual([])
    })

    it('adapts a new reply to a parent outside the head once, one getPosts for peek and since together', async () => {
      const parent = other('3kparent', 20)
      const {api, prism, since} = await firstPage(undefined, {
        'since:S0': {feed: [], cursor: 'S0', startCursor: 'S0'},
      })
      prism.pages[''] = {
        feed: [
          other('3k59', 59, {
            reply: {
              root: {uri: parent.uri, cid: RECORD_CID},
              parent: {uri: parent.uri, cid: RECORD_CID},
            },
          }),
          privateView('3k55', {minutes: 55}),
        ],
      }
      nextCheck()
      const peeked = await api.peekLatest()
      expect(peeked?.post.uri).toBe(privateUri('3k59', OTHER_DID))
      const res = await api.fetch({cursor: undefined, since, limit: 100})
      expect(rkeys(res.feed)).toEqual(['3k59'])
      expect(prism.getPosts).toHaveLength(1)
    })

    it('adapts three new head items in one call', async () => {
      const {api, prism, appview} = await firstPage()
      const profiles = profileCalls(appview)
      nextCheck()
      prism.pages[''] = {
        feed: [
          other('3k59', 59),
          other('3k58', 58),
          other('3k57', 57),
          privateView('3k55', {minutes: 55}),
        ],
      }
      await api.peekLatest()
      expect(profileCalls(appview)).toBe(profiles + 1)
    })

    it('is cleared by any fetch from the top', async () => {
      const {api, prism} = await firstPage()
      await api.peekLatest()
      const timeline = prism.timeline.length
      // Inside the memo's life, a peek reads nothing.
      await api.peekLatest()
      expect(prism.timeline).toHaveLength(timeline)
      // A refetch of the top page clears it, as refreshFromTop does.
      await api.fetch({cursor: undefined, limit: 30})
      await api.peekLatest()
      expect(prism.timeline).toHaveLength(timeline + 2)
    })

    it('does not reuse a pending post’s view for its confirmed copy', async () => {
      addPending('3kpend', 40)
      // The pending post is left in the first page's cursor, below p50.
      const {api, prism, appview, first} = await firstPage(
        {'': {feed: []}},
        {pub1: {feed: [publicItem('p30', 30)]}},
      )
      prism.pages[''] = {feed: [privateView('3kpend', {minutes: 40})]}
      await api.peekLatest()
      // The next page adapts the pending copy, under the same head key.
      const next = await api.fetch({cursor: first.cursor, limit: 30})
      expect(rkeys(next.feed)).toEqual(['3kpend', 'p30'])
      const profiles = profileCalls(appview)
      // The confirmed copy in the head is adapted afresh, not from the pending view.
      await api.peekLatest()
      expect(profileCalls(appview)).toBe(profiles + 1)
    })
  })

  describe('the staged page (F-13, F-18)', () => {
    const SINCE = encodeMergeStart({
      pub: 'S0',
      priv: {time: T(55), uri: ''},
      floor: T(45),
      seen: [],
    })

    function rowsOf(views: PrivateView[]) {
      return toFeedViewPosts(
        views.map(view => ({view})),
        {prism: fakePrism().client, appview: fakeAppview().client},
      )
    }

    async function stagedPage() {
      const feed = await rowsOf([
        privateView('3kown', {minutes: 58}),
        other('3kother', 57),
      ])
      return {
        feed: [publicItem('p59', 59) as never, ...feed],
        since: SINCE,
        startCursor: encodeMergeStart({
          pub: 'S1',
          priv: {time: T(59), uri: ''},
          floor: T(49),
          seen: [
            [privateUri('3kown'), T(58)],
            [privateUri('3kother', OTHER_DID), T(57)],
          ],
        }),
        fetchedAt: 1234,
      }
    }

    function replacement(walk: MergeStartWalk, feed: unknown[] = []) {
      return {
        feed: feed as app.bsky.feed.defs.FeedViewPost[],
        startCursor: encodeMergeStart({
          pub: 'S2',
          priv: {time: T(60), uri: ''},
          floor: T(50),
          seen: [],
          ...(walk.outcome === 'answered' ? {} : {held: true as const}),
          walk,
        }),
      }
    }

    it('after a walk with no answer: carries the own row with no noteMiss, drops another author’s, marker held', async () => {
      const staged = await stagedPage()
      const page = replacement({outcome: 'none', did: DID, seq: 0}, [
        publicItem('p61', 61),
      ])
      const judged = judgeStaged(staged, page, {did: DID})
      expect(judged.dropped).toBe(true)
      expect(judged.droppedKeys).toEqual([privateUri('3kother', OTHER_DID)])
      expect(rkeys(judged.carry)).toEqual(['3kown'])
      expect(missVerdict(DID, privateUri('3kown'))).toBe('unknown')
      // The kept page loses the dropped key from seen and is held at since.
      const kept = decodeMergeStart(judged.kept.startCursor)!
      expect(seenKeys(kept)).toEqual(['3kown'])
      expect(kept.held).toBe(true)
      expect(kept.floor).toBe(T(45))
      expect(rkeys(judged.kept.feed)).toEqual(['p59', '3kown'])

      const carried = carryStagedPrivate(judged, page)
      expect(rkeys(carried.feed)).toEqual(['p61', '3kown'])
      expect(
        (carried.feed[1].post as {horizonFromCache?: number}).horizonFromCache,
      ).toBe(1234)
      expect(isHeldMarker(carried.startCursor)).toBe(true)
    })

    it('after a clean answer that lacks them: another author’s row is dropped and holds nothing; the own one is carried, suspect, and holds', async () => {
      const staged = await stagedPage()
      const page = replacement({outcome: 'answered', did: DID, seq: 1})
      const judged = judgeStaged(staged, page, {did: DID})
      expect(judged.droppedKeys).toEqual([privateUri('3kother', OTHER_DID)])
      expect(rkeys(judged.carry)).toEqual(['3kown'])
      expect(judged.hold).toBe(true)
      expect(missVerdict(DID, privateUri('3kown'))).toBe('suspect')
      expect(isSyncing(DID, privateUri('3kown'))).toBe(true)
      // Only another author's row went: the kept marker is not held.
      expect(isHeldMarker(judged.kept.startCursor)).toBe(false)

      const carried = carryStagedPrivate(judged, {
        ...page,
        feed: [publicItem('p61', 61) as never],
      })
      const marker = decodeMergeStart(carried.startCursor)!
      expect(marker.held).toBe(true)
      expect(marker.priv.time).toBe(T(55))
      expect(marker.floor).toBe(T(45))
      expect(seenKeys(marker)).toEqual(['3kown'])
    })

    it('drops an own row once the PDS says it is gone, holding nothing', async () => {
      const staged = await stagedPage()
      pdsState = 'absent'
      judgeStaged(
        staged,
        replacement({outcome: 'answered', did: DID, seq: 1}),
        {
          did: DID,
        },
      )
      await settle()
      const judged = judgeStaged(
        staged,
        replacement({outcome: 'answered', did: DID, seq: 2}),
        {did: DID},
      )
      expect(judged.droppedKeys).toContain(privateUri('3kown'))
      expect(judged.carry).toEqual([])
      expect(judged.hold).toBe(false)
    })

    it('a degraded answer drops another author’s row and holds the kept marker', async () => {
      const staged = await stagedPage()
      const judged = judgeStaged(
        staged,
        replacement({outcome: 'degraded', did: DID, seq: 1, signalled: true}),
        {did: DID},
      )
      expect(judged.droppedKeys).toEqual([privateUri('3kother', OTHER_DID)])
      expect(isHeldMarker(judged.kept.startCursor)).toBe(true)
    })

    it('leaves a row the answer served, and a row below the span the walk covered', async () => {
      const staged = await stagedPage()
      const [served] = await rowsOf([other('3kother', 57)])
      const judged = judgeStaged(
        staged,
        // The walk stopped above the own row (58).
        replacement({outcome: 'answered', did: DID, seq: 1, low: T(58.5)}, [
          served,
        ]),
        {did: DID},
      )
      expect(judged.dropped).toBe(false)
      expect(judged.carry).toEqual([])
      expect(missVerdict(DID, privateUri('3kown'))).toBe('unknown')
    })

    it('carries an own row still pending with no noteMiss', async () => {
      addPending('3kown', 58)
      const staged = await stagedPage()
      const judged = judgeStaged(
        staged,
        replacement({outcome: 'answered', did: DID, seq: 1}),
        {did: DID},
      )
      expect(rkeys(judged.carry)).toEqual(['3kown'])
      expect(judged.hold).toBe(false)
      expect(missVerdict(DID, privateUri('3kown'))).toBe('unknown')
    })

    it('judges nothing against a plain since', async () => {
      const staged = {...(await stagedPage()), since: 'plain'}
      const judged = judgeStaged(
        staged,
        replacement({outcome: 'answered', did: DID, seq: 1}),
        {did: DID},
      )
      expect(judged.kept).toBe(staged)
      expect(judged.dropped).toBe(false)
    })
  })

  describe('carryGapBoundary (F-20)', () => {
    it('takes the boundary run from the lower page’s cursor when it has no public row', () => {
      const state = initialMergeState()
      state.pub.buf = [
        publicItem('b1', 50),
        publicItem('b2', 50),
        publicItem('b3', 49),
      ] as never
      const flagged = encodeMergeCursor({...state, resumesAtBoundary: true})
      const upper = {feed: [publicItem('p52', 52)] as never[]}
      const lower = {
        feed: [{post: privateView('3k51', {minutes: 51})}] as never[],
        cursor: encodeMergeCursor(state),
      }
      expect(rkeys(carryGapBoundary(flagged, upper, lower).feed)).toEqual([
        'p52',
        'b1',
        'b2',
      ])
      expect(
        carryGapBoundary(flagged, upper, {...lower, cursor: 'plain'}),
      ).toBe(upper)
      expect(
        carryGapBoundary(flagged, upper, {...lower, cursor: undefined}),
      ).toBe(upper)
    })
  })
})
