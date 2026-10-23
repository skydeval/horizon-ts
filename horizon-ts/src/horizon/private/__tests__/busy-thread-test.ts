import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))
jest.mock('#/horizon/private/api/gates', () => ({
  ...jest.requireActual<object>('#/horizon/private/api/gates'),
  threadGateEvaluation: () => Promise.resolve(undefined),
}))

/*
 * T-6 (prism busy design 6.1, 6.2, 4.1, BR-4, BR-5): the thread's named
 * `Unavailable` branch, the anchor and parent rules, the gate on thread items
 * and further replies, and the private half of the further replies and of a
 * public thread's branches.
 */
import {QueryClient} from '@tanstack/react-query'

import {isKeptError} from '#/horizon/private/api/transient'
import {
  heldQueries,
  missVerdict,
  noteOmissions,
  resetKnown,
  suspectRetryAt,
} from '#/horizon/private/known'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {reportProbeStatus, resetPrismHealth} from '#/horizon/routing/health'
import {type app} from '#/lexicons'
import {clearPrivateStores} from '../store'
import {setReplyContinuation} from '../thread/continuation'
import {
  fetchPrivateThreadV2,
  isUnavailableValue,
  postItem,
} from '../thread/fetch'
import {gateOtherReplies, gateThreadItems} from '../thread/gate'
import {fetchOtherReplies, withPrivateBranches} from '../thread/replies'
import {DID, fakeClient, OTHER_DID, privateUri, RECORD_CID, type Reply} from './fixtures'
import {fakeAppview, type PrivateView, privateView} from './read-fixtures'

type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem

let now = 1_000_000
const KEY = ['post-thread-v2', {anchor: 'x'}]

function node(post: PrivateView, extra: {parent?: unknown; replies?: unknown[]} = {}) {
  return {
    $type: 'app.nearhorizon.private.defs#privateThreadView',
    post,
    ...extra,
  }
}

/** Publish clients whose prism answers every call with `reply`. */
function serve(reply: (nsid: string) => Reply) {
  const prism = fakeClient(DID, call => reply(call.nsid))
  const appview = fakeAppview()
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  publishCurrentClients({
    did: DID,
    handle: 'me.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: appview.client,
    queryClient,
  })
  return {prism, queryClient, context: {client: queryClient, queryKey: KEY}}
}

const notFound: Reply = {status: 400, body: {error: 'NotFound', message: 'x'}}
const unavailable: Reply = {
  status: 503,
  body: {error: 'Unavailable', message: 'x', retryAfter: 30},
}

function anchorValue(thread: ThreadItem[]) {
  return thread.find(item => item.depth === 0)?.value
}

beforeEach(() => {
  now = 1_000_000
  resetPrismHealth({now: () => now, random: () => 0.5})
  resetKnown()
  resetPrismFeatures()
  clearPrivateStores()
  clearCurrentClients()
})

describe('another author\'s anchor (6.1)', () => {
  const other = privateView('3kother', {did: OTHER_DID})

  it('a 503 Unavailable is the quiet row, a held suspect, read again no sooner than its 30 s hint', async () => {
    const {context} = serve(() => unavailable)
    const res = await fetchPrivateThreadV2(other.uri, {below: 4}, context)
    expect(res.thread).toHaveLength(1)
    expect(isUnavailableValue(anchorValue(res.thread))).toBe(true)
    expect(missVerdict(DID, other.uri)).toBe('suspect')
    expect(heldQueries(DID).some(held => held.uri === other.uri)).toBe(true)
    expect(suspectRetryAt(DID, other.uri)).toBeGreaterThanOrEqual(now + 30_000)
  })

  it('never returns the previous data: a 503 Unavailable over a cached thread is the quiet row', async () => {
    const {context, queryClient} = serve(() => unavailable)
    queryClient.setQueryData(KEY, {
      thread: [postItem({...other, record: {$type: 'app.bsky.feed.post', text: 'old', createdAt: ''}} as never, 0, {})],
      hasOtherReplies: false,
    })
    const res = await fetchPrivateThreadV2(other.uri, {below: 4}, context)
    expect(res.thread).toHaveLength(1)
    expect(isUnavailableValue(anchorValue(res.thread))).toBe(true)
  })

  it('a NotFound while healthy is the audience stand-in; while a cause is set, the quiet row', async () => {
    const {context} = serve(() => notFound)
    const healthy = await fetchPrivateThreadV2(other.uri, {below: 4}, context)
    expect(anchorValue(healthy.thread)).toEqual({
      $type: 'app.bsky.unspecced.defs#threadItemNotFound',
    })
    reportProbeStatus(DID, 'reindexing')
    const unwell = await fetchPrivateThreadV2(other.uri, {below: 4}, context)
    expect(isUnavailableValue(anchorValue(unwell.thread))).toBe(true)
  })
})

