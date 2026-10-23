import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Hidden replies on kryphocron threads (hidden replies design 4.1, 4.2, 5.4,
 * 6.1, 6.2, 6.4): the candidates and the first guess, the continuation and
 * its key, the prefetch and its start test, the row's correction, and the
 * root gate under a public root. Tests 1, 2, 3, 12, 13, 14, 16, 17, 18, 20
 * (kryphocron half), 24 (prefetch half) and 25.
 */

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMember = true
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did && mockMember,
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
let mockSuspect = false
jest.mock('#/horizon/private/known', () => {
  const actual = jest.requireActual<Record<string, unknown>>(
    '#/horizon/private/known',
  )
  const held = actual.heldPostRefetchInterval as (
    mockUri?: string,
    mockDid?: string,
  ) => number | false
  return {
    ...actual,
    heldPostRefetchInterval: (uri?: string, did?: string) =>
      mockSuspect ? 1_000 : held(uri, did),
  }
})
jest.mock('#/horizon/private/adapt/pds', () => ({
  ...jest.requireActual<object>('#/horizon/private/adapt/pds'),
  authorPdsUrl: () => Promise.resolve('https://pds.example'),
}))
let mockPdsFetch: (url: string) => Promise<Response>
jest.mock('#/state/session/network', () => ({
  ...jest.requireActual<object>('#/state/session/network'),
  networkAwareFetch: (input: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as {url: string}).url
    return mockPdsFetch(url)
  },
}))

import {QueryClient} from '@tanstack/react-query'

import {rootThreadgateQueryKey} from '#/horizon/private/api/gates'
import {hold, resetKnown} from '#/horizon/private/known'
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
  reportProbeStatus,
  reportReadOutcome,
  resetPrismHealth,
} from '#/horizon/routing/health'
import {clearPrivateStores} from '../store'
import {
  continuationKey,
  getReplyContinuation,
  type ReplyContinuation,
  resetReplyContinuations,
  setReplyContinuation,
} from '../thread/continuation'
import {fetchPrivateThreadV2} from '../thread/fetch'
import {
  ensureHidden,
  type HiddenAnswer,
  hiddenRepliesKey,
  prefetchHiddenReplies,
  readHiddenReplies,
} from '../thread/hidden'
import {fetchOtherReplies} from '../thread/replies'
import {DID, OTHER_DID, privateUri, RECORD_CID, type Reply} from './fixtures'
import {
  at,
  fakeAppview,
  fakePrism,
  type PrivateView,
  privateView,
} from './read-fixtures'

const KEY = ['post-thread-v2', {anchor: 'x'}]
const OTHER_KEY = ['post-thread-v2', 'other', {anchor: 'x'}]
const ANCHOR = privateUri('3kanchor22222')
const ANCHOR_REF = {uri: ANCHOR, cid: RECORD_CID}

const counts = (replyCount: number) => ({
  replyCount,
  repostCount: 0,
  likeCount: 0,
  quoteCount: 0,
})

function gateRecord(post: string, hiddenReplies: string[]) {
  return {
    $type: 'app.bsky.feed.threadgate',
    post,
    createdAt: at(0),
    hiddenReplies,
  }
}

function gateView(post: string, hiddenReplies: string[]) {
  return {
    uri: `at://${DID}/app.bsky.feed.threadgate/3kanchor22222`,
    cid: RECORD_CID,
    record: gateRecord(post, hiddenReplies),
    lists: [],
  }
}

/** A reply to `parent` in the thread rooted at `root`. */
function reply(
  rkey: string,
  {
    did = OTHER_DID,
    parent = ANCHOR_REF,
    root = ANCHOR_REF,
    text,
  }: {
    did?: string
    parent?: {uri: string; cid: string}
    root?: {uri: string; cid: string}
    text?: unknown
  } = {},
): PrivateView {
  const view = privateView(rkey, {did, minutes: 1, reply: {root, parent}})
  if (text !== undefined) {
    return {...view, record: {...view.record, text}} as unknown as PrivateView
  }
  return view
}

const X = reply('3kxxxxxxxxxx')
const Y = reply('3kyyyyyyyyyy', {did: DID})
const Z = reply('3kzzzzzzzzzz')
// A reply to Z, deeper than the anchor's direct replies.
const D = reply('3kdddddddddd', {parent: {uri: Z.uri, cid: RECORD_CID}})

