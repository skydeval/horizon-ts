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
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {type app} from '#/lexicons'
import {toPostView} from '../adapt/post-view'
import {keepsPrivatePost, PrivateAuthorMergeFeedAPI} from '../feed/author-merge'
import {horizonFeedApi} from '../feed/legacy'
import {MAX_PAGES_PER_LOAD} from '../feed/paging'
import {unwrapPrivateQuotes} from '../quotes/resolve'
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

/**
 * A stock author feed serving `pages` in order; each call returns the next
 * page, with a cursor while more pages remain.
 */
function stockPages(pages: unknown[][]) {
  const cursors: (string | undefined)[] = []
  const api: FeedAPI = {
    peekLatest: () => Promise.resolve(pages[0]?.[0] as never),
    fetch: ({cursor}): Promise<FeedAPIResponse> => {
      cursors.push(cursor)
      const index = cursor ? Number(cursor) : 0
      const feed = (pages[index] ?? []) as app.bsky.feed.defs.FeedViewPost[]
      return Promise.resolve({
        feed,
        cursor: index + 1 < pages.length ? String(index + 1) : undefined,
      })
    },
  }
  return {api, cursors}
}

/**
 * A private source whose prism author feed serves `pages` in order.
 */
function privatePages(
  pages: PrivateView[][],
  {posts = [], pinned}: {posts?: PrivateView[]; pinned?: string} = {},
) {
  const authorFeedCalls: string[] = []
  const prism = fakePrism({
    posts,
    handler: (nsid, params) => {
      if (nsid !== 'app.nearhorizon.private.getAuthorFeed') return undefined
      const cursor = params.get('cursor') ?? ''
      authorFeedCalls.push(cursor)
      const index = cursor ? Number(cursor) : 0
      return {
        status: 200,
        body: {
          feed: pages[index] ?? [],
          ...(index + 1 < pages.length ? {cursor: String(index + 1)} : {}),
        },
      }
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
    source: {did: DID, prism: prism.client, appview: appview.client},
    authorFeedCalls,
    appviewCalls: appview.calls,
  }
}

/**
 * Every page of `api` until it has no cursor, as URIs.
 */
async function drain(api: FeedAPI, limit = 30) {
  const pages: string[][] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const res = await api.fetch({cursor, limit})
    pages.push(res.feed.map(item => item.post.uri))
    cursor = res.cursor
    if (!cursor) break
  }
  return pages
}

const top = (rkey: string, minutes: number) =>
  privateView(rkey, {did: OTHER_DID, minutes})

const reply = (
  rkey: string,
  minutes: number,
  root: string,
  parent: string = root,
) =>
  privateView(rkey, {
    did: OTHER_DID,
    minutes,
    reply: {
      root: {uri: root, cid: RECORD_CID},
      parent: {uri: parent, cid: RECORD_CID},
    },
  })

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
})

describe('keepsPrivatePost', () => {
  const own = `at://${OTHER_DID}/${PP}/3kroot`
  const theirs = `at://${DID}/${PP}/3kroot`
  it('Posts keeps top-level posts and self-thread replies only', () => {
    expect(keepsPrivatePost('posts', OTHER_DID, {text: 'x'})).toBe(true)
    expect(
      keepsPrivatePost('posts', OTHER_DID, {
        reply: {root: {uri: own}, parent: {uri: own}},
      }),
    ).toBe(true)
    expect(
      keepsPrivatePost('posts', OTHER_DID, {
        reply: {root: {uri: theirs}, parent: {uri: own}},
      }),
    ).toBe(false)
    expect(
      keepsPrivatePost('posts', OTHER_DID, {
        reply: {root: {uri: own}, parent: {uri: theirs}},
      }),
    ).toBe(false)
  })

  it('Replies keeps everything', () => {
    expect(
      keepsPrivatePost('replies', OTHER_DID, {
        reply: {root: {uri: theirs}, parent: {uri: theirs}},
      }),
    ).toBe(true)
  })
})