describe('the reader\'s own anchor (6.1)', () => {
  const own = privateView('3kown')
  const otherReply = privateView('3kreplyo', {
    did: OTHER_DID,
    reply: {root: {uri: own.uri, cid: RECORD_CID}, parent: {uri: own.uri, cid: RECORD_CID}},
  })

  it('keeps its previous data, held, with another author\'s private replies left out', async () => {
    const {context, queryClient} = serve(() => unavailable)
    const asPost = (view: PrivateView) =>
      ({...view, record: {$type: 'app.bsky.feed.post', text: view.uri, createdAt: ''}}) as never
    queryClient.setQueryData(KEY, {
      thread: [postItem(asPost(own), 0, {}), postItem(asPost(otherReply), 1, {})],
      hasOtherReplies: false,
    })
    const res = await fetchPrivateThreadV2(own.uri, {below: 4}, context)
    expect(res.thread.map(item => item.uri)).toEqual([own.uri])
    expect(missVerdict(DID, own.uri)).toBe('suspect')
    expect(heldQueries(DID).some(held => held.uri === own.uri)).toBe(true)
  })

  it('with nothing kept, fails as a suspect miss (the skeleton, then the quiet row)', async () => {
    const {context} = serve(() => unavailable)
    await expect(
      fetchPrivateThreadV2(own.uri, {below: 4}, context),
    ).rejects.toMatchObject({name: 'PrivateSuspectMissError'})
  })
})

describe('the cut-off parent (6.1)', () => {
  it('in a degraded answer: another author\'s is the quiet item', async () => {
    const parent = privateUri('3kparent', OTHER_DID)
    const anchor = privateView('3kanchor', {
      reply: {root: {uri: parent, cid: RECORD_CID}, parent: {uri: parent, cid: RECORD_CID}},
    })
    const {context} = serve(nsid =>
      nsid === 'app.nearhorizon.private.getPostThread'
        ? {status: 200, body: {thread: node(anchor), degraded: true, retryAfter: 60}}
        : {status: 501, body: {error: 'MethodNotImplemented'}},
    )
    const res = await fetchPrivateThreadV2(anchor.uri, {below: 4}, context)
    expect(res.thread[0].uri).toBe(parent)
    expect(isUnavailableValue(res.thread[0].value)).toBe(true)
  })
})

describe('the gate on thread items (4.1, BR10-L4)', () => {
  const ownAnchor = privateUri('3kanchor')
  const otherReply = privateUri('3kotherr', OTHER_DID)
  const childOfOther = privateUri('3kchild')
  const publicReply = `at://${OTHER_DID}/app.bsky.feed.post/3kpub`
  const post = (uri: string, extra: object = {}) =>
    ({uri, cid: RECORD_CID, author: {did: uri.split('/')[2], handle: 'x.test'}, record: {}, indexedAt: '', ...extra}) as never
  const items: ThreadItem[] = [
    postItem(post(ownAnchor), 0, {}),
    postItem(post(otherReply), 1, {}),
    postItem(post(childOfOther), 2, {}),
    postItem(post(publicReply), 1, {}),
  ]

  it('leaves out another author\'s private reply with its subtree from data fetched before the load', () => {
    const {items: shown, hidden} = gateThreadItems(items, DID, 100, 200)
    expect(shown.map(item => item.uri)).toEqual([ownAnchor, publicReply])
    expect(hidden).toBe(1)
  })

  it('shows them from data fetched since the load, and with no load', () => {
    expect(gateThreadItems(items, DID, 300, 200).items).toHaveLength(4)
    expect(gateThreadItems(items, DID, 100, undefined).items).toHaveLength(4)
  })

  it('turns another author\'s anchor into the quiet item, pending while the load fetches', () => {
    const other = privateUri('3kother', OTHER_DID)
    const {items: shown} = gateThreadItems([postItem(post(other), 0, {})], DID, undefined, 200, {pending: true})
    expect(shown[0].uri).toBe(other)
    expect(shown[0].value).toMatchObject({horizonUnavailable: true, horizonPending: true})
  })

  it('judges a carried item by its own stamp', () => {
    const carried = postItem(post(otherReply, {horizonFromCache: 250}), 1, {})
    expect(gateThreadItems([carried], DID, 100, 200).items).toHaveLength(1)
  })

  it('gates the further replies by their own stamp, not the thread\'s (BR13-L3)', () => {
    const replies = [postItem(post(otherReply), 1, {})]
    expect(gateOtherReplies(replies, DID, 100, 200)).toHaveLength(0)
    expect(gateOtherReplies(replies, DID, 250, 200)).toHaveLength(1)
  })

  it('shows the reader\'s own post the PDS says is gone as not found', async () => {
    const pds = fakeClient(DID, () => ({
      status: 400,
      body: {error: 'RecordNotFound', message: 'x'},
    }))
    publishCurrentClients({
      did: DID,
      handle: 'me.test',
      pdsUrl: undefined,
      pdsClient: pds.client,
      prismClient: pds.client,
      appviewClient: pds.client,
    })
    noteOmissions(
      {did: DID, seq: 1, degraded: false, retryAfterMs: undefined, unavailable: []},
      [ownAnchor],
      [],
    )
    expect(gateThreadItems(items, DID, 300, undefined).items[0].value.$type).toBe(
      'app.bsky.unspecced.defs#threadItemPost',
    )
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(gateThreadItems(items, DID, 300, undefined).items[0].value.$type).toBe(
      'app.bsky.unspecced.defs#threadItemNotFound',
    )
  })
})