function node(post: object, replies: unknown[] = []) {
  return {
    $type: 'app.nearhorizon.private.defs#privateThreadView',
    post,
    replies,
  }
}

type Served = {
  thread: () => Reply | Promise<Reply>
  posts: PrivateView[]
}

let served: Served
let getPostsAsked: string[][]
let queryClient: QueryClient
let context: {client: QueryClient; queryKey: typeof KEY}
let prismClient: ReturnType<typeof fakePrism>['client']

function publish() {
  getPostsAsked = []
  const prism = fakePrism({
    handler: (nsid, params) => {
      if (nsid === 'app.nearhorizon.private.getPostThread') {
        return served.thread() as Reply
      }
      if (nsid === 'app.nearhorizon.private.getPosts') {
        const wanted = params.getAll('uris')
        getPostsAsked.push(wanted)
        return {
          status: 200,
          body: {posts: served.posts.filter(p => wanted.includes(p.uri))},
        }
      }
      return undefined
    },
  })
  prismClient = prism.client
  queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  context = {client: queryClient, queryKey: KEY}
  publishCurrentClients({
    did: DID,
    handle: 'me.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: fakeAppview().client,
    queryClient,
  })
  return prism
}

/** prism serves the anchor (gate listing `hidden`) with `replies`. */
function serveThread(
  hidden: string[],
  replies: unknown[],
  extra: object = {},
  body: object = {},
) {
  served.thread = () => ({
    status: 200,
    body: {
      thread: node(
        {
          ...privateView('3kanchor22222'),
          threadgate: gateView(ANCHOR, hidden),
          ...extra,
        },
        replies,
      ),
      ...body,
    },
  })
}

/** A private read answered 2xx: prism confirmed (busy design 2.1). */
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

async function read() {
  const result = await fetchPrivateThreadV2(ANCHOR, {below: 10}, context)
  queryClient.setQueryData(KEY, {...result, horizonFetchedAt: 123})
  return result
}

function threadData() {
  return queryClient.getQueryData<{
    hasOtherReplies: boolean
    horizonFetchedAt?: number
    horizonContinuation?: string
  }>(KEY)
}

beforeEach(() => {
  mockMember = true
  mockSuspect = false
  mockPdsFetch = () => Promise.reject(new Error('no PDS in this test'))
  served = {thread: () => ({status: 500, body: {}}), posts: [X, Y, Z, D]}
  resetPrismHealth()
  resetKnown()
  resetPrismFeatures()
  answerPrismFeatures(DID, ['private'])
  clearPrivateStores()
  resetReplyContinuations()
  clearCurrentClients()
  publish()
})

describe('candidates and the first guess (4.2; tests 1, 2)', () => {
  it('takes the gate’s unserved private URIs of other authors, shows the row, and starts one prefetch', async () => {
    confirm()
    serveThread([X.uri, Y.uri, Z.uri], [node({...Z, ...counts(0)})], counts(3))
    const result = await read()
    expect(result.hasOtherReplies).toBe(true)
    const continuation = getReplyContinuation(ANCHOR)
    expect(continuation?.hidden).toEqual([X.uri])
    expect(continuation?.pages).toBe(false)
    expect(result.horizonContinuation).toBe(continuation?.key)
    await settle()
    expect(getPostsAsked).toEqual([[X.uri]])
  })

  it('no candidates: no row, no continuation, no prefetch', async () => {
    confirm()
    serveThread([Z.uri], [node(Z)])
    const result = await read()
    expect(result.hasOtherReplies).toBe(false)
    expect(result.horizonContinuation).toBe('')
    expect(getReplyContinuation(ANCHOR)).toBeUndefined()
    await settle()
    expect(getPostsAsked).toEqual([])
  })

  it('with counts served and nothing unserved, no row until a cached answer says otherwise', async () => {
    serveThread([X.uri], [node({...Z, ...counts(0)})], counts(1))
    const first = await read()
    expect(first.hasOtherReplies).toBe(false)
    queryClient.setQueryData(hiddenRepliesKey(DID, ANCHOR, [X.uri]), {
      candidates: [X.uri],
      asked: [X.uri],
      nodes: [],
      views: new Map(),
      direct: 1,
      readAll: true,
      stamp: 0,
    } satisfies HiddenAnswer)
    const second = await read()
    expect(second.hasOtherReplies).toBe(true)
  })
})

