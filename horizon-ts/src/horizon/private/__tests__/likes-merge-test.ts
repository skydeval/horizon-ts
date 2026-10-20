import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))

import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'
import {horizonFeedApi} from '../feed/legacy'
import {
  decodeLikesMergeCursor,
  emitLikes,
  initialLikesMergeState,
  type LikeRecordPage,
  PrivateLikesMergeFeedAPI,
} from '../feed/likes-merge'
import {MAX_PAGES_PER_LOAD} from '../feed/paging'
import {unwrapPrivateQuotes} from '../quotes/resolve'
import {clearPrivateStores} from '../store'
import {DID, OTHER_DID, RECORD_CID} from './fixtures'
import {
  fakeAppview,
  fakePrism,
  type PrivateView,
  privateView,
  publicItem,
} from './read-fixtures'

const LIKE = 'app.bsky.feed.like'

/** A like rkey that sorts by `n` (larger is newer). */
const tid = (n: number) => `3k${String(n).padStart(11, '0')}`
const likeUri = (n: number) => `at://${DID}/${LIKE}/${tid(n)}`

/** A stock Likes item: a public post the owner liked at `n`. */
function likedPublic(id: string, n: number): app.bsky.feed.defs.FeedViewPost {
  const item = publicItem(id, 0)
  return {
    ...item,
    post: {...item.post, viewer: {like: likeUri(n)}},
  } as unknown as app.bsky.feed.defs.FeedViewPost
}

/** A like record for `subject` at `n`. */
const likeRecord = (subject: string, n: number) => ({
  uri: likeUri(n),
  value: {
    $type: LIKE,
    subject: {uri: subject, cid: RECORD_CID},
    createdAt: '2026-10-15T10:00:00.000Z',
  },
})

/** A stock feed serving `pages` in order. */
function stockPages(pages: app.bsky.feed.defs.FeedViewPost[][]) {
  const cursors: (string | undefined)[] = []
  const api: FeedAPI = {
    peekLatest: () => Promise.resolve(pages[0]?.[0] as never),
    fetch: ({cursor}): Promise<FeedAPIResponse> => {
      cursors.push(cursor)
      const index = cursor ? Number(cursor) : 0
      return Promise.resolve({
        feed: pages[index] ?? [],
        cursor: index + 1 < pages.length ? String(index + 1) : undefined,
      })
    },
  }
  return {api, cursors}
}

/** The owner's like records, served in `pages`. */
function likePages(pages: ReturnType<typeof likeRecord>[][]) {
  const calls: (string | undefined)[] = []
  const list = (cursor: string | undefined): Promise<LikeRecordPage> => {
    calls.push(cursor)
    const index = cursor ? Number(cursor.slice(1)) : 0
    return Promise.resolve({
      records: pages[index] ?? [],
      cursor: index + 1 < pages.length ? `c${index + 1}` : undefined,
    })
  }
  return {list, calls}
}

function sourceWith(posts: PrivateView[]) {
  const prism = fakePrism({posts})
  const appview = fakeAppview()
  return {
    source: {did: DID, prism: prism.client, appview: appview.client},
    prismCalls: prism.calls,
  }
}

async function drain(api: FeedAPI, from?: string) {
  const pages: string[][] = []
  let cursor: string | undefined = from
  for (let i = 0; i < 40; i++) {
    const res = await api.fetch({cursor, limit: 30})
    pages.push(res.feed.map(item => item.post.uri))
    cursor = res.cursor
    if (!cursor) break
  }
  return pages
}

const priv = (rkey: string) => privateView(rkey, {did: OTHER_DID})

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
})

