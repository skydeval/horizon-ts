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

/** The fake PDS of the other profile owner; nothing leaves the process. */
const OWNER_PDS = 'https://pds.owner.example.test'
const mockAuthorPdsUrl = jest.fn<(did: string) => Promise<string | undefined>>()
const mockOwnerClients: unknown[][] = []
const mockOwnerCall = jest.fn<(method: unknown, params: unknown) => unknown>()
jest.mock('#/horizon/private/adapt/pds', () => ({
  ...jest.requireActual<object>('#/horizon/private/adapt/pds'),
  authorPdsUrl: (did: string) => mockAuthorPdsUrl(did),
}))
jest.mock('#/lib/lexClient', () => {
  const actual = jest.requireActual<{
    createLexClient: (...args: unknown[]) => unknown
  }>('#/lib/lexClient')
  return {
    ...actual,
    createLexClient: (...args: unknown[]) => {
      const transport = args[0] as {service?: string} | undefined
      if (transport?.service === OWNER_PDS) {
        mockOwnerClients.push(args)
        return {call: mockOwnerCall}
      }
      return actual.createLexClient(...args)
    },
  }
})

import {type FeedAPI} from '#/lib/api/feed/types'
import {networkAwareFetch} from '#/state/session/network'
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
import {noteRestored} from '#/horizon/refract/marker'
import {
  type ListRepostRecords,
  PROFILE_REPOST_CACHE_MS,
  PROFILE_REPOST_DEADLINE_MS,
  ProfileRepostsFeedAPI,
  type RepostRecordPage,
  resetProfileRepostCache,
} from '#/horizon/refract/profile-reposts'
import {putRestoredPost} from '#/horizon/refract/store'
import {
  getCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {answerPrismFeatures} from '#/horizon/routing/features'
import {type app, com} from '#/lexicons'
import {type Harness, setupRefract} from './harness'

/*
 * A profile owner's reposts of restored posts on their profile (refract
 * client design 4.1, "Feed tabs"): stock drops them, the owner's repo
 * records put them back in time order. On the reader's own profile and on
 * another account's. Synthetic fixtures only: the other owner's PDS is a
 * fake client behind a mocked resolver.
 */

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function at(hour: number, minute = 0) {
  return `2026-10-23T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
}

function ownPost(
  rkey: string,
  createdAt: string,
  did: string = RF_READER_DID,
): FeedViewPost {
  return {
    post: rfPost(rkey, {did, restored: false, createdAt}),
  } as unknown as FeedViewPost
}

function repostRecord(
  rkey: string,
  subject: string,
  createdAt: string,
  did: string = RF_READER_DID,
) {
  return {
    uri: `at://${did}/app.bsky.feed.repost/${rkey}`,
    cid: CID,
    value: {
      $type: 'app.bsky.feed.repost',
      subject: {uri: subject, cid: CID},
      createdAt,
    },
  }
}

