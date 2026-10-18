import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => mockMembership,
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did && mockMembership === 'member',
}))
const mockResolvePds = jest.fn((did: string) =>
  Promise.resolve({did, pdsUrl: 'https://pds.example'}),
)
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: (did: string) => mockResolvePds(did),
}))

import {QueryClient} from '@tanstack/react-query'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'
import {
  fromQuoteData,
  privateQuoteQueryKey,
  QUOTE_STALE_MS,
  toQuoteData,
} from '../quotes/cache'
import {
  feedItemPosts,
  privateQuoteUris,
  threadItemPosts,
} from '../quotes/collect'
import {
  resolvePrivateQuotes,
  unwrapPrivateQuotes,
  withBookmarkQuotes,
  withPrivateQuotes,
} from '../quotes/resolve'
import {clearPrivateStores} from '../store'
import {
  type Call,
  DID,
  fakeClient,
  OTHER_DID,
  privateUri,
  RECORD_CID,
  type Reply,
} from './fixtures'
import {fakeAppview, type PrivateView, privateView} from './read-fixtures'

const PUBLIC_DID = 'did:plc:publicccccccccccccccccccc'

/** A public post, as the public AppView serves it, quoting `quoted`. */
function quotingPost(
  id: string,
  quoted: string,
  {withMedia = false}: {withMedia?: boolean} = {},
): app.bsky.feed.defs.PostView {
  const record = {
    $type: 'app.bsky.embed.record#view',
    record: {
      $type: 'app.bsky.embed.record#viewNotFound',
      uri: quoted,
      notFound: true,
    },
  }
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri: `at://${PUBLIC_DID}/app.bsky.feed.post/${id}`,
    cid: RECORD_CID,
    author: {did: PUBLIC_DID, handle: 'pub.test'},
    record: {$type: 'app.bsky.feed.post', text: id, createdAt: '2026-10-17'},
    indexedAt: '2026-10-17T00:00:00.000Z',
    embed: withMedia
      ? {
          $type: 'app.bsky.embed.recordWithMedia#view',
          record,
          media: {$type: 'app.bsky.embed.images#view', images: []},
        }
      : record,
  } as unknown as app.bsky.feed.defs.PostView
}

/**
 * A fake prism whose `getPosts` serves `posts`, and waits for `gate` when
 * one is given.
 */
function slowPrism(posts: PrivateView[], gate?: Promise<void>) {
  return fakeClient(DID, async (call: Call): Promise<Reply> => {
    if (call.nsid !== 'app.nearhorizon.private.getPosts') {
      return {status: 501, body: {error: 'MethodNotImplemented'}}
    }
    if (gate) await gate
    const wanted = call.params.getAll('uris')
    return {
      status: 200,
      body: {posts: posts.filter(p => wanted.includes(p.uri))},
    }
  })
}

function gate() {
  let open = () => {}
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return {promise, open}
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function setup(posts: PrivateView[], prismGate?: Promise<void>) {
  const prism = slowPrism(posts, prismGate)
  const appview = fakeAppview({
    profiles: [{did: OTHER_DID, handle: 'other.public', displayName: 'Other'}],
  })
  const queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false}},
  })
  publishCurrentClients({
    did: DID,
    handle: 'me.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: appview.client,
    queryClient,
  })
  const context = {
    clients: {
      did: DID,
      prismClient: prism.client,
      appviewClient: appview.client,
    },
    queryClient,
  }
  const getPostsCalls = () =>
    prism.calls.filter(c => c.nsid === 'app.nearhorizon.private.getPosts')
  return {prism, appview, queryClient, context, getPostsCalls}
}

function cached(queryClient: QueryClient, uri: string) {
  return fromQuoteData(queryClient.getQueryData(privateQuoteQueryKey(uri)))
}

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
  mockMembership = 'member'
  mockResolvePds.mockClear()
})

