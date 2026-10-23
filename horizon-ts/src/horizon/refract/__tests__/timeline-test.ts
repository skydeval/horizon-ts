import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; the merge cursor needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  REFRACT: true,
}))
const mockMembership = {state: 'member'}
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => mockMembership.state,
  subscribeMembership: () => () => {},
  isPrivateMember: () => mockMembership.state === 'member',
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

import {FALLBACK_MARKER_POST} from '#/features/followingV2/home/api/home'
import {
  type FeedAPI,
  type FeedAPIResponse,
} from '#/features/followingV2/home/api/types'
import {carryGapBoundary, newestPublicRow} from '#/horizon/private/feed/carry'
import {
  encodeMergeCursor,
  initialMergeState,
} from '#/horizon/private/feed/cursor'
import {PP_COLLECTION} from '#/horizon/private/uri'
import {
  RF_READER_DID,
  RF_STOCK_DID,
  rfPost,
  rfProfileBasic,
  rfUri,
} from '#/horizon/refract/fixtures'
import {
  prewarmRefractTimeline,
  resetRefractTimeline,
  withRefractTimeline,
} from '#/horizon/refract/timeline'
import {type app} from '#/lexicons'
import {deferred, type Harness, setupRefract} from './harness'

/*
 * Restored items in a member's Following (RF-B7): `refract.getTimeline`'s
 * restored posts and reposts of restored posts merged into stock's pages by
 * time, from a pre-warmed store, never holding a page. Synthetic fixtures
 * only.
 */

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FOLLOWED_DID = 'did:plc:rfxfollowed00000000000000001'

function at(hour: number, minute = 0) {
  return `2026-10-23T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
}

function stockRow(rkey: string, time: string): FeedViewPost {
  return {
    post: rfPost(rkey, {did: RF_STOCK_DID, restored: false, createdAt: time}),
  } as unknown as FeedViewPost
}

function privateRow(rkey: string, time: string): FeedViewPost {
  const post = rfPost(rkey, {
    did: RF_READER_DID,
    restored: false,
    createdAt: time,
  })
  return {
    post: {...post, uri: `at://${RF_READER_DID}/${PP_COLLECTION}/${rkey}`},
  } as unknown as FeedViewPost
}

/** A restored post by a restored account the member follows. */
function restoredPost(rkey: string, time: string) {
  return {post: rfPost(rkey, {createdAt: time})}
}

/** A followed account's repost of a restored post. */
function restoredRepost(
  rkey: string,
  repostRkey: string,
  time: string,
  by: string = FOLLOWED_DID,
) {
  return {
    post: rfPost(rkey, {createdAt: at(1)}),
    reason: {
      $type: 'app.bsky.feed.defs#reasonRepost',
      by: rfProfileBasic(by, {restored: false}),
      uri: `at://${by}/app.bsky.feed.repost/${repostRkey}`,
      cid: CID,
      indexedAt: time,
    },
  }
}

type Pages = Record<string, FeedAPIResponse>

/** Stock's Following: 10:00 and 09:00, then 08:00 and 07:00, then 06:00. */
function stockPages(): Pages {
  return {
    top: {
      feed: [stockRow('s10', at(10)), stockRow('s9', at(9))],
      cursor: 'c1',
      startCursor: 'start-top',
    },
    c1: {
      feed: [stockRow('s8', at(8)), stockRow('s7', at(7))],
      cursor: 'c2',
    },
    c2: {feed: [stockRow('s6', at(6))]},
  }
}

function inner(
  pages: Pages,
  {peek}: {peek?: () => Promise<FeedViewPost | undefined>} = {},
): FeedAPI & {fetch: jest.Mock; peekLatest: jest.Mock} {
  return {
    peekLatest: jest.fn(
      peek ?? (() => Promise.resolve(pages.top.feed[0])),
    ),
    fetch: jest.fn(
      ({cursor, since}: {cursor: string | undefined; since?: string}) =>
        Promise.resolve(
          pages[since !== undefined ? `since:${since}` : (cursor ?? 'top')] ?? {
            feed: [],
          },
        ),
    ),
  } as never
}