/** Stock's two pages: 10:00 and 09:00, then 08:00 and 07:00. */
function stockFeed(did: string = RF_READER_DID): FeedAPI & {fetch: jest.Mock} {
  const pages: Record<string, {feed: FeedViewPost[]; cursor?: string}> = {
    top: {
      feed: [ownPost('p10', at(10), did), ownPost('p9', at(9), did)],
      cursor: 'c1',
    },
    c1: {feed: [ownPost('p8', at(8), did), ownPost('p7', at(7), did)]},
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
  resetProfileRepostCache()
  mockAuthorPdsUrl.mockReset()
  mockAuthorPdsUrl.mockImplementation(() => Promise.resolve(OWNER_PDS))
  mockOwnerClients.length = 0
  mockOwnerCall.mockReset()
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
    const api = new ProfileRepostsFeedAPI(
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
    const api = new ProfileRepostsFeedAPI(
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
    const api = new ProfileRepostsFeedAPI(
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
    const first = new ProfileRepostsFeedAPI(stockFeed(), RF_READER_DID, list)
    const before = await settle(first.fetch({cursor: undefined, limit: 30}))
    expect(uris(before.feed)).toContain(`repost:${rfUri('rf1')}`)
    // The record is deleted; a load from the top makes a new API.
    records.length = 0
    const second = new ProfileRepostsFeedAPI(stockFeed(), RF_READER_DID, list)
    const after = await settle(second.fetch({cursor: undefined, limit: 30}))
    expect(uris(after.feed)).not.toContain(`repost:${rfUri('rf1')}`)
    expect(after.feed).toHaveLength(2)
  })

  it('a failed repo read leaves the page as stock sent it', async () => {
    const api = new ProfileRepostsFeedAPI(stockFeed(), RF_READER_DID, () =>
      Promise.reject(new Error('pds down')),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(top.feed).toHaveLength(2)
    expect(top.cursor).toBe('c1')
  })

  it('wraps the reposting tabs of any profile but a restored one', () => {
    const stock = stockFeed()
    publishCurrentClients({
      ...getCurrentClients()!,
      pdsClient: {call: jest.fn()} as never,
    })
    expect(
      refractAuthorFeedApi(`author|${RF_READER_DID}|posts_with_replies`, stock),
    ).toBeInstanceOf(ProfileRepostsFeedAPI)
    expect(
      refractAuthorFeedApi(
        `author|${RF_READER_DID}|posts_and_author_threads`,
        stock,
      ),
    ).toBeInstanceOf(ProfileRepostsFeedAPI)
    expect(
      refractAuthorFeedApi(`author|${RF_READER_DID}|posts_with_media`, stock),
    ).toBe(stock)
    expect(
      refractAuthorFeedApi(`author|${RF_STOCK_DID}|posts_with_replies`, stock),
    ).toBeInstanceOf(ProfileRepostsFeedAPI)
    expect(
      refractAuthorFeedApi(`author|${RF_STOCK_DID}|posts_with_media`, stock),
    ).toBe(stock)
    // A restored account's tabs already come from prism.
    noteRestored(RF_DID)
    expect(
      refractAuthorFeedApi(`author|${RF_DID}|posts_with_replies`, stock),
    ).not.toBeInstanceOf(ProfileRepostsFeedAPI)
  })

  it('wraps nothing while Refract is off for the reader', () => {
    const stock = stockFeed()
    answerPrismFeatures(RF_READER_DID, ['private'])
    expect(
      refractAuthorFeedApi(`author|${RF_STOCK_DID}|posts_with_replies`, stock),
    ).toBe(stock)
  })
})

describe('another account’s reposts of restored posts', () => {
  function ownerAnswers(records: ReturnType<typeof repostRecord>[]) {
    mockOwnerCall.mockImplementation((method, params) => {
      if (method !== com.atproto.repo.listRecords) {
        return Promise.reject(new Error('unexpected call'))
      }
      expect(params).toMatchObject({
        repo: RF_STOCK_DID,
        collection: 'app.bsky.feed.repost',
      })
      return Promise.resolve({records})
    })
  }

  it('puts the owner’s repost on their profile, by them, read without a session', async () => {
    const restored = putRestoredPost(rfPost('rf1') as never)
    const owner = rfProfileBasic(RF_STOCK_DID, {restored: false})
    h.queryClient.setQueryData(['profile', RF_STOCK_DID], owner)
    ownerAnswers([repostRecord('r1', rfUri('rf1'), at(9, 30), RF_STOCK_DID)])
    const api = refractAuthorFeedApi(
      `author|${RF_STOCK_DID}|posts_with_replies`,
      stockFeed(RF_STOCK_DID),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(uris(top.feed)).toEqual([
      rfUri('p10', RF_STOCK_DID),
      `repost:${rfUri('rf1')}`,
      rfUri('p9', RF_STOCK_DID),
    ])
    expect(top.feed[1].post).toBe(restored)
    expect(top.feed[1].reason).toMatchObject({
      $type: 'app.bsky.feed.defs#reasonRepost',
      by: {did: RF_STOCK_DID, handle: owner.handle},
      uri: `at://${RF_STOCK_DID}/app.bsky.feed.repost/r1`,
      indexedAt: at(9, 30),
    })
    // The owner's PDS from their DID document, and a client with no session.
    expect(mockAuthorPdsUrl).toHaveBeenCalledWith(RF_STOCK_DID)
    expect(mockOwnerClients).toHaveLength(1)
    expect(mockOwnerClients[0][0]).toEqual({
      service: OWNER_PDS,
      fetch: networkAwareFetch,
    })
    expect(h.fills()).toHaveLength(0)
  })

  it('without a profile view, the repost is by the owner from the page', async () => {
    putRestoredPost(rfPost('rf1') as never)
    ownerAnswers([repostRecord('r1', rfUri('rf1'), at(9, 30), RF_STOCK_DID)])
    const api = refractAuthorFeedApi(
      `author|${RF_STOCK_DID}|posts_with_replies`,
      stockFeed(RF_STOCK_DID),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(top.feed[1].reason).toMatchObject({by: {did: RF_STOCK_DID}})
  })

  it('reads the owner’s repo once for both tabs, and again after the cache', async () => {
    putRestoredPost(rfPost('rf1') as never)
    ownerAnswers([repostRecord('r1', rfUri('rf1'), at(9, 30), RF_STOCK_DID)])
    const posts = refractAuthorFeedApi(
      `author|${RF_STOCK_DID}|posts_and_author_threads`,
      stockFeed(RF_STOCK_DID),
    )
    const replies = refractAuthorFeedApi(
      `author|${RF_STOCK_DID}|posts_with_replies`,
      stockFeed(RF_STOCK_DID),
    )
    const [a, b] = await settle(
      Promise.all([
        posts.fetch({cursor: undefined, limit: 30}),
        replies.fetch({cursor: undefined, limit: 30}),
      ]),
    )
    expect(uris(a.feed)).toContain(`repost:${rfUri('rf1')}`)
    expect(uris(b.feed)).toContain(`repost:${rfUri('rf1')}`)
    expect(mockOwnerCall).toHaveBeenCalledTimes(1)
    jest.setSystemTime(Date.now() + PROFILE_REPOST_CACHE_MS + 1)
    const again = refractAuthorFeedApi(
      `author|${RF_STOCK_DID}|posts_with_replies`,
      stockFeed(RF_STOCK_DID),
    )
    await settle(again.fetch({cursor: undefined, limit: 30}))
    expect(mockOwnerCall).toHaveBeenCalledTimes(2)
  })

  it('an unknown PDS leaves the page as stock sent it', async () => {
    putRestoredPost(rfPost('rf1') as never)
    mockAuthorPdsUrl.mockImplementation(() => Promise.resolve(undefined))
    const api = refractAuthorFeedApi(
      `author|${RF_STOCK_DID}|posts_with_replies`,
      stockFeed(RF_STOCK_DID),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(uris(top.feed)).toEqual([
      rfUri('p10', RF_STOCK_DID),
      rfUri('p9', RF_STOCK_DID),
    ])
    expect(top.cursor).toBe('c1')
    expect(mockOwnerClients).toHaveLength(0)
  })

  it('a PDS error leaves the page as stock sent it', async () => {
    putRestoredPost(rfPost('rf1') as never)
    mockOwnerCall.mockImplementation(() =>
      Promise.reject(new Error('pds down')),
    )
    const api = refractAuthorFeedApi(
      `author|${RF_STOCK_DID}|posts_with_replies`,
      stockFeed(RF_STOCK_DID),
    )
    const top = await settle(api.fetch({cursor: undefined, limit: 30}))
    expect(top.feed).toHaveLength(2)
    const next = await settle(api.fetch({cursor: top.cursor, limit: 30}))
    expect(next.feed).toHaveLength(2)
  })

  it('a repo read that hangs gives stock’s page after the deadline', async () => {
    putRestoredPost(rfPost('rf1') as never)
    mockOwnerCall.mockImplementation(() => new Promise(() => {}))
    const api = refractAuthorFeedApi(
      `author|${RF_STOCK_DID}|posts_with_replies`,
      stockFeed(RF_STOCK_DID),
    )
    const done: {page?: Awaited<ReturnType<FeedAPI['fetch']>>} = {}
    void api.fetch({cursor: undefined, limit: 30}).then(page => {
      done.page = page
    })
    await jest.advanceTimersByTimeAsync(PROFILE_REPOST_DEADLINE_MS - 10)
    expect(done.page).toBeUndefined()
    await jest.advanceTimersByTimeAsync(20)
    expect(done.page?.feed).toHaveLength(2)
    expect(done.page?.cursor).toBe('c1')
  })
})