describe('PrivateAuthorMergeFeedAPI (6.3.1)', () => {
  it('Posts merges by time, keeps self-threads and drops replies to others', async () => {
    const a = top('3ka', 5)
    const selfReply = reply('3kself', 3, a.uri)
    const toOther = reply('3kother', 2, `at://${DID}/${PP}/3kforeign`)
    const {source} = privatePages([[a, selfReply, toOther]])
    const stock = stockPages([[publicItem('p4', 4), publicItem('p1', 1)]])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'posts',
    )
    const pages = await drain(api)
    expect(pages.flat()).toEqual([
      a.uri,
      publicItem('p4', 4).post.uri,
      selfReply.uri,
      publicItem('p1', 1).post.uri,
    ])
  })

  it('Replies keeps every private post and reply', async () => {
    const a = top('3ka', 5)
    const toOther = reply('3kother', 2, `at://${DID}/${PP}/3kforeign`)
    const {source} = privatePages([[a, toOther]])
    const stock = stockPages([[publicItem('p3', 3)]])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'replies',
    )
    expect((await drain(api)).flat()).toEqual([
      a.uri,
      publicItem('p3', 3).post.uri,
      toOther.uri,
    ])
  })

  it('emits every item of both sides once, in each side’s order, across pages', async () => {
    const privs = [top('3k9', 9), top('3k7', 7), top('3k5', 5), top('3k1', 1)]
    const {source} = privatePages([privs.slice(0, 2), privs.slice(2)])
    const pubs = [
      publicItem('p8', 8),
      publicItem('p6', 6),
      publicItem('p4', 4),
      publicItem('p2', 2),
    ]
    const stock = stockPages([pubs.slice(0, 2), pubs.slice(2)])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'posts',
    )
    const all = (await drain(api)).flat()
    expect(all).toEqual([
      privs[0].uri,
      pubs[0].post.uri,
      privs[1].uri,
      pubs[1].post.uri,
      privs[2].uri,
      pubs[2].post.uri,
      pubs[3].post.uri,
      privs[3].uri,
    ])
    expect(new Set(all).size).toBe(all.length)
  })

  it('follows private pages the filter empties within one call', async () => {
    const foreign = `at://${DID}/${PP}/3kforeign`
    const empty = (n: number) => [reply(`3ke${n}`, 50 - n, foreign)]
    const kept = top('3kkept', 1)
    const {source, authorFeedCalls} = privatePages([
      empty(1),
      empty(2),
      empty(3),
      [kept],
    ])
    const stock = stockPages([[]])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'posts',
    )
    const first = await api.fetch({cursor: undefined, limit: 30})
    expect(first.feed.map(i => i.post.uri)).toEqual([kept.uri])
    expect(authorFeedCalls).toEqual(['', '1', '2', '3'])
    expect(first.cursor).toBeUndefined()
  })

  it('follows empty private pages that carry a cursor, up to the per-load cap, and the next call continues', async () => {
    const kept = top('3kkept', 1)
    const {source, authorFeedCalls} = privatePages([
      ...Array.from({length: MAX_PAGES_PER_LOAD + 2}, () => []),
      [kept],
    ])
    const stock = stockPages([[]])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'replies',
    )
    const first = await api.fetch({cursor: undefined, limit: 30})
    expect(first.feed).toEqual([])
    expect(authorFeedCalls).toHaveLength(MAX_PAGES_PER_LOAD)
    expect(first.cursor).toBeDefined()
    const second = await api.fetch({cursor: first.cursor, limit: 30})
    expect(second.feed.map(i => i.post.uri)).toEqual([kept.uri])
    expect(second.cursor).toBeUndefined()
  })

  it('a public page the stock filter empties returns a cursor and the next call continues', async () => {
    const {source} = privatePages([[top('3ka', 1)]])
    const stock = stockPages([[], [publicItem('p5', 5)]])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'posts',
    )
    const first = await api.fetch({cursor: undefined, limit: 30})
    expect(first.feed).toEqual([])
    expect(first.cursor).toBeDefined()
    const second = await api.fetch({cursor: first.cursor, limit: 30})
    expect(second.feed.map(i => i.post.uri)).toEqual([
      publicItem('p5', 5).post.uri,
      top('3ka', 1).uri,
    ])
  })

  it('keeps a public reasonPin item first, above newer private posts', async () => {
    const newer = top('3knew', 100)
    const {source} = privatePages([[newer]])
    const pin = {
      ...publicItem('pinned', 1),
      reason: {$type: 'app.bsky.feed.defs#reasonPin'},
    }
    const stock = stockPages([[pin, publicItem('p50', 50)]])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'posts',
    )
    expect((await drain(api)).flat()).toEqual([
      pin.post.uri,
      newer.uri,
      publicItem('p50', 50).post.uri,
    ])
  })

  it('excludes the pinned private post on the first and every later page; a failed lookup excludes nothing', async () => {
    const privs = [top('3k9', 9), top('3k7', 7), top('3k5', 5)]
    const {source} = privatePages([[privs[0]], [privs[1], privs[2]]])
    const stock = stockPages([[publicItem('p8', 8)], [publicItem('p6', 6)]])
    const excluding = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'posts',
      () => Promise.resolve(privs[2].uri),
    )
    expect((await drain(excluding)).flat()).not.toContain(privs[2].uri)

    const failing = new PrivateAuthorMergeFeedAPI(
      stockPages([[publicItem('p8', 8)], [publicItem('p6', 6)]]).api,
      privatePages([[privs[0]], [privs[1], privs[2]]]).source,
      OTHER_DID,
      'posts',
      () => Promise.reject(new Error('lookup failed')),
    )
    expect((await drain(failing)).flat()).toContain(privs[2].uri)
  })

  it('inserts the author’s own pending posts that pass the filter, on the first page only', async () => {
    publishCurrentClients({
      did: DID,
      handle: 'author.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: {} as never,
    })
    const pending = (rkey: string, minutes: number, replyTo?: string) => {
      const record = {
        $type: PP,
        text: rkey,
        createdAt: at(minutes),
        audienceList: AUDIENCE_URI,
        ...(replyTo
          ? {
              reply: {
                root: {uri: replyTo, cid: RECORD_CID},
                parent: {uri: replyTo, cid: RECORD_CID},
              },
            }
          : {}),
      }
      const uri = `at://${DID}/${PP}/${rkey}`
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
      return uri
    }
    const kept = pending('3kpend', 10)
    const dropped = pending('3kpendreply', 9, `at://${OTHER_DID}/${PP}/3kx`)
    const own = privatePages([[]])
    const ownApi = new PrivateAuthorMergeFeedAPI(
      stockPages([[]]).api,
      own.source,
      DID,
      'posts',
    )
    const uris = (await drain(ownApi)).flat()
    expect(uris).toContain(kept)
    expect(uris).not.toContain(dropped)

    const otherApi = new PrivateAuthorMergeFeedAPI(
      stockPages([[]]).api,
      privatePages([[]]).source,
      OTHER_DID,
      'posts',
    )
    expect((await drain(otherApi)).flat()).not.toContain(kept)
  })

  it('a stock cursor passes through to the stock API', async () => {
    const {source, authorFeedCalls} = privatePages([[top('3ka', 1)]])
    const stock = stockPages([[publicItem('p1', 1)], [publicItem('p0', 0)]])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'posts',
    )
    const res = await api.fetch({cursor: '1', limit: 30})
    expect(res.feed.map(i => i.post.uri)).toEqual([
      publicItem('p0', 0).post.uri,
    ])
    expect(authorFeedCalls).toEqual([])
  })
})

