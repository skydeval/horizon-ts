import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The thread hook with hidden replies (hidden replies design 4.2, 4.4, 6.3;
 * tests 11, 22 and 23's hook half): the row, the instant tap on a done
 * prefetch, the close when a thread read changes the continuation, the tap's
 * reset, and the shown list's de-duplication against the thread.
 */

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  useMembership: () => 'member',
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
jest.mock('#/horizon/private/quotes/resolve', () => ({
  resolveThreadQuotes: () => Promise.resolve(),
}))
jest.mock('#/state/queries/usePostThread/queryCache', () => ({
  createCacheMutator: () => ({insertReplies: () => {}}),
  getThreadPlaceholder: () => undefined,
  useUpdatePostThreadThreadgateQueryCache: () => () => {},
}))
let mockReader = 'did:plc:privateaaaaaaaaaaaaaaaaa'
let mockAppview: unknown
jest.mock('#/state/session', () => ({
  useAppviewClient: () => mockAppview,
  useSession: () => ({hasSession: true, currentAccount: {did: mockReader}}),
}))
jest.mock('#/state/preferences/moderation-opts', () => ({
  useModerationOpts: () => ({
    userDid: mockReader,
    prefs: {
      adultContentEnabled: false,
      labels: {},
      labelers: [],
      mutedWords: [],
      hiddenPosts: [],
    },
    labelDefs: {},
  }),
}))
jest.mock('#/state/queries/preferences/useThreadPreferences', () => ({
  useThreadPreferences: () => ({
    isLoaded: true,
    sort: 'oldest',
    setSort: () => {},
    view: 'tree',
    setView: () => {},
  }),
}))
jest.mock('#/state/threadgate-hidden-replies', () => ({
  useMergeThreadgateHiddenReplies:
    () => (record?: {hiddenReplies?: string[]}) =>
      new Set(record?.hiddenReplies ?? []),
}))
jest.mock('#/alf', () => ({useBreakpoints: () => ({gtPhone: false})}))

import {useEffect} from 'react'
import {AtUri} from '@atproto/syntax'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook} from '@testing-library/react-native'

import {
  createPostThreadOtherQueryKey,
  createPostThreadQueryKey,
  usePostThread,
} from '#/state/queries/usePostThread'
import {resetKnown} from '#/horizon/private/known'
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
import {clearPrivateStores} from '../store'
import {resetReplyContinuations} from '../thread/continuation'
import {DID, fakeClient, OTHER_DID, privateUri, RECORD_CID} from './fixtures'
import {at, fakeAppview, type PrivateView, privateView} from './read-fixtures'

const READER = 'did:plc:readerccccccccccccccccccc'
const ANCHOR = privateUri('3kanchor22222')
const ANCHOR_REF = {uri: ANCHOR, cid: RECORD_CID}

function reply(rkey: string): PrivateView {
  return privateView(rkey, {
    did: OTHER_DID,
    minutes: 1,
    reply: {root: ANCHOR_REF, parent: ANCHOR_REF},
  })
}

const Q = reply('3kqqqqqqqqqq')
const X = reply('3kxxxxxxxxxx')

function node(post: object, replies: unknown[] = []) {
  return {
    $type: 'app.nearhorizon.private.defs#privateThreadView',
    post,
    replies,
  }
}

let gateHidden: string[]
let servedReplies: PrivateView[]
let degraded: boolean
let prismCalls: string[]
let queryClient: QueryClient

function publish() {
  prismCalls = []
  const prism = fakeClient(mockReader, call => {
    prismCalls.push(call.nsid)
    if (call.nsid === 'app.nearhorizon.private.getPostThread') {
      return {
        status: 200,
        body: {
          thread: node(
            {
              ...privateView('3kanchor22222'),
              replyCount: 2,
              repostCount: 0,
              likeCount: 0,
              quoteCount: 0,
              threadgate: {
                uri: `at://${DID}/app.bsky.feed.threadgate/3kanchor22222`,
                cid: RECORD_CID,
                record: {
                  $type: 'app.bsky.feed.threadgate',
                  post: ANCHOR,
                  createdAt: at(0),
                  hiddenReplies: gateHidden,
                },
                lists: [],
              },
            },
            servedReplies.map(view => node(view)),
          ),
          ...(degraded ? {degraded: true} : {}),
        },
      }
    }
    if (call.nsid === 'app.nearhorizon.private.getPosts') {
      const wanted = call.params.getAll('uris')
      return {
        status: 200,
        body: {posts: [Q, X].filter(p => wanted.includes(p.uri))},
      }
    }
    return {status: 501, body: {error: 'MethodNotImplemented'}}
  })
  const appview = fakeAppview()
  mockAppview = appview.client
  queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  publishCurrentClients({
    did: mockReader,
    handle: 'reader.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: appview.client,
    queryClient,
  })
}

