import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The tap and public anchors (hidden replies design 4.3, 5.3, 6.3, 8): the
 * further replies' hidden part, read from the prefetch; `readPrivate` only
 * on `pages`, stopping on the query's signal; the order and de-duplication;
 * `keepOrHold`; a private anchor without a continuation; a public anchor's
 * hidden part, outside paging. Tests 4, 5, 6, 7, 8, 9, 20 (public half), 21,
 * 23 and 24 (tap half).
 */

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))
jest.mock('#/horizon/private/api/gates', () => ({
  ...jest.requireActual<object>('#/horizon/private/api/gates'),
  threadGateEvaluation: () => Promise.resolve(undefined),
}))

import {QueryClient} from '@tanstack/react-query'

import {isKeptError} from '#/horizon/private/api/transient'
import {heldQueries, resetKnown} from '#/horizon/private/known'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {
  nextAnswerSeq,
  reportReadOutcome,
  resetPrismHealth,
} from '#/horizon/routing/health'
import {type app} from '#/lexicons'
import {clearPrivateStores} from '../store'
import {
  continuationKey,
  getReplyContinuation,
  type ReplyContinuation,
  resetReplyContinuations,
  setReplyContinuation,
} from '../thread/continuation'
import {gateOtherReplies} from '../thread/gate'
import {prefetchHiddenReplies} from '../thread/hidden'
import {fetchOtherReplies, withPrivateBranches} from '../thread/replies'
import {
  DID,
  fakeClient,
  OTHER_DID,
  privateUri,
  RECORD_CID,
  type Reply,
} from './fixtures'
import {at, type PrivateView, privateView} from './read-fixtures'

type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem
type ThreadOutput = app.bsky.unspecced.getPostThreadV2.$OutputBody
type OtherOutput = app.bsky.unspecced.getPostThreadOtherV2.$OutputBody

const KEY = ['post-thread-other-v2', {anchor: 'x'}]
const THREAD_KEY = ['post-thread-v2', {anchor: 'x'}]
const ANCHOR = privateUri('3kanchor22222')
const ANCHOR_REF = {uri: ANCHOR, cid: RECORD_CID}

function reply(
  rkey: string,
  parent: {uri: string; cid: string} = ANCHOR_REF,
  root: {uri: string; cid: string} = parent,
): PrivateView {
  return privateView(rkey, {did: OTHER_DID, minutes: 1, reply: {root, parent}})
}

const X = reply('3kxxxxxxxxxx')
const P = reply('3kpppppppppp')

function node(post: object, replies: unknown[] = []) {
  return {
    $type: 'app.nearhorizon.private.defs#privateThreadView',
    post,
    replies,
  }
}

let posts: PrivateView[]
let prismReply: (nsid: string, params: URLSearchParams) => Reply | undefined
let prismCalls: {nsid: string; params: URLSearchParams}[]
let appviewCalls: string[]
let queryClient: QueryClient
let clients: {
  prismClient: ReturnType<typeof fakeClient>['client']
  appviewClient: ReturnType<typeof fakeClient>['client']
}

function publish() {
  prismCalls = []
  appviewCalls = []
  const prism = fakeClient(DID, call => {
    prismCalls.push({nsid: call.nsid, params: call.params})
    const custom = prismReply(call.nsid, call.params)
    if (custom) return custom
    if (call.nsid === 'app.nearhorizon.private.getPosts') {
      const wanted = call.params.getAll('uris')
      return {
        status: 200,
        body: {posts: posts.filter(p => wanted.includes(p.uri))},
      }
    }
    return {status: 501, body: {error: 'MethodNotImplemented'}}
  })
  const counted = fakeClient(DID, call => {
    appviewCalls.push(call.nsid)
    return {
      status: 200,
      body:
        call.nsid === 'app.bsky.actor.getProfiles'
          ? {profiles: []}
          : {posts: []},
    }
  })
  queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  clients = {prismClient: prism.client, appviewClient: counted.client}
  publishCurrentClients({
    did: DID,
    handle: 'me.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: counted.client,
    queryClient,
  })
}