describe('horizonFeedApi for the Posts and Replies tabs (6.4)', () => {
  it('Posts: the pinned private post first, once, from one lookup', async () => {
    const pin = top('3kpin', 3)
    const later = top('3klater', 9)
    const {source, appviewCalls} = privatePages([[later, pin]], {
      posts: [pin],
      pinned: pin.uri,
    })
    const stock = stockPages([[publicItem('p5', 5)]])
    const api = horizonFeedApi(
      `author|${OTHER_DID}|posts_and_author_threads`,
      source,
      stock.api,
    )
    const uris = (await drain(api)).flat()
    expect(uris).toEqual([pin.uri, later.uri, publicItem('p5', 5).post.uri])
    expect(
      appviewCalls.filter(c => c.nsid === 'app.bsky.actor.getProfile'),
    ).toHaveLength(1)
  })

  it('Replies: the merge; without a source: the stock API', () => {
    const {source} = privatePages([[]])
    const stock = stockPages([[]])
    const replies = `author|${OTHER_DID}|posts_with_replies`
    expect(
      unwrapPrivateQuotes(horizonFeedApi(replies, source, stock.api)),
    ).toBeInstanceOf(PrivateAuthorMergeFeedAPI)
    expect(horizonFeedApi(replies, undefined, stock.api)).toBe(stock.api)
    expect(
      horizonFeedApi(
        `author|${OTHER_DID}|posts_and_author_threads`,
        undefined,
        stock.api,
      ),
    ).toBe(stock.api)
    // With a source the stock API resolves its pages' private quotes.
    expect(
      unwrapPrivateQuotes(
        horizonFeedApi(
          `author|${OTHER_DID}|posts_with_media`,
          source,
          stock.api,
        ),
      ),
    ).toBe(stock.api)
  })
})

