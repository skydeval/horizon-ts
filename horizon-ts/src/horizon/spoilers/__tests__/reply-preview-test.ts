import {describe, expect, it, jest} from '@jest/globals'

/*
 * The finders' modules also hold hooks that reach the session and the UI;
 * nothing here renders, so those are stand-ins.
 */
function mockModule(): unknown {
  const stub = function () {
    return mockModule()
  }
  return new Proxy(stub, {
    get: (_, key) => {
      if (key === '__esModule') return true
      if (key === 'then' || typeof key === 'symbol') return undefined
      return mockModule()
    },
  })
}
jest.mock('#/state/session', () => mockModule())
jest.mock('#/components/Toast', () => mockModule())
jest.mock('react-native-reanimated', () => mockModule())
jest.mock('react-native-worklets', () => mockModule())

import {QueryClient} from '@tanstack/react-query'

import {coversWhileLoading, findCachedPostRecord} from '../reply-preview'

const DID = 'did:plc:author'
const URI = `at://${DID}/app.bsky.feed.post/3kpost222222`
const TEXT = 'a ||b|| c'

function post(text: string, uri = URI) {
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri,
    cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
    author: {did: DID, handle: 'author.test'},
    record: {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: '2026-10-15T12:00:00.000Z',
      facets: [
        {
          index: {byteStart: 4, byteEnd: 5},
          features: [{$type: 'app.nearhorizon.richtext.facet#spoiler'}],
        },
      ],
    },
    indexedAt: '2026-10-15T12:00:00.000Z',
  }
}

type Seed = (qc: QueryClient, view: ReturnType<typeof post>) => void

const pages = (page: unknown) => ({pages: [page], pageParams: [undefined]})

/** One seed per finder, in the design's order (6.8). */
const SEEDS: [string, Seed][] = [
  [
    'thread',
    (qc, view) =>
      qc.setQueryData(['post-thread-v2', {}], {
        thread: [
          {
            uri: view.uri,
            depth: 0,
            value: {
              $type: 'app.bsky.unspecced.defs#threadItemPost',
              post: view,
            },
          },
        ],
      }),
  ],
  [
    'feed',
    (qc, view) =>
      qc.setQueryData(['post-feed', {}], pages({feed: [{post: view}]})),
  ],
  [
    'notifications',
    (qc, view) =>
      qc.setQueryData(
        ['notification-feed', {}],
        pages({items: [{type: 'reply', subject: view}]}),
      ),
  ],
  [
    'grouped notifications',
    (qc, view) =>
      qc.setQueryData(
        ['grouped-notifications', {}],
        pages({notifications: [{type: 'reply', post: view}]}),
      ),
  ],
  [
    'bookmarks',
    (qc, view) =>
      qc.setQueryData(['bookmarks', {}], pages({bookmarks: [{item: view}]})),
  ],
  [
    'search',
    (qc, view) => qc.setQueryData(['search-posts', {}], pages({posts: [view]})),
  ],
  [
    'quotes',
    (qc, view) => qc.setQueryData(['post-quotes', {}], pages({posts: [view]})),
  ],
  [
    'explore',
    (qc, view) =>
      qc.setQueryData(['feed-previews', {}], pages({posts: [{post: view}]})),
  ],
  [
    'private bookmarks',
    (qc, view) =>
      qc.setQueryData(
        ['horizon-private-bookmarks', {}],
        pages({bookmarks: [{item: view}]}),
      ),
  ],
  ['post query', (qc, view) => qc.setQueryData(['post', view.uri], view)],
]

describe('findCachedPostRecord (T8)', () => {
  it.each(SEEDS)('finds the post in the %s cache', (_, seed) => {
    const qc = new QueryClient()
    seed(qc, post(TEXT))
    const record = findCachedPostRecord(qc, URI, TEXT)
    expect(record?.text).toBe(TEXT)
    expect(record?.facets).toHaveLength(1)
  })

  it.each(SEEDS)('skips a %s post whose text differs', (_, seed) => {
    const qc = new QueryClient()
    seed(qc, post('another text'))
    expect(findCachedPostRecord(qc, URI, TEXT)).toBeUndefined()
  })

  it('returns nothing on a miss', () => {
    const qc = new QueryClient()
    SEEDS[1][1](qc, post(TEXT, `at://${DID}/app.bsky.feed.post/3kother22222`))
    expect(findCachedPostRecord(qc, URI, TEXT)).toBeUndefined()
  })
})

describe('coversWhileLoading (T8)', () => {
  it('covers every private text, and a public one with two or more markers', () => {
    expect(coversWhileLoading('plain', true)).toBe(true)
    expect(coversWhileLoading('a || b', false)).toBe(false)
    expect(coversWhileLoading('a ||b|| c', false)).toBe(true)
    expect(coversWhileLoading('plain', false)).toBe(false)
  })
})