function confirm() {
  reportReadOutcome(DID, {
    kind: 'answered',
    method: 'app.nearhorizon.private.getPosts',
    seq: nextAnswerSeq(DID),
    read: true,
    degraded: false,
    retryAfterMs: undefined,
  })
}

async function settle() {
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function continuationFor(
  hidden: string[],
  extra: Partial<ReplyContinuation> = {},
): ReplyContinuation {
  const pages = extra.pages ?? false
  return {
    kind: 'private',
    anchorUri: ANCHOR,
    cursor: undefined,
    depth: 6,
    sort: undefined,
    branchingFactor: undefined,
    seen: new Set(),
    cids: new Map([[ANCHOR, RECORD_CID]]),
    stockHasOther: false,
    key: continuationKey({kind: extra.kind ?? 'private', pages, hidden}),
    hidden,
    pages,
    readAt: 0,
    ...extra,
  }
}

function prefetch(continuation: ReplyContinuation, anchor = ANCHOR) {
  prefetchHiddenReplies({
    client: queryClient,
    threadKey: THREAD_KEY,
    clients,
    did: DID,
    anchor,
    anchorUri: continuation.anchorUri,
    candidates: continuation.hidden,
    cidOf: () => RECORD_CID,
    unserved: undefined,
  })
}

const context = () => ({client: queryClient, queryKey: KEY})
const noStock = () =>
  Promise.reject(new Error('never the stock call')) as Promise<OtherOutput>

function getPostsCalls() {
  return prismCalls.filter(c => c.nsid === 'app.nearhorizon.private.getPosts')
}
function getRepliesCalls() {
  return prismCalls.filter(c => c.nsid === 'app.nearhorizon.private.getReplies')
}

function uris(thread: {uri: string}[]) {
  return thread.map(item => item.uri)
}

beforeEach(() => {
  posts = [X, P]
  prismReply = () => undefined
  resetPrismHealth()
  resetKnown()
  resetPrismFeatures()
  answerPrismFeatures(DID, ['private'])
  clearPrivateStores()
  resetReplyContinuations()
  clearCurrentClients()
  publish()
})

describe('the tap (6.3; tests 4, 5, 24)', () => {
  it('with a fresh prefetch, a hidden-only continuation makes no call: no getPosts, no getReplies, no AppView', async () => {
    const continuation = continuationFor([X.uri])
    setReplyContinuation(ANCHOR, continuation)
    prefetch(continuation)
    await settle()
    prismCalls = []
    appviewCalls = []
    const result = await fetchOtherReplies(ANCHOR, noStock, context())
    expect(uris(result.thread)).toEqual([X.uri])
    expect(prismCalls).toEqual([])
    expect(appviewCalls).toEqual([])
    expect(result.horizonContinuation).toBe(continuation.key)
  })

  it('with a prefetch older than the continuation it reads again; with one in flight it joins it', async () => {
    const continuation = continuationFor([X.uri])
    setReplyContinuation(ANCHOR, continuation)
    prefetch(continuation)
    await settle()
    setReplyContinuation(ANCHOR, {...continuation, readAt: Date.now() + 60_000})
    await fetchOtherReplies(ANCHOR, noStock, context())
    expect(getPostsCalls()).toHaveLength(2)

    queryClient.clear()
    prismCalls = []
    setReplyContinuation(ANCHOR, continuation)
    prefetch(continuation)
    const result = await fetchOtherReplies(ANCHOR, noStock, context())
    expect(getPostsCalls()).toHaveLength(1)
    expect(uris(result.thread)).toEqual([X.uri])
  })

  it('getPosts leaving the candidate out gives nothing, and no throw', async () => {
    posts = []
    setReplyContinuation(ANCHOR, continuationFor([X.uri]))
    const result = await fetchOtherReplies(ANCHOR, noStock, context())
    expect(result.thread).toEqual([])
  })

  it('shows the stock part, the paged items, then the hidden items, each reply once', async () => {
    prismReply = nsid =>
      nsid === 'app.nearhorizon.private.getReplies'
        ? {status: 200, body: {replies: [node(P), node(X)]}}
        : undefined
    const stockItem = {
      uri: `at://${OTHER_DID}/app.bsky.feed.post/3kstock22222`,
      depth: 1,
      value: {$type: 'app.bsky.unspecced.defs#threadItemPost'},
    }
    setReplyContinuation(
      ANCHOR,
      continuationFor([X.uri], {pages: true, stockHasOther: true}),
    )
    const result = await fetchOtherReplies(
      ANCHOR,
      () => Promise.resolve({thread: [stockItem]} as unknown as OtherOutput),
      context(),
    )
    expect(uris(result.thread)).toEqual([stockItem.uri, P.uri, X.uri])
  })

  it('past 50 candidates the tap reads the rest once, outside the cache, and shows both parts', async () => {
    const many = Array.from({length: 60}, (_, i) =>
      reply(`3kmany${String(i).padStart(6, '0')}`),
    )
    posts = many
    const continuation = continuationFor(many.map(v => v.uri))
    setReplyContinuation(ANCHOR, continuation)
    prefetch(continuation)
    await settle()
    prismCalls = []
    const result = await fetchOtherReplies(ANCHOR, noStock, context())
    const asked = getPostsCalls().flatMap(c => c.params.getAll('uris'))
    expect(asked.sort()).toEqual(
      many
        .slice(0, 10)
        .map(v => v.uri)
        .sort(),
    )
    expect(new Set(uris(result.thread)).size).toBe(60)
    expect(result.thread).toHaveLength(60)
  })
})

describe('failures (8; tests 6, 7)', () => {
  const reindexing: Reply = {
    status: 503,
    body: {error: 'Reindexing', message: 'x', retryAfter: 30},
  }

  it('a transient failure of the tap’s read rethrows over data, and returns the rest and holds without', async () => {
    prismReply = nsid =>
      nsid === 'app.nearhorizon.private.getPosts' ? reindexing : undefined
    setReplyContinuation(ANCHOR, continuationFor([X.uri]))
    queryClient.setQueryData(KEY, {thread: []})
    let thrown: unknown
    await fetchOtherReplies(ANCHOR, noStock, context()).catch(
      (error: unknown) => {
        thrown = error
      },
    )
    expect(isKeptError(thrown)).toBe(true)

    queryClient.clear()
    resetKnown()
    const result = await fetchOtherReplies(ANCHOR, noStock, context())
    expect(result.thread).toEqual([])
    expect(heldQueries(DID).length).toBeGreaterThan(0)
  })

  it('a private anchor with no continuation never asks the stock call: the query’s data, else nothing', async () => {
    const stock = jest.fn(noStock)
    const empty = await fetchOtherReplies(ANCHOR, stock, context())
    expect(empty.thread).toEqual([])
    expect(empty.horizonContinuation).toBe('')
    const data = {thread: [{uri: X.uri, depth: 1, value: {}}]}
    queryClient.setQueryData(KEY, data)
    expect(await fetchOtherReplies(ANCHOR, stock, context())).toBe(data)
    expect(stock).not.toHaveBeenCalled()
  })
})

describe('paging stops on the signal (HR4-L2; test 23)', () => {
  it('a paging read whose signal aborts makes no further getReplies call', async () => {
    const controller = new AbortController()
    let page = 0
    prismReply = nsid => {
      if (nsid !== 'app.nearhorizon.private.getReplies') return undefined
      page++
      controller.abort()
      return {
        status: 200,
        body: {
          replies: [node(reply(`3kpage${String(page).padStart(6, '0')}`))],
          cursor: `c${page}`,
        },
      }
    }
    setReplyContinuation(ANCHOR, continuationFor([], {pages: true}))
    await fetchOtherReplies(ANCHOR, noStock, {
      ...context(),
      signal: controller.signal,
    })
    expect(getRepliesCalls()).toHaveLength(1)
  })
})

describe('the load gate on hidden items (8; test 9)', () => {
  it('judges each hidden item by its read’s stamp: before loadSince gated out, after kept', async () => {
    const continuation = continuationFor([X.uri])
    setReplyContinuation(ANCHOR, continuation)
    prefetch(continuation)
    await settle()
    const result = await fetchOtherReplies(ANCHOR, noStock, context())
    const stamp = (
      result.thread[0].value as {post: {horizonFromCache?: number}}
    ).post.horizonFromCache
    expect(typeof stamp).toBe('number')
    const items = result.thread as unknown as ThreadItem[]
    // The further replies' own completion stamp is newer; the item's is judged.
    expect(gateOtherReplies(items, DID, Date.now() + 1e6, stamp! + 1)).toEqual(
      [],
    )
    expect(gateOtherReplies(items, DID, 0, stamp)).toHaveLength(1)
  })
})

describe('public anchors (5.3; tests 8, 20, 21)', () => {
  const PUB_DID = 'did:plc:publicccccccccccccccccccc'
  const PUB = `at://${PUB_DID}/app.bsky.feed.post/3kanchor22222`
  const PUB_REF = {uri: PUB, cid: RECORD_CID}
  const H = reply('3khhhhhhhhhh', PUB_REF)

  function stock(hidden: string[]): ThreadOutput {
    return {
      thread: [
        {
          uri: PUB,
          depth: 0,
          value: {
            $type: 'app.bsky.unspecced.defs#threadItemPost',
            post: {
              uri: PUB,
              cid: RECORD_CID,
              author: {did: PUB_DID, handle: 'pub.test'},
              record: {
                $type: 'app.bsky.feed.post',
                text: 'root',
                createdAt: at(0),
              },
              indexedAt: at(0),
            },
            moreParents: false,
            moreReplies: 0,
            opThread: false,
            hiddenByThreadgate: false,
            mutedByViewer: false,
          },
        },
      ],
      threadgate: {
        uri: `at://${PUB_DID}/app.bsky.feed.threadgate/3kanchor22222`,
        cid: RECORD_CID,
        record: {
          $type: 'app.bsky.feed.threadgate',
          post: PUB,
          createdAt: at(0),
          hiddenReplies: hidden,
        },
      },
      hasOtherReplies: false,
    } as unknown as ThreadOutput
  }

  const threadContext = () => ({client: queryClient, queryKey: THREAD_KEY})

  it('a kryphocron URI in Bluesky’s gate not in the branch read gives a continuation without a cursor and the row; the hidden part runs without paging', async () => {
    posts = [H]
    confirm()
    const result = await withPrivateBranches(
      PUB,
      {below: 6},
      () => Promise.resolve(stock([H.uri])),
      threadContext(),
    )
    expect(result.hasOtherReplies).toBe(true)
    const continuation = getReplyContinuation(PUB)
    expect(continuation?.kind).toBe('public')
    expect(continuation?.cursor).toBeUndefined()
    expect(continuation?.pages).toBe(false)
    expect(continuation?.hidden).toEqual([H.uri])
    expect(result.horizonContinuation).toBe(continuation?.key)
    // No branch read without `private.paging`; the prefetch runs.
    expect(getRepliesCalls()).toEqual([])
    await settle()
    expect(getPostsCalls().map(c => c.params.getAll('uris'))).toEqual([[H.uri]])
    const other = await fetchOtherReplies(PUB, noStock, context())
    expect(uris(other.thread)).toEqual([H.uri])
    expect(other.horizonContinuation).toBe(continuation?.key)
  })

  it('a hidden reply the branch read served is no candidate and starts no prefetch', async () => {
    answerPrismFeatures(DID, ['private', 'private.paging'])
    confirm()
    prismReply = nsid =>
      nsid === 'app.nearhorizon.private.getReplies'
        ? {status: 200, body: {replies: [node(H)]}}
        : undefined
    const result = await withPrivateBranches(
      PUB,
      {below: 6},
      () => Promise.resolve(stock([H.uri])),
      threadContext(),
    )
    expect(uris(result.thread)).toContain(H.uri)
    expect(result.horizonContinuation).toBe('')
    expect(getReplyContinuation(PUB)).toBeUndefined()
    await settle()
    expect(getPostsCalls()).toEqual([])
  })
})