function keys(feed: FeedViewPost[]) {
  return feed.map(item => {
    const reason = item.reason as {by?: {did: string}} | undefined
    return reason?.by ? `${item.post.uri} by ${reason.by.did}` : item.post.uri
  })
}

let h: Harness

function timelineCalls() {
  return h.calls.filter(
    call => call.method === 'app.nearhorizon.refract.getTimeline',
  )
}

/** Answer `getTimeline` with `feed` (and `cursor`). */
function answerTimeline(feed: unknown[], cursor?: string) {
  h.respond(call =>
    call.method === 'app.nearhorizon.refract.getTimeline'
      ? {feed, ...(cursor ? {cursor} : {}), servedAs: 'member'}
      : {profiles: [], posts: [], pending: []},
  )
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false
  promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  for (let i = 0; i < 50 && !done; i++) {
    await jest.advanceTimersByTimeAsync(50)
  }
  return promise
}

async function warm() {
  prewarmRefractTimeline()
  await jest.advanceTimersByTimeAsync(100)
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(at(12)))
  mockMembership.state = 'member'
  h = setupRefract()
  resetRefractTimeline()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('restored items in Following', () => {
  it('puts a followed account’s repost of a restored post in its place, on the right page', async () => {
    answerTimeline([
      restoredPost('rf930', at(9, 30)),
      restoredRepost('rf1', 'r830', at(8, 30)),
    ])
    await warm()
    const pages = stockPages()
    const api = withRefractTimeline('following', inner(pages))
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(keys(top.feed)).toEqual([
      rfUri('s10', RF_STOCK_DID),
      rfUri('rf930'),
      rfUri('s9', RF_STOCK_DID),
    ])
    // Stock's cursors pass through.
    expect(top.cursor).toBe('c1')
    expect(top.startCursor).toBe('start-top')
    const next = await settle(api.fetch({cursor: top.cursor, limit: 30}))
    expect(keys(next.feed)).toEqual([
      `${rfUri('rf1')} by ${FOLLOWED_DID}`,
      rfUri('s8', RF_STOCK_DID),
      rfUri('s7', RF_STOCK_DID),
    ])
    expect(next.feed[0].reason).toMatchObject({
      $type: 'app.bsky.feed.defs#reasonRepost',
      uri: `at://${FOLLOWED_DID}/app.bsky.feed.repost/r830`,
      indexedAt: at(8, 30),
    })
    const last = await settle(api.fetch({cursor: next.cursor, limit: 30}))
    expect(keys(last.feed)).toEqual([rfUri('s6', RF_STOCK_DID)])
    // The prewarm's one read; the top page's head read shares it.
    expect(timelineCalls()).toHaveLength(1)
  })

  it('places the member’s own repost and a restored post with an old date by their time', async () => {
    answerTimeline([
      restoredRepost('rf1', 'own', at(9, 45), RF_READER_DID),
      restoredPost('rfold', at(7, 30)),
    ])
    await warm()
    const api = withRefractTimeline('following', inner(stockPages()))
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(keys(top.feed)).toEqual([
      rfUri('s10', RF_STOCK_DID),
      `${rfUri('rf1')} by ${RF_READER_DID}`,
      rfUri('s9', RF_STOCK_DID),
    ])
    const next = await settle(api.fetch({cursor: top.cursor, limit: 30}))
    expect(keys(next.feed)).toEqual([
      rfUri('s8', RF_STOCK_DID),
      rfUri('rfold'),
      rfUri('s7', RF_STOCK_DID),
    ])
  })

  it('never holds stock’s page: a head that hasn’t landed leaves the page stock’s, and the next page takes the span', async () => {
    const head = deferred<unknown>()
    h.respond(call =>
      call.method === 'app.nearhorizon.refract.getTimeline'
        ? head.promise
        : {profiles: [], posts: [], pending: []},
    )
    const pages = stockPages()
    const stock = inner(pages)
    const api = withRefractTimeline('following', stock)
    let page: FeedAPIResponse | undefined
    void api.fetch({cursor: undefined, limit: 30}).then(res => {
      page = res
    })
    await jest.advanceTimersByTimeAsync(0)
    // Answered as soon as stock answered, with refract still out.
    expect(page).toBeDefined()
    expect(page?.feed).toBe(pages.top.feed)
    expect(timelineCalls()).toHaveLength(1)
    head.resolve({
      feed: [
        restoredPost('rf930', at(9, 30)),
        restoredRepost('rf1', 'r830', at(8, 30)),
      ],
    })
    await jest.advanceTimersByTimeAsync(10)
    // The span the top didn't cover goes to the next page: late, never lost.
    const next = await settle(api.fetch({cursor: page!.cursor, limit: 30}))
    expect(keys(next.feed)).toEqual([
      rfUri('rf930'),
      `${rfUri('rf1')} by ${FOLLOWED_DID}`,
      rfUri('s8', RF_STOCK_DID),
      rfUri('s7', RF_STOCK_DID),
    ])
    // A refresh from the top has it in place.
    const again = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(keys(again.feed)).toEqual([
      rfUri('s10', RF_STOCK_DID),
      rfUri('rf930'),
      rfUri('s9', RF_STOCK_DID),
    ])
  })

  it('a refract failure leaves every page as stock sent it', async () => {
    h.respond(() => {
      throw new Error('prism down')
    })
    await warm()
    const pages = stockPages()
    const api = withRefractTimeline('following', inner(pages))
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(top).toBe(pages.top)
    const next = await settle(api.fetch({cursor: top.cursor, limit: 30}))
    expect(next).toBe(pages.c1)
  })

  it('dedupes against rows the page already has', async () => {
    const item = restoredPost('rf930', at(9, 30))
    answerTimeline([item])
    await warm()
    const pages = stockPages()
    pages.top.feed.splice(1, 0, item as never)
    const api = withRefractTimeline('following', inner(pages))
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(keys(top.feed)).toEqual([
      rfUri('s10', RF_STOCK_DID),
      rfUri('rf930'),
      rfUri('s9', RF_STOCK_DID),
    ])
  })

  it('keeps restored items above the Discover marker', async () => {
    answerTimeline([restoredPost('rf1', at(5))])
    await warm()
    const pages: Pages = {
      top: {
        feed: [
          stockRow('s9', at(9)),
          FALLBACK_MARKER_POST,
          stockRow('d1', at(11)),
        ],
        cursor: 'discover-1',
        source: 'discover',
      },
    }
    const api = withRefractTimeline('following', inner(pages))
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(keys(top.feed)).toEqual([
      rfUri('s9', RF_STOCK_DID),
      rfUri('rf1'),
      FALLBACK_MARKER_POST.post.uri,
      rfUri('d1', RF_STOCK_DID),
    ])
    // A Discover page takes nothing.
    const discover = await settle(
      api.fetch({cursor: 'discover-1', source: 'discover', limit: 30}),
    )
    expect(discover.feed).toEqual([])
  })

  it('an empty since page carries newer items, echoes since, and is written', async () => {
    answerTimeline([restoredPost('rf930', at(9, 30))])
    await warm()
    const pages = stockPages()
    const api = withRefractTimeline('following', inner(pages))
    await settle(api.fetch({cursor: undefined, limit: 30}))
    // A newer restored post arrives; stock has nothing new.
    jest.setSystemTime(Date.now() + 60_000)
    answerTimeline([
      restoredPost('rf1130', at(11, 30)),
      restoredPost('rf930', at(9, 30)),
    ])
    await warm()
    const since = await settle(
      api.fetch({cursor: undefined, since: 'start-top', limit: 30}),
    )
    expect(keys(since.feed)).toEqual([rfUri('rf1130')])
    expect(since.cursor).toBe('start-top')
    expect(since.startCursor).toBe('start-top')
  })
})