describe('the prefetch’s start test (6.2; test 12)', () => {
  beforeEach(() => {
    serveThread([X.uri], [], counts(1))
  })

  it('none when prism was not confirmed at the read’s start', async () => {
    await read()
    await settle()
    expect(getPostsAsked).toEqual([])
  })

  it('none when prism is not confirmed at its end', async () => {
    confirm()
    const thread = served.thread
    served.thread = () => {
      reportProbeStatus(DID, 'reindexing')
      return thread()
    }
    await read()
    await settle()
    expect(getPostsAsked).toEqual([])
  })

  it('none when the anchor was a suspect at its start', async () => {
    confirm()
    mockSuspect = true
    await read()
    await settle()
    expect(getPostsAsked).toEqual([])
  })

  it('none on a degraded answer', async () => {
    confirm()
    serveThread([X.uri], [], counts(1), {degraded: true})
    await read()
    await settle()
    expect(getPostsAsked).toEqual([])
  })

  it('a thread held with no URI still prefetches on a confirmed read', async () => {
    confirm()
    hold(KEY, undefined, queryClient, DID)
    await read()
    await settle()
    expect(getPostsAsked).toEqual([[X.uri]])
  })
})

describe('the read (6.1; tests 3, 17, 24)', () => {
  const clients = () => ({
    prismClient,
    appviewClient: fakeAppview({
      profiles: [{did: OTHER_DID, handle: 'other.test'}],
    }).client,
  })

  it('keeps direct replies only, adapted and tagged with the answer’s arrival; a view the adapter drops is skipped', async () => {
    const dropped = reply('3kdrop222222', {text: 5})
    served.posts = [X, D, dropped]
    const answer = await readHiddenReplies(
      clients(),
      ANCHOR,
      [X.uri, D.uri, dropped.uri],
      [X.uri, D.uri, dropped.uri],
      () => RECORD_CID,
    )
    expect(answer.nodes.map(n => n.input.view.uri)).toEqual([
      X.uri,
      dropped.uri,
    ])
    expect(answer.readAll).toBe(true)
    expect([...answer.views.keys()]).toEqual([X.uri])
    const view = answer.views.get(X.uri) as {
      horizonFromCache?: number
      author: {handle: string}
    }
    expect(view.horizonFromCache).toBe(answer.stamp)
    expect(view.author.handle).toBe('other.test')
  })

  it('the prefetch asks at most the 50 newest; past them readAll is false and the answer keeps all 60', async () => {
    const many = Array.from({length: 60}, (_, i) =>
      reply(`3kmany${String(i).padStart(6, '0')}`),
    )
    served.posts = many
    const candidates = many.map(v => v.uri)
    setReplyContinuation(ANCHOR, continuationFor(candidates))
    prefetchHiddenReplies({
      client: queryClient,
      threadKey: KEY,
      clients: clients(),
      did: DID,
      anchor: ANCHOR,
      anchorUri: ANCHOR,
      candidates,
      cidOf: () => RECORD_CID,
      unserved: undefined,
    })
    await settle()
    const answer = queryClient.getQueryData<HiddenAnswer>(
      hiddenRepliesKey(DID, ANCHOR, candidates),
    )
    expect(answer?.asked).toEqual(candidates.slice(10))
    expect(answer?.candidates).toEqual(candidates)
    expect(answer?.readAll).toBe(false)
    expect(getPostsAsked.flat().sort()).toEqual(candidates.slice(10).sort())
  })
})

function continuationFor(
  hidden: string[],
  extra: Partial<ReplyContinuation> = {},
): ReplyContinuation {
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
    key: continuationKey({kind: 'private', pages: false, hidden}),
    hidden,
    pages: false,
    readAt: 0,
    ...extra,
  }
}