describe('collecting the private quotes of a page', () => {
  it('takes unhydrated private quotes, alone or with media, once each', () => {
    const a = privateUri('3kquotea', OTHER_DID)
    const b = privateUri('3kquoteb', OTHER_DID)
    const hydrated = quotingPost('p3', privateUri('3kquotec', OTHER_DID))
    ;(hydrated.embed as {record: {$type: string}}).record.$type =
      'app.bsky.embed.record#viewRecord'
    const uris = privateQuoteUris([
      quotingPost('p1', a),
      quotingPost('p2', b, {withMedia: true}),
      quotingPost('p4', a),
      hydrated,
      quotingPost('p5', `at://${PUBLIC_DID}/app.bsky.feed.post/3kpub`),
      undefined,
    ])
    expect(uris).toEqual([a, b])
  })

  it('reads feed items with their reply parents and roots, and thread items', () => {
    const post = quotingPost('p1', privateUri('3kq', OTHER_DID))
    const parent = quotingPost('p2', privateUri('3kq2', OTHER_DID))
    expect(
      Array.from(
        feedItemPosts([
          {
            post,
            reply: {
              parent: parent as never,
              root: {
                $type: 'app.bsky.feed.defs#notFoundPost',
                uri: 'at://x/app.bsky.feed.post/1',
                notFound: true,
              },
            },
          },
        ]),
      ),
    ).toEqual([post, parent])
    expect(
      Array.from(
        threadItemPosts([
          {value: {$type: 'app.bsky.unspecced.defs#threadItemPost', post}},
          {value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'}},
        ]),
      ),
    ).toEqual([post])
  })
})

describe('resolving a page of quotes', () => {
  it('reads them in one getPosts per 25 and caches each before returning', async () => {
    const views = Array.from({length: 30}, (_, i) =>
      privateView(`3kq${String(i).padStart(2, '0')}`, {did: OTHER_DID}),
    )
    const {queryClient, context, getPostsCalls} = setup(views)
    const posts = views.map((view, i) => quotingPost(`p${i}`, view.uri))
    await resolvePrivateQuotes(posts, context)
    expect(getPostsCalls().map(c => c.params.getAll('uris').length)).toEqual([
      25, 5,
    ])
    for (const view of views) {
      const quote = cached(queryClient, view.uri)
      expect(quote?.uri).toBe(view.uri)
      // The author merge ran: the public profile replaced prism's.
      expect(quote?.author.displayName).toBe('Other')
    }
  })

  it('caches a post prism does not serve as not viewable', async () => {
    const missing = privateUri('3kmissing', OTHER_DID)
    const {queryClient, context} = setup([])
    await resolvePrivateQuotes([quotingPost('p1', missing)], context)
    expect(queryClient.getQueryData(privateQuoteQueryKey(missing))).toBeNull()
  })

  it('returns at the deadline, and the read still fills the cache', async () => {
    const view = privateView('3kslow', {did: OTHER_DID})
    const slow = gate()
    const {queryClient, context} = setup([view], slow.promise)
    let returned = false
    const resolving = resolvePrivateQuotes([quotingPost('p1', view.uri)], {
      ...context,
      deadlineMs: 20,
    }).then(() => {
      returned = true
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(returned).toBe(true)
    expect(cached(queryClient, view.uri)).toBeUndefined()
    slow.open()
    await resolving
    await flush()
    expect(cached(queryClient, view.uri)?.uri).toBe(view.uri)
  })

  it('does not read a fresh cached quote again', async () => {
    const view = privateView('3kfresh', {did: OTHER_DID})
    const {queryClient, context, getPostsCalls} = setup([view])
    queryClient.setQueryData(
      privateQuoteQueryKey(view.uri),
      toQuoteData({...view, record: {}} as never),
    )
    await resolvePrivateQuotes([quotingPost('p1', view.uri)], context)
    expect(getPostsCalls()).toHaveLength(0)
  })

  it('paints a stale cached quote at once and reads it again in the background', async () => {
    const view = privateView('3kstale', {did: OTHER_DID, text: 'new text'})
    const slow = gate()
    const {queryClient, context, getPostsCalls} = setup([view], slow.promise)
    queryClient.setQueryData(
      privateQuoteQueryKey(view.uri),
      toQuoteData({...view, record: {text: 'old text'}} as never),
      {updatedAt: Date.now() - QUOTE_STALE_MS - 1},
    )
    // Returns without waiting for the gated read.
    await resolvePrivateQuotes([quotingPost('p1', view.uri)], {
      ...context,
      deadlineMs: 10_000,
    })
    expect((cached(queryClient, view.uri)?.record as {text: string}).text).toBe(
      'old text',
    )
    await flush()
    expect(getPostsCalls()).toHaveLength(1)
    slow.open()
    await flush()
    expect((cached(queryClient, view.uri)?.record as {text: string}).text).toBe(
      'new text',
    )
  })

  it('joins a read already running for a quote instead of repeating it', async () => {
    const view = privateView('3krunning', {did: OTHER_DID})
    const {queryClient, context, getPostsCalls} = setup([view])
    const running = gate()
    void queryClient.fetchQuery({
      queryKey: privateQuoteQueryKey(view.uri),
      queryFn: async () => {
        await running.promise
        return toQuoteData({...view, record: {}} as never)
      },
    })
    let returned = false
    const resolving = resolvePrivateQuotes(
      [quotingPost('p1', view.uri)],
      context,
    ).then(() => {
      returned = true
    })
    await flush()
    expect(returned).toBe(false)
    running.open()
    await resolving
    expect(getPostsCalls()).toHaveLength(0)
    expect(cached(queryClient, view.uri)?.uri).toBe(view.uri)
  })

  it('starts the author profiles and PDS lookups alongside getPosts', async () => {
    const view = privateView('3kpar', {did: OTHER_DID})
    const slow = gate()
    const {appview, context} = setup([view], slow.promise)
    const resolving = resolvePrivateQuotes(
      [quotingPost('p1', view.uri)],
      context,
    )
    await flush()
    // getPosts is still waiting, and both lookups have gone out.
    expect(
      appview.calls.filter(c => c.nsid === 'app.bsky.actor.getProfiles'),
    ).toHaveLength(1)
    expect(mockResolvePds).toHaveBeenCalledWith(OTHER_DID)
    slow.open()
    await resolving
    // The started profile fetch is used, not repeated.
    expect(
      appview.calls.filter(c => c.nsid === 'app.bsky.actor.getProfiles'),
    ).toHaveLength(1)
  })

  it('reads nothing for a non-member', async () => {
    mockMembership = 'not-member'
    const view = privateView('3knm', {did: OTHER_DID})
    const {queryClient, context, getPostsCalls} = setup([view])
    await resolvePrivateQuotes([quotingPost('p1', view.uri)], context)
    expect(getPostsCalls()).toHaveLength(0)
    expect(cached(queryClient, view.uri)).toBeUndefined()
  })
})

describe('page fetches with their quotes', () => {
  it('a wrapped feed API returns each page with its quotes cached', async () => {
    const view = privateView('3kfeed', {did: OTHER_DID})
    const {queryClient} = setup([view])
    const stock = {
      label: 'stock',
      fetch: (_params: {cursor: string | undefined; limit: number}) =>
        Promise.resolve({
          cursor: undefined,
          feed: [{post: quotingPost('p1', view.uri)}],
        }),
      peekLatest(this: {label: string}) {
        return Promise.resolve(this.label)
      },
    }
    const api = withPrivateQuotes(stock)
    const res = await api.fetch({cursor: undefined, limit: 30})
    expect(res.feed).toHaveLength(1)
    expect(cached(queryClient, view.uri)?.uri).toBe(view.uri)
    // Other members are the API's own, bound to it.
    await expect(api.peekLatest()).resolves.toBe('stock')
    expect(unwrapPrivateQuotes(api)).toBe(stock)
  })

  it('a page of public bookmarks is returned with its quotes cached', async () => {
    const view = privateView('3kbm', {did: OTHER_DID})
    const {queryClient} = setup([view])
    const page = {
      bookmarks: [{item: quotingPost('p1', view.uri)}, {item: {}}],
    }
    await expect(withBookmarkQuotes(page)).resolves.toBe(page)
    expect(cached(queryClient, view.uri)?.uri).toBe(view.uri)
  })
})