describe('the peek', () => {
  it('reports a restored item on top, so the check doesn’t prepend for nothing', async () => {
    answerTimeline([restoredPost('rf1030', at(10, 30))])
    await warm()
    const api = withRefractTimeline('following', inner(stockPages()))
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(top.feed[0].post.uri).toBe(rfUri('rf1030'))
    const latest = await settle(api.peekLatest())
    expect(latest?.post.uri).toBe(rfUri('rf1030'))
  })

  it('answers at once when public posts already differ', async () => {
    const head = deferred<unknown>()
    h.respond(() => head.promise)
    const pages = stockPages()
    const api = withRefractTimeline('following', inner(pages))
    let latest: FeedViewPost | undefined
    void api.peekLatest({isCurrent: () => false}).then(item => (latest = item))
    await jest.advanceTimersByTimeAsync(0)
    expect(latest).toBe(pages.top.feed[0])
  })

  it('waits at most 500 ms for the head', async () => {
    h.respond(() => new Promise(() => {}))
    const pages = stockPages()
    const api = withRefractTimeline('following', inner(pages))
    let latest: FeedViewPost | undefined
    void api.peekLatest().then(item => (latest = item))
    await jest.advanceTimersByTimeAsync(400)
    expect(latest).toBeUndefined()
    await jest.advanceTimersByTimeAsync(200)
    expect(latest).toBe(pages.top.feed[0])
  })
})