describe('the row corrected (6.4; tests 3, 14, 18)', () => {
  function prefetch(candidates: string[], unserved?: number) {
    prefetchHiddenReplies({
      client: queryClient,
      threadKey: KEY,
      clients: {prismClient, appviewClient: fakeAppview().client},
      did: DID,
      anchor: ANCHOR,
      anchorUri: ANCHOR,
      candidates,
      cidOf: () => RECORD_CID,
      unserved,
    })
  }

  it('takes the row away when no candidate is a direct reply, and keeps the stamp', async () => {
    setReplyContinuation(ANCHOR, continuationFor([D.uri]))
    queryClient.setQueryData(KEY, {
      thread: [],
      hasOtherReplies: true,
      horizonFetchedAt: 123,
      horizonContinuation: 'k',
    })
    prefetch([D.uri])
    await settle()
    expect(threadData()).toMatchObject({
      hasOtherReplies: false,
      horizonFetchedAt: 123,
      horizonContinuation: 'k',
    })
  })

  it('brings the row when a candidate is a direct reply', async () => {
    setReplyContinuation(ANCHOR, continuationFor([X.uri]))
    queryClient.setQueryData(KEY, {thread: [], hasOtherReplies: false})
    prefetch([X.uri])
    await settle()
    expect(threadData()?.hasOtherReplies).toBe(true)
  })

  it('an answer for other candidates writes nothing, runs on its own key and cancels nothing; a tap on the older key gets its items', async () => {
    setReplyContinuation(ANCHOR, continuationFor([X.uri, Z.uri]))
    queryClient.setQueryData(KEY, {thread: [], hasOtherReplies: true})
    prefetch([D.uri])
    prefetch([X.uri])
    await settle()
    expect(threadData()?.hasOtherReplies).toBe(true)
    expect(getPostsAsked).toEqual([[D.uri], [X.uri]])
    // A tap reading the older key (its continuation) gets its items.
    const older = continuationFor([X.uri])
    const {nodes} = await ensureHidden(
      queryClient,
      {prismClient, appviewClient: fakeAppview().client},
      DID,
      ANCHOR,
      older,
    )
    expect(nodes.map(n => n.input.view.uri)).toEqual([X.uri])
  })

  it('with counts served and every candidate read, a gap made only of hidden direct replies pages nothing; the key stays (test 14)', async () => {
    confirm()
    answerPrismFeatures(DID, ['private', 'private.paging'])
    serveThread([X.uri], [node({...Z, ...counts(0)})], counts(2))
    const result = await read()
    expect(getReplyContinuation(ANCHOR)?.pages).toBe(true)
    const key = getReplyContinuation(ANCHOR)?.key
    await settle()
    expect(getReplyContinuation(ANCHOR)?.pages).toBe(false)
    expect(getReplyContinuation(ANCHOR)?.key).toBe(key)
    expect(threadData()?.horizonContinuation).toBe(key)
    expect(result.horizonContinuation).toBe(key)
    expect(threadData()?.hasOtherReplies).toBe(true)
    // A later read takes the cached verdict: narrowed, the same key.
    const again = await read()
    expect(getReplyContinuation(ANCHOR)?.pages).toBe(false)
    expect(again.horizonContinuation).toBe(key)
  })
})

describe('the continuation replaced at the read’s end (4.2, HR2-L2; test 16)', () => {
  it('a read in flight leaves the previous one; an other-replies read beside it reads from it and returns its items', async () => {
    confirm()
    serveThread([X.uri], [], counts(1))
    await read()
    await settle()
    const previous = getReplyContinuation(ANCHOR)
    expect(previous?.hidden).toEqual([X.uri])
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const thread = served.thread
    served.thread = async () => {
      await gate
      return thread()
    }
    const pending = read()
    const other = fetchOtherReplies(
      ANCHOR,
      () => Promise.reject(new Error('never the stock call')),
      {client: queryClient, queryKey: OTHER_KEY},
    )
    expect(getReplyContinuation(ANCHOR)).toBe(previous)
    const items = (await other).thread
    expect(items.map(item => item.uri)).toEqual([X.uri])
    release()
    await pending
  })

  it('a read with nothing to continue clears it at its end', async () => {
    setReplyContinuation(ANCHOR, continuationFor([X.uri]))
    serveThread([], [])
    await read()
    expect(getReplyContinuation(ANCHOR)).toBeUndefined()
  })

  it('a non-member or a missed anchor clears it; a throw leaves it', async () => {
    setReplyContinuation(ANCHOR, continuationFor([X.uri]))
    mockMember = false
    await read()
    expect(getReplyContinuation(ANCHOR)).toBeUndefined()
    mockMember = true

    setReplyContinuation(ANCHOR, continuationFor([X.uri]))
    served.thread = () => ({
      status: 400,
      body: {error: 'NotFound', message: 'x'},
    })
    await read().catch(() => {})
    expect(getReplyContinuation(ANCHOR)).toBeUndefined()

    const kept = continuationFor([X.uri])
    setReplyContinuation(ANCHOR, kept)
    served.thread = () => ({
      status: 400,
      body: {error: 'InvalidRequest', message: 'x'},
    })
    await expect(read()).rejects.toBeDefined()
    expect(getReplyContinuation(ANCHOR)).toBe(kept)
  })
})