describe('the filter and repost items (2H design 5.5, 6, T9)', () => {
  function filteredSource(feed: unknown[]) {
    const filters: (string | null)[] = []
    const prism = fakePrism({
      handler: (nsid, params) => {
        if (nsid !== 'app.nearhorizon.private.getAuthorFeed') return undefined
        filters.push(params.get('filter'))
        return {status: 200, body: {feed}}
      },
    })
    return {
      source: {did: DID, prism: prism.client, appview: fakeAppview().client},
      filters,
    }
  }

  beforeEach(() => {
    resetPrismFeatures()
    publishCurrentClients({did: DID} as never)
  })

  it('sends the stock filter only with private.paging', async () => {
    const off = filteredSource([])
    await new PrivateAuthorMergeFeedAPI(
      stockPages([[]]).api,
      off.source,
      OTHER_DID,
      'posts',
    ).fetch({cursor: undefined, limit: 30})
    expect(off.filters).toEqual([null])

    answerPrismFeatures(DID, ['private', 'private.paging'])
    const on = filteredSource([])
    await new PrivateAuthorMergeFeedAPI(
      stockPages([[]]).api,
      on.source,
      OTHER_DID,
      'posts',
    ).fetch({cursor: undefined, limit: 30})
    expect(on.filters).toEqual(['posts_and_author_threads'])
  })

  it('the client filter keeps a repost item of a reply it would drop', async () => {
    const foreignRoot = `at://${DID}/app.bsky.feed.post/3kforeign`
    const branchReply = reply('3kbranch', 1, foreignRoot)
    const repost = {
      ...branchReply,
      reason: {
        $type: 'app.bsky.feed.defs#reasonRepost',
        by: {did: OTHER_DID, handle: 'owner.test'},
        uri: `at://${OTHER_DID}/app.bsky.feed.repost/3krp`,
        indexedAt: at(2),
      },
    }
    const {source} = filteredSource([repost, branchReply])
    const res = await new PrivateAuthorMergeFeedAPI(
      stockPages([[]]).api,
      source,
      OTHER_DID,
      'posts',
    ).fetch({cursor: undefined, limit: 30})
    const items = res.feed.filter(item => item.post.uri === branchReply.uri)
    expect(items).toHaveLength(1)
    expect(items[0].reason).toBeDefined()
  })
})
