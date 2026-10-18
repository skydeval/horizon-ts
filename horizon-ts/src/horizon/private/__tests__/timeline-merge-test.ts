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
import {type app} from '#/lexicons'
import {toPostView} from '../adapt/post-view'
import {withPrivateTimeline} from '../feed/timeline-merge'
import {unwrapPrivateQuotes} from '../quotes/resolve'
import {addPendingPost, clearPrivateStores} from '../store'
import {DID, RECORD_CID} from './fixtures'
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
})

describe('withPrivateTimeline', () => {
  it('returns the stock API for other feeds (resolving quotes) and without a private source', () => {
    const {api} = fakeStock({})
    const source = {
      did: DID,
      prism: fakePrism().client,
      appview: fakeAppview().client,
    }
    // With a source the stock API resolves its pages' private quotes.
    expect(
      unwrapPrivateQuotes(
        withPrivateTimeline('author|x|posts_no_replies', source, api),
      ),
    ).toBe(api)
    expect(withPrivateTimeline('following', undefined, api)).toBe(api)
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
    expect(responses[0].startCursor).toBe('start')
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
