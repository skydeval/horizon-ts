import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  REFRACT: true,
}))
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  subscribeMembership: () => () => {},
  isPrivateMember: () => true,
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

import {type FeedAPI} from '#/lib/api/feed/types'
import {refractAuthorFeedApi} from '#/horizon/refract/author-feed'
import {
  RF_DID,
  RF_READER_DID,
  RF_STOCK_DID,
  rfFillAnswer,
  rfPost,
  rfProfile,
  rfProfileBasic,
  rfUri,
} from '#/horizon/refract/fixtures'
import {
  type ListRepostRecords,
  OwnRepostsFeedAPI,
  type RepostRecordPage,
} from '#/horizon/refract/own-reposts'
import {putRestoredPost} from '#/horizon/refract/store'
import {
  getCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'
import {type Harness, setupRefract} from './harness'

/*
 * The reader's own reposts of restored posts on their own profile (refract
 * client design 4.1, "Feed tabs"): stock drops them, the reader's own repo
 * records put them back in time order. Synthetic fixtures only.
 */

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function at(hour: number, minute = 0) {
  return `2026-10-23T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
}

function ownPost(rkey: string, createdAt: string): FeedViewPost {
  return {
    post: rfPost(rkey, {did: RF_READER_DID, restored: false, createdAt}),
  } as unknown as FeedViewPost
}

function repostRecord(rkey: string, subject: string, createdAt: string) {
  return {
    uri: `at://${RF_READER_DID}/app.bsky.feed.repost/${rkey}`,
    cid: CID,
    value: {
      $type: 'app.bsky.feed.repost',
      subject: {uri: subject, cid: CID},
      createdAt,
    },
  }
}

/** Stock's two pages: 10:00 and 09:00, then 08:00 and 07:00. */
function stockFeed(): FeedAPI & {fetch: jest.Mock} {
  const pages: Record<string, {feed: FeedViewPost[]; cursor?: string}> = {
    top: {feed: [ownPost('p10', at(10)), ownPost('p9', at(9))], cursor: 'c1'},
    c1: {feed: [ownPost('p8', at(8)), ownPost('p7', at(7))]},
  }
  return {
    peekLatest: () => Promise.resolve(pages.top.feed[0]),
    fetch: jest.fn(({cursor}: {cursor: string | undefined}) =>
      Promise.resolve(pages[cursor ?? 'top']),
    ),
  } as never
}

function lister(pages: RepostRecordPage[]): ListRepostRecords & jest.Mock {
  return jest.fn((cursor: string | undefined) =>
    Promise.resolve(pages[cursor ? Number(cursor) : 0] ?? {records: []}),
  ) as never
}

let h: Harness

beforeEach(() => {
  jest.useFakeTimers()
  h = setupRefract()
})

afterEach(() => {
  jest.useRealTimers()
})

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

function uris(feed: FeedViewPost[]) {
  return feed.map(item =>
    item.reason ? `repost:${item.post.uri}` : item.post.uri,
  )
}