describe('the key (4.1; test 20, kryphocron half)', () => {
  it('is equal for equal kind, pages and hidden in any order', () => {
    const key = continuationKey({
      kind: 'private',
      pages: true,
      hidden: ['a', 'b'],
    })
    expect(
      continuationKey({kind: 'private', pages: true, hidden: ['b', 'a']}),
    ).toBe(key)
    expect(
      continuationKey({kind: 'private', pages: false, hidden: ['a', 'b']}),
    ).not.toBe(key)
    expect(
      continuationKey({kind: 'public', pages: true, hidden: ['a', 'b']}),
    ).not.toBe(key)
    expect(key).not.toBe('')
  })

  it('the thread read carries it, and invalidates no other-replies query', async () => {
    confirm()
    serveThread([X.uri], [], counts(1))
    queryClient.setQueryData(OTHER_KEY, {thread: []})
    const result = await read()
    expect(result.horizonContinuation).toBe(getReplyContinuation(ANCHOR)?.key)
    await settle()
    expect(queryClient.getQueryState(OTHER_KEY)?.isInvalidated).toBe(false)
  })
})

describe('a kryphocron anchor under a public root (5.4; tests 13, 25)', () => {
  const ROOT = `at://${OTHER_DID}/app.bsky.feed.post/3kpubroot222`
  const ROOT_REF = {uri: ROOT, cid: RECORD_CID}
  const H = reply('3khhhhhhhhhh', {root: ROOT_REF})

  function serveBranch() {
    served.posts = [H]
    served.thread = () => ({
      status: 200,
      body: {
        thread: node(
          {
            ...privateView('3kanchor22222', {
              reply: {root: ROOT_REF, parent: ROOT_REF},
            }),
            ...counts(1),
          },
          [],
        ),
      },
    })
  }

  function pdsGate(hiddenReplies: string[]) {
    return (url: string) => {
      expect(url).toContain('com.atproto.repo.getRecord')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uri: `at://${OTHER_DID}/app.bsky.feed.threadgate/3kpubroot222`,
            value: gateRecord(ROOT, hiddenReplies),
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        ),
      )
    }
  }

  const failing = () =>
    Promise.resolve(
      new Response(JSON.stringify({error: 'InternalServerError'}), {
        status: 500,
        headers: {'content-type': 'application/json'},
      }),
    )

  it('returns the PDS gate as the thread’s threadgate and takes the candidates from it', async () => {
    serveBranch()
    mockPdsFetch = pdsGate([H.uri])
    const result = await read()
    expect(result.threadgate?.uri).toBe(
      `at://${OTHER_DID}/app.bsky.feed.threadgate/3kpubroot222`,
    )
    expect(result.threadgate?.cid).toBeUndefined()
    expect(
      (result.threadgate?.record as {hiddenReplies?: string[]}).hiddenReplies,
    ).toEqual([H.uri])
    expect(getReplyContinuation(ANCHOR)?.hidden).toEqual([H.uri])
    expect(result.hasOtherReplies).toBe(true)
  })

  it('a failed read with nothing cached gives no gate and no candidates', async () => {
    serveBranch()
    mockPdsFetch = failing
    const result = await read()
    expect(result.threadgate).toBeUndefined()
    expect(getReplyContinuation(ANCHOR)).toBeUndefined()
  })

  it('a failed read over a cached record takes the gate and the candidates from it (HR4-N2)', async () => {
    serveBranch()
    queryClient.setQueryData(
      rootThreadgateQueryKey(ROOT),
      gateRecord(ROOT, [H.uri]),
      {updatedAt: Date.now() - 60_000},
    )
    mockPdsFetch = failing
    const result = await read()
    expect(
      (result.threadgate?.record as {hiddenReplies?: string[]}).hiddenReplies,
    ).toEqual([H.uri])
    expect(getReplyContinuation(ANCHOR)?.hidden).toEqual([H.uri])
  })

  it('a read past its deadline over a cached record takes the cached record', async () => {
    serveBranch()
    queryClient.setQueryData(
      rootThreadgateQueryKey(ROOT),
      gateRecord(ROOT, [H.uri]),
      {updatedAt: Date.now() - 60_000},
    )
    mockPdsFetch = () => new Promise<Response>(() => {})
    const result = await read()
    expect(getReplyContinuation(ANCHOR)?.hidden).toEqual([H.uri])
    expect(result.threadgate?.record).toBeDefined()
  }, 20_000)
})