function confirm() {
  reportReadOutcome(mockReader, {
    kind: 'answered',
    method: 'app.nearhorizon.private.getPosts',
    seq: nextAnswerSeq(mockReader),
    read: true,
    degraded: false,
    retryAfterMs: undefined,
  })
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

type Hook = ReturnType<typeof usePostThread>
type Item = Hook['data']['items'][number]

/** Every committed render's items and row state, in order. */
let commits: {items: Item[]; open: boolean}[]

function renderThread(anchor = ANCHOR) {
  return renderHook(
    () => {
      const hook = usePostThread({anchor})
      useEffect(() => {
        commits.push({
          items: hook.data.items,
          open: hook.state.otherItemsVisible,
        })
      })
      return hook
    },
    {
      wrapper: ({children}) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  )
}

function postUris(items: Item[]) {
  return items
    .filter(item => item.type === 'threadPost')
    .map(item => (item as {uri: string}).uri)
}

function count(items: Item[], uri: string) {
  return postUris(items).filter(u => u === uri).length
}

function row(items: Item[]) {
  return items.find(item => item.type === 'showOtherReplies') as
    {onPress: () => void} | undefined
}

/** The anchor's other-replies query. */
function otherQuery() {
  const query = queryClient.getQueryCache().find({
    queryKey: createPostThreadOtherQueryKey({anchor: ANCHOR}),
    exact: true,
  })
  if (!query) throw new Error('no other-replies query')
  return query
}

/** The stock "Reply Hidden by You" alert's inputs (ThreadItemPost). */
function hasReplyHiddenAlert(hook: Hook, uri: string) {
  const hidden = new Set(
    (hook.data.threadgate?.record as {hiddenReplies?: string[]} | undefined)
      ?.hiddenReplies ?? [],
  )
  return new AtUri(ANCHOR).host === mockReader && hidden.has(uri)
}

beforeEach(() => {
  mockReader = DID
  gateHidden = [Q.uri]
  servedReplies = [X]
  degraded = false
  commits = []
  resetPrismHealth()
  resetKnown()
  resetPrismFeatures()
  answerPrismFeatures(DID, ['private'])
  answerPrismFeatures(READER, ['private'])
  clearPrivateStores()
  resetReplyContinuations()
  clearCurrentClients()
})

describe('the row and the tap (test 11)', () => {
  it('for the OP: the row shows; the tap shows the reply at once with a done prefetch, with the alert', async () => {
    publish()
    confirm()
    const {result} = renderThread()
    await settle()
    expect(row(result.current.data.items)).toBeDefined()
    expect(prismCalls).toContain('app.nearhorizon.private.getPosts')
    prismCalls = []
    act(() => row(result.current.data.items)!.onPress())
    await settle()
    expect(count(result.current.data.items, Q.uri)).toBe(1)
    // Read from the prefetch: no prism call on the tap.
    expect(prismCalls).toEqual([])
    expect(hasReplyHiddenAlert(result.current, Q.uri)).toBe(true)
  })

  it('for another reader: the reply, no alert', async () => {
    mockReader = READER
    publish()
    confirm()
    const {result} = renderThread()
    await settle()
    act(() => row(result.current.data.items)!.onPress())
    await settle()
    expect(count(result.current.data.items, Q.uri)).toBe(1)
    expect(hasReplyHiddenAlert(result.current, Q.uri)).toBe(false)
  })
})

describe('a stock thread (test 22)', () => {
  const PUB_DID = 'did:plc:publicccccccccccccccccccc'
  const PUB = `at://${PUB_DID}/app.bsky.feed.post/3kanchor22222`
  const OTHER = `at://${PUB_DID}/app.bsky.feed.post/3kotherrepl2`

  function publicItem(uri: string, depth: number) {
    return {
      uri,
      depth,
      value: {
        $type: 'app.bsky.unspecced.defs#threadItemPost',
        post: {
          uri,
          cid: RECORD_CID,
          author: {did: PUB_DID, handle: 'pub.test'},
          record: {
            $type: 'app.bsky.feed.post',
            text: uri,
            createdAt: at(0),
            ...(depth > 0
              ? {
                  reply: {
                    root: {uri: PUB, cid: RECORD_CID},
                    parent: {uri: PUB, cid: RECORD_CID},
                  },
                }
              : {}),
          },
          indexedAt: at(0),
        },
        moreParents: false,
        moreReplies: 0,
        opThread: false,
        hiddenByThreadgate: false,
        mutedByViewer: false,
      },
    }
  }

  it('never closes or resets', async () => {
    publish()
    confirm()
    let otherReads = 0
    mockAppview = fakeClient(mockReader, call => {
      if (call.nsid === 'app.bsky.unspecced.getPostThreadV2') {
        return {
          status: 200,
          body: {thread: [publicItem(PUB, 0)], hasOtherReplies: true},
        }
      }
      if (call.nsid === 'app.bsky.unspecced.getPostThreadOtherV2') {
        otherReads++
        return {status: 200, body: {thread: [publicItem(OTHER, 1)]}}
      }
      return {status: 501, body: {error: 'MethodNotImplemented'}}
    }).client
    const {result} = renderThread(PUB)
    await settle()
    act(() => row(result.current.data.items)!.onPress())
    await settle()
    expect(count(result.current.data.items, OTHER)).toBe(1)
    expect(otherReads).toBe(1)
    await act(async () => {
      await result.current.actions.refetch()
    })
    await settle()
    expect(result.current.state.otherItemsVisible).toBe(true)
    expect(count(result.current.data.items, OTHER)).toBe(1)
    expect(otherReads).toBe(1)
  })
})

describe('the close (4.2, HR5-L1; tests 22, 23)', () => {
  async function openRow() {
    publish()
    confirm()
    const view = renderThread()
    await settle()
    act(() => row(view.result.current.data.items)!.onPress())
    await settle()
    expect(view.result.current.state.otherItemsVisible).toBe(true)
    return view
  }

  it('a refetch that adds X to the candidates closes the row in its first committed render; the tap resets and shows X', async () => {
    const {result} = await openRow()
    expect(count(result.current.data.items, X.uri)).toBe(1)
    commits = []
    gateHidden = [Q.uri, X.uri]
    servedReplies = []
    await act(async () => {
      await result.current.actions.refetch()
    })
    await settle()
    const first = commits.findIndex(c => count(c.items, X.uri) === 0)
    expect(first).toBeGreaterThanOrEqual(0)
    for (const c of commits.slice(first)) expect(c.open).toBe(false)
    for (const c of commits)
      expect(count(c.items, X.uri)).toBeLessThanOrEqual(1)
    act(() => row(result.current.data.items)!.onPress())
    await settle()
    expect(count(result.current.data.items, X.uri)).toBe(1)
    expect(count(result.current.data.items, Q.uri)).toBe(1)
    expect(hasReplyHiddenAlert(result.current, X.uri)).toBe(true)
  })

  it('a refetch that removes X (now inline) closes the row, and X is once in every committed render', async () => {
    gateHidden = [Q.uri, X.uri]
    servedReplies = []
    const {result} = await openRow()
    expect(count(result.current.data.items, X.uri)).toBe(1)
    commits = []
    gateHidden = [Q.uri]
    servedReplies = [X]
    await act(async () => {
      await result.current.actions.refetch()
    })
    await settle()
    expect(result.current.state.otherItemsVisible).toBe(false)
    for (const c of commits) expect(count(c.items, X.uri)).toBe(1)
  })

  it('a refetch with an equal key keeps the row open and resets nothing', async () => {
    const {result} = await openRow()
    const other = otherQuery()
    const updatedAt = other.state.dataUpdatedAt
    expect(updatedAt).toBeGreaterThan(0)
    await act(async () => {
      await result.current.actions.refetch()
    })
    await settle()
    expect(result.current.state.otherItemsVisible).toBe(true)
    expect(count(result.current.data.items, Q.uri)).toBe(1)
    expect(otherQuery()).toBe(other)
    expect(other.state.dataUpdatedAt).toBe(updatedAt)
  })

  it('the close makes no prism call, on a degraded read too', async () => {
    const {result} = await openRow()
    degraded = true
    gateHidden = [Q.uri, X.uri]
    servedReplies = []
    prismCalls = []
    await act(async () => {
      await result.current.actions.refetch()
    })
    await settle()
    expect(result.current.state.otherItemsVisible).toBe(false)
    expect(prismCalls).toEqual(['app.nearhorizon.private.getPostThread'])
  })

  it('further replies read under another key with one reply in both lists show it once (4.4)', async () => {
    const {result} = await openRow()
    const other = otherQuery()
    const data = other.state.data as {thread: {uri: string}[]}
    const thread = queryClient
      .getQueryCache()
      .find({
        queryKey: createPostThreadQueryKey({
          anchor: ANCHOR,
          sort: 'oldest',
          view: 'tree',
        }),
        exact: true,
      })!
    const inline = (thread.state.data as {thread: {uri: string}[]}).thread.find(
      item => item.uri === X.uri,
    )
    expect(inline).toBeDefined()
    act(() => {
      queryClient.setQueryData(other.queryKey, {
        ...data,
        thread: [...data.thread, inline],
        horizonContinuation: 'another',
      })
    })
    await settle()
    // The further replies now hold X too (the change rendered).
    expect(
      (otherQuery().state.data as {thread: {uri: string}[]}).thread.map(
        item => item.uri,
      ),
    ).toContain(X.uri)
    expect(result.current.state.otherItemsVisible).toBe(true)
    expect(count(result.current.data.items, X.uri)).toBe(1)
  })
})