describe('visitors and other feeds', () => {
  it('a visitor’s Following is stock’s, with no refract call', async () => {
    mockMembership.state = 'not-member'
    const stock = inner(stockPages())
    expect(withRefractTimeline('following', stock)).toBe(stock)
    prewarmRefractTimeline()
    await jest.advanceTimersByTimeAsync(100)
    expect(timelineCalls()).toHaveLength(0)
  })

  it('other feeds are left as they are', () => {
    const stock = inner(stockPages())
    expect(withRefractTimeline('discover|at://feed', stock)).toBe(stock)
  })
})

describe('with the private merge (item 7)', () => {
  it('places restored items among private rows by time, and keeps the merge’s cursors and flags', async () => {
    answerTimeline([restoredRepost('rf1', 'r915', at(9, 15))])
    await warm()
    const pages: Pages = {
      top: {
        feed: [
          stockRow('s10', at(10)),
          privateRow('p930', at(9, 30)),
          stockRow('s9', at(9)),
        ],
        cursor: 'hz1.merge',
        startCursor: 'hz1s.marker',
        privateDegraded: true,
      } as FeedAPIResponse,
    }
    const api = withRefractTimeline('following', inner(pages))
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(keys(top.feed)).toEqual([
      rfUri('s10', RF_STOCK_DID),
      `at://${RF_READER_DID}/${PP_COLLECTION}/p930`,
      `${rfUri('rf1')} by ${FOLLOWED_DID}`,
      rfUri('s9', RF_STOCK_DID),
    ])
    expect(top.cursor).toBe('hz1.merge')
    expect(top.startCursor).toBe('hz1s.marker')
    expect((top as {privateDegraded?: boolean}).privateDegraded).toBe(true)
  })

  it('the newest public row for the peek skips a restored row on top', async () => {
    answerTimeline([restoredPost('rf1030', at(10, 30))])
    await warm()
    const api = withRefractTimeline('following', inner(stockPages()))
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(top.feed[0].post.uri).toBe(rfUri('rf1030'))
    expect(newestPublicRow([top])?.post.uri).toBe(rfUri('s10', RF_STOCK_DID))
  })

  it('the gap boundary carry takes stock rows only', async () => {
    answerTimeline([restoredPost('rf1030', at(10, 30))])
    await warm()
    const api = withRefractTimeline('following', inner(stockPages()))
    const lower = await settle(api.fetch({cursor: undefined, limit: 30}))
    const state = initialMergeState()
    state.resumesAtBoundary = true
    const upper = {feed: [stockRow('s11', at(11))]}
    const carried = carryGapBoundary(encodeMergeCursor(state), upper, lower)
    expect(keys(carried.feed)).toEqual([
      rfUri('s11', RF_STOCK_DID),
      rfUri('s10', RF_STOCK_DID),
    ])
  })
})