describe('PrivateLikesMergeFeedAPI (change list item 5)', () => {
  it('merges liked private posts with the stock items in like order', async () => {
    const a = priv('3kprivatea')
    const b = priv('3kprivateb')
    const {source} = sourceWith([a, b])
    const p9 = likedPublic('p9', 9)
    const p6 = likedPublic('p6', 6)
    const p3 = likedPublic('p3', 3)
    const p1 = likedPublic('p1', 1)
    // Stock pages of two; like records newest first, pages of three.
    const stock = stockPages([
      [p9, p6],
      [p3, p1],
    ])
    const likes = likePages([
      [
        likeRecord(p9.post.uri, 9),
        likeRecord(a.uri, 8),
        likeRecord(p6.post.uri, 6),
      ],
      [
        likeRecord(b.uri, 4),
        likeRecord(p3.post.uri, 3),
        likeRecord(p1.post.uri, 1),
      ],
    ])
    const api = new PrivateLikesMergeFeedAPI(stock.api, source, likes.list)
    const all = (await drain(api)).flat()
    expect(all).toEqual([
      p9.post.uri,
      a.uri,
      p6.post.uri,
      b.uri,
      p3.post.uri,
      p1.post.uri,
    ])
    // No repeats, and every stock page read once.
    expect(new Set(all).size).toBe(all.length)
    expect(stock.cursors).toEqual([undefined, '1'])
  })

  it('leaves out private subjects prism does not serve, and public records', async () => {
    const readable = priv('3kreadable')
    const hidden = priv('3khidden')
    const {source} = sourceWith([readable])
    const p5 = likedPublic('p5', 5)
    const stock = stockPages([[p5]])
    const likes = likePages([
      [
        likeRecord(hidden.uri, 7),
        likeRecord(readable.uri, 6),
        likeRecord(p5.post.uri, 5),
      ],
    ])
    const api = new PrivateLikesMergeFeedAPI(stock.api, source, likes.list)
    expect((await drain(api)).flat()).toEqual([readable.uri, p5.post.uri])
  })

  it('does not hold stock items back while like pages name only public posts', async () => {
    const {source, prismCalls} = sourceWith([])
    const items = [9, 8, 7, 6, 5, 4].map(n => likedPublic(`p${n}`, n))
    const stock = stockPages([items.slice(0, 3), items.slice(3)])
    const likes = likePages(
      items.map(item => [
        likeRecord(item.post.uri, Number(item.post.uri.slice(-1))),
      ]),
    )
    const api = new PrivateLikesMergeFeedAPI(stock.api, source, likes.list)
    const first = await api.fetch({cursor: undefined, limit: 30})
    // The first record page sets the floor at 9: only p9 is certain.
    expect(first.feed.map(item => item.post.uri)).toEqual([items[0].post.uri])
    const rest = await drain(api, first.cursor)
    expect([first.feed[0].post.uri, ...rest.flat()]).toEqual(
      items.map(item => item.post.uri),
    )
    // No private subject, so prism is never asked.
    expect(prismCalls).toHaveLength(0)
  })

  it('a stock item below the floor waits for the next record page', () => {
    const state = initialLikesMergeState()
    state.pub.buf.push(likedPublic('p2', 2))
    state.priv.floor = tid(5)
    expect(emitLikes(state).slots).toHaveLength(0)
    state.priv.floor = tid(2)
    expect(emitLikes(state).slots).toHaveLength(1)
  })

  it('reads at most MAX_PAGES_PER_LOAD record pages per load', async () => {
    const {source} = sourceWith([])
    const old = likedPublic('p0', 0)
    const stock = stockPages([[old]])
    // Many newer likes of posts the stock tab no longer has.
    const likes = likePages(
      Array.from({length: 30}, (_, i) => [
        likeRecord(`at://${OTHER_DID}/app.bsky.feed.post/gone${i}`, 100 - i),
      ]),
    )
    const api = new PrivateLikesMergeFeedAPI(stock.api, source, likes.list)
    const res = await api.fetch({cursor: undefined, limit: 30})
    expect(res.feed).toHaveLength(0)
    expect(likes.calls).toHaveLength(MAX_PAGES_PER_LOAD)
    expect(res.cursor).toBeDefined()
    expect(decodeLikesMergeCursor(res.cursor!).pub.buf).toHaveLength(1)
    // The next loads continue and the stock item comes out; nothing is lost.
    expect((await drain(api, res.cursor)).flat()).toEqual([old.post.uri])
  })

  it('continues with the stock items when the like records cannot be read', async () => {
    const {source} = sourceWith([])
    const p2 = likedPublic('p2', 2)
    const p1 = likedPublic('p1', 1)
    const stock = stockPages([[p2, p1]])
    const api = new PrivateLikesMergeFeedAPI(stock.api, source, () =>
      Promise.reject(new Error('PDS down')),
    )
    expect((await drain(api)).flat()).toEqual([p2.post.uri, p1.post.uri])
  })

  it('a stock cursor stays stock', async () => {
    const {source} = sourceWith([])
    const stock = stockPages([[likedPublic('p2', 2)], [likedPublic('p1', 1)]])
    const likes = likePages([[]])
    const api = new PrivateLikesMergeFeedAPI(stock.api, source, likes.list)
    const res = await api.fetch({cursor: '1', limit: 30})
    expect(res.feed.map(item => item.post.uri)).toEqual([
      likedPublic('p1', 1).post.uri,
    ])
    expect(likes.calls).toHaveLength(0)
  })
})

describe('horizonFeedApi for the Likes tab', () => {
  it("merges only the owner's own Likes tab, for a member with a PDS client", () => {
    const {source} = sourceWith([])
    const stock = stockPages([[]])
    publishCurrentClients({
      did: DID,
      handle: 'author.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: {} as never,
    })
    expect(
      unwrapPrivateQuotes(horizonFeedApi(`likes|${DID}`, source, stock.api)),
    ).toBeInstanceOf(PrivateLikesMergeFeedAPI)
    expect(
      unwrapPrivateQuotes(
        horizonFeedApi(`likes|${OTHER_DID}`, source, stock.api),
      ),
    ).toBe(stock.api)
    // A non-member has no source: stock.
    expect(horizonFeedApi(`likes|${DID}`, undefined, stock.api)).toBe(stock.api)
  })
})