describe('own reposts of restored posts', () => {
  it('puts a repost of a restored post into the own feed in time order', async () => {
    const restored = putRestoredPost(rfPost('rf1') as never)
    const api = new OwnRepostsFeedAPI(
      stockFeed(),
      RF_READER_DID,
      lister([{records: [repostRecord('r1', rfUri('rf1'), at(8, 30))]}]),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(uris(top.feed)).toEqual([
      rfUri('p10', RF_READER_DID),
      rfUri('p9', RF_READER_DID),
    ])
    const next = await settle(api.fetch({cursor: top.cursor, limit: 30}))
    expect(uris(next.feed)).toEqual([
      `repost:${rfUri('rf1')}`,
      rfUri('p8', RF_READER_DID),
      rfUri('p7', RF_READER_DID),
    ])
    const item = next.feed[0]
    // The store's object, so shadows reach it.
    expect(item.post).toBe(restored)
    expect(item.reason).toMatchObject({
      $type: 'app.bsky.feed.defs#reasonRepost',
      by: {did: RF_READER_DID},
      uri: `at://${RF_READER_DID}/app.bsky.feed.repost/r1`,
      indexedAt: at(8, 30),
    })
    expect(h.fills()).toHaveLength(0)
  })

  it('reads an unknown subject from one fill', async () => {
    h.respond(() =>
      rfFillAnswer({
        profiles: [rfProfile()],
        posts: [rfPost('rf1')],
        withheld: [],
      }),
    )
    const api = new OwnRepostsFeedAPI(
      stockFeed(),
      RF_READER_DID,
      lister([{records: [repostRecord('r1', rfUri('rf1'), at(9, 30))]}]),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(uris(top.feed)).toEqual([
      rfUri('p10', RF_READER_DID),
      `repost:${rfUri('rf1')}`,
      rfUri('p9', RF_READER_DID),
    ])
    expect(h.fills()).toHaveLength(1)
  })

  it('leaves a repost stock already shows alone, and asks nothing', async () => {
    const stock = stockFeed()
    const shownRecord = repostRecord('r2', rfUri('s1', RF_STOCK_DID), at(9, 30))
    const page = (await stock.fetch({cursor: undefined, limit: 30})) as {
      feed: FeedViewPost[]
    }
    page.feed.splice(1, 0, {
      post: rfPost('s1', {did: RF_STOCK_DID, restored: false}),
      reason: {
        $type: 'app.bsky.feed.defs#reasonRepost',
        by: rfProfileBasic(RF_READER_DID, {restored: false}),
        uri: shownRecord.uri,
        indexedAt: at(9, 30),
      },
    } as never)
    const api = new OwnRepostsFeedAPI(
      stock,
      RF_READER_DID,
      lister([{records: [shownRecord]}]),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(top.feed).toHaveLength(3)
    expect(h.fills()).toHaveLength(0)
    expect(h.precheckCalls).toHaveLength(0)
  })

  it('an unrepost removes it on the next load from the top', async () => {
    putRestoredPost(rfPost('rf1') as never)
    const records = [repostRecord('r1', rfUri('rf1'), at(9, 30))]
    const list = lister([{records}])
    const first = new OwnRepostsFeedAPI(stockFeed(), RF_READER_DID, list)
    const before = await settle(first.fetch({cursor: undefined, limit: 30}))
    expect(uris(before.feed)).toContain(`repost:${rfUri('rf1')}`)
    // The record is deleted; a load from the top makes a new API.
    records.length = 0
    const second = new OwnRepostsFeedAPI(stockFeed(), RF_READER_DID, list)
    const after = await settle(second.fetch({cursor: undefined, limit: 30}))
    expect(uris(after.feed)).not.toContain(`repost:${rfUri('rf1')}`)
    expect(after.feed).toHaveLength(2)
  })

  it('a failed repo read leaves the page as stock sent it', async () => {
    const api = new OwnRepostsFeedAPI(stockFeed(), RF_READER_DID, () =>
      Promise.reject(new Error('pds down')),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(top.feed).toHaveLength(2)
    expect(top.cursor).toBe('c1')
  })

  it('wraps only the reader’s own reposting tabs', () => {
    const stock = stockFeed()
    publishCurrentClients({
      ...getCurrentClients()!,
      pdsClient: {call: jest.fn()} as never,
    })
    expect(
      refractAuthorFeedApi(`author|${RF_READER_DID}|posts_with_replies`, stock),
    ).toBeInstanceOf(OwnRepostsFeedAPI)
    expect(
      refractAuthorFeedApi(
        `author|${RF_READER_DID}|posts_and_author_threads`,
        stock,
      ),
    ).toBeInstanceOf(OwnRepostsFeedAPI)
    expect(
      refractAuthorFeedApi(`author|${RF_READER_DID}|posts_with_media`, stock),
    ).toBe(stock)
    expect(
      refractAuthorFeedApi(`author|${RF_STOCK_DID}|posts_with_replies`, stock),
    ).toBe(stock)
    expect(
      refractAuthorFeedApi(`author|${RF_DID}|posts_with_replies`, stock),
    ).not.toBeInstanceOf(OwnRepostsFeedAPI)
  })
})