describe('the further replies\' private half (6.1, BR14-L3)', () => {
  const anchor = privateUri('3kanchor')
  const continuation = () =>
    setReplyContinuation(anchor, {
      kind: 'private',
      anchorUri: anchor,
      cursor: 'c1',
      depth: 1,
      sort: undefined,
      branchingFactor: undefined,
      seen: new Set(),
      cids: new Map(),
      stockHasOther: false,
      key: 'private|pages|',
      hidden: [],
      pages: true,
      readAt: 0,
    })
  const reindexing: Reply = {status: 503, body: {error: 'Reindexing', message: 'x', retryAfter: 30}}

  it('with data, a transient failure is rethrown as kept, and held', async () => {
    const {context, queryClient} = serve(() => reindexing)
    continuation()
    queryClient.setQueryData(KEY, {thread: []})
    let thrown: unknown
    await fetchOtherReplies(anchor, () => Promise.resolve({thread: []}), context).catch(
      (error: unknown) => {
        thrown = error
      },
    )
    expect(isKeptError(thrown)).toBe(true)
    expect(heldQueries(DID).length).toBeGreaterThan(0)
  })

  it('with none (a first tap in an outage), gives the stock part, stamped, and holds', async () => {
    const {context} = serve(() => reindexing)
    continuation()
    const res = await fetchOtherReplies(anchor, () => Promise.resolve({thread: []}), context)
    expect(res.thread).toEqual([])
    expect(res.horizonFetchedAt).toBe(now)
    expect(heldQueries(DID).length).toBeGreaterThan(0)
  })
})

describe('a public thread\'s private branches (6.1)', () => {
  const publicAnchor = `at://${OTHER_DID}/app.bsky.feed.post/3kpub`
  const stock = () => Promise.resolve({
    thread: [
      {
        uri: publicAnchor,
        depth: 0,
        value: {$type: 'app.bsky.unspecced.defs#threadItemPost'},
      },
    ],
    hasOtherReplies: false,
  }) as never

  beforeEach(() => {
    answerPrismFeatures(DID, ['private', 'private.paging'])
  })

  it('with data, a transient failure of the branches is rethrown as kept', async () => {
    const {context, queryClient} = serve(() => ({
      status: 503,
      body: {error: 'Reindexing', message: 'x'},
    }))
    queryClient.setQueryData(KEY, {thread: []})
    let thrown: unknown
    await withPrivateBranches(publicAnchor, {below: 4}, stock, context).catch(
      (error: unknown) => {
        thrown = error
      },
    )
    expect(isKeptError(thrown)).toBe(true)
  })

  it('with none, gives the stock thread alone', async () => {
    const {context} = serve(() => ({
      status: 503,
      body: {error: 'Reindexing', message: 'x'},
    }))
    const res = await withPrivateBranches(publicAnchor, {below: 4}, stock, context)
    expect(res.thread).toHaveLength(1)
  })
})
