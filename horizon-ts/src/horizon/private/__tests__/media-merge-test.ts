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
import {PrivateAuthorMergeFeedAPI} from '../feed/author-merge'
import {horizonFeedApi} from '../feed/legacy'
import {unwrapPrivateQuotes} from '../quotes/resolve'
import {clearPrivateStores} from '../store'
import {DID, OTHER_DID} from './fixtures'
import {
  at,
  fakeAppview,
  fakePrism,
  type PrivateView,
  privateView,
  publicItem,
} from './read-fixtures'

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

/** A prism whose author feed serves `pages`, recording each request. */
function privatePages(pages: unknown[][]) {
  const calls: {filter: string | null; cursor: string | null}[] = []
  const prism = fakePrism({
    handler: (nsid, params) => {
      if (nsid !== 'app.nearhorizon.private.getAuthorFeed') return undefined
      calls.push({filter: params.get('filter'), cursor: params.get('cursor')})
      const cursor = params.get('cursor') ?? ''
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
  return {
    source: {did: DID, prism: prism.client, appview: fakeAppview().client},
    calls,
  }
}

async function drain(api: FeedAPI) {
  const pages: string[][] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const res = await api.fetch({cursor, limit: 30})
    pages.push(res.feed.map(item => item.post.uri))
    cursor = res.cursor
    if (!cursor) break
  }
  return pages
}

const top = (rkey: string, minutes: number): PrivateView =>
  privateView(rkey, {did: OTHER_DID, minutes})

function repostOf(view: PrivateView, minutes: number) {
  return {
    ...view,
    reason: {
      $type: 'app.bsky.feed.defs#reasonRepost',
      by: {did: OTHER_DID, handle: 'owner.test'},
      uri: `at://${OTHER_DID}/app.bsky.feed.repost/3krp${minutes}`,
      indexedAt: at(minutes),
    },
  }
}

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
  resetPrismFeatures()
  publishCurrentClients({did: DID} as never)
})

describe('the Media and Videos merges (change list item 4)', () => {
  it.each<['media' | 'video', string]>([
    ['media', 'posts_with_media'],
    ['video', 'posts_with_video'],
  ])(
    '%s asks prism with filter %s, even without private.paging',
    async (filter, value) => {
      const {source, calls} = privatePages([[]])
      await new PrivateAuthorMergeFeedAPI(
        stockPages([[]]).api,
        source,
        OTHER_DID,
        filter,
      ).fetch({cursor: undefined, limit: 30})
      expect(calls.map(call => call.filter)).toEqual([value])
    },
  )

  it('merges by time across pages, with no loss and no repeats', async () => {
    const a = top('3ka', 9)
    const b = top('3kb', 6)
    const c = top('3kc', 2)
    const {source, calls} = privatePages([[a, b], [c]])
    const stock = stockPages([
      [publicItem('p8', 8), publicItem('p5', 5)],
      [publicItem('p3', 3), publicItem('p1', 1)],
    ])
    const api = new PrivateAuthorMergeFeedAPI(
      stock.api,
      source,
      OTHER_DID,
      'media',
    )
    const all = (await drain(api)).flat()
    expect(all).toEqual([
      a.uri,
      publicItem('p8', 8).post.uri,
      b.uri,
      publicItem('p5', 5).post.uri,
      publicItem('p3', 3).post.uri,
      c.uri,
      publicItem('p1', 1).post.uri,
    ])
    expect(new Set(all).size).toBe(all.length)
    // Each prism page read once, with its filter kept on the next page.
    expect(calls).toEqual([
      {filter: 'posts_with_media', cursor: null},
      {filter: 'posts_with_media', cursor: '1'},
    ])
  })

  it('leaves repost items out of the media tabs, as stock', async () => {
    const a = top('3ka', 5)
    const {source} = privatePages([[repostOf(a, 7), a]])
    const res = await new PrivateAuthorMergeFeedAPI(
      stockPages([[]]).api,
      source,
      OTHER_DID,
      'video',
    ).fetch({cursor: undefined, limit: 30})
    expect(res.feed).toHaveLength(1)
    expect(res.feed[0].post.uri).toBe(a.uri)
    expect(res.feed[0].reason).toBeUndefined()
  })
})

describe('horizonFeedApi for the Media and Videos tabs', () => {
  const media = `author|${OTHER_DID}|posts_with_media`
  const videos = `author|${OTHER_DID}|posts_with_video`

  it('stays public-only without private.mediaFilters', () => {
    answerPrismFeatures(DID, ['private', 'private.paging'])
    const {source} = privatePages([[]])
    const stock = stockPages([[]])
    expect(unwrapPrivateQuotes(horizonFeedApi(media, source, stock.api))).toBe(
      stock.api,
    )
    expect(unwrapPrivateQuotes(horizonFeedApi(videos, source, stock.api))).toBe(
      stock.api,
    )
  })

  it('merges both tabs with private.mediaFilters, for members only', () => {
    answerPrismFeatures(DID, ['private', 'private.mediaFilters'])
    const {source} = privatePages([[]])
    const stock = stockPages([[]])
    expect(
      unwrapPrivateQuotes(horizonFeedApi(media, source, stock.api)),
    ).toBeInstanceOf(PrivateAuthorMergeFeedAPI)
    expect(
      unwrapPrivateQuotes(horizonFeedApi(videos, source, stock.api)),
    ).toBeInstanceOf(PrivateAuthorMergeFeedAPI)
    // A non-member has no source.
    expect(horizonFeedApi(media, undefined, stock.api)).toBe(stock.api)
  })
})
