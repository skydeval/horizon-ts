import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The speed pass (2026-10-23): the real `usePostThread` over fake prism and
 * AppView servers. A lens screen paints the cached anchor at once, with no
 * spinner, and the lens answer replaces it; `getThread` goes to prism
 * directly when a token is at hand, else through the PDS proxy; the
 * anchor's public view starts beside `getThread` and the pass does not ask
 * for it again; a press-in starts one lens read, which the screen takes.
 */

// The real thread hook loads slowly on a loaded machine (the first test).
jest.setTimeout(120_000)

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))
jest.mock('#/horizon/routing/membership', () => ({
  ...jest.requireActual<object>('#/horizon/routing/membership'),
  getMembership: () => 'member',
  useMembership: () => 'member',
  subscribeMembership: () => () => {},
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))
jest.mock('#/state/cache/post-shadow', () => ({
  dangerousGetPostShadow: () => undefined,
  updatePostShadow: () => {},
}))
jest.mock('#/horizon/private/quotes/resolve', () => ({
  resolveThreadQuotes: () => Promise.resolve(),
  resolvePrivateQuotes: () => Promise.resolve(),
}))
let mockPlaceholder: unknown
jest.mock('#/state/queries/usePostThread/queryCache', () => ({
  createCacheMutator: () => ({insertReplies: () => {}}),
  getThreadPlaceholder: () => mockPlaceholder,
  useUpdatePostThreadThreadgateQueryCache: () => () => {},
}))
let mockDirectClient: unknown
let mockToken: () => Promise<string>
let mockAppview: unknown
jest.mock('#/state/session', () => ({
  useAppviewClient: () => mockAppview,
  useSession: () => ({
    hasSession: true,
    currentAccount: {did: 'did:plc:readeraaaaaaaaaaaaaaaaaa'},
  }),
}))
jest.mock('#/state/preferences/moderation-opts', () => ({
  useModerationOpts: () => ({
    userDid: 'did:plc:readeraaaaaaaaaaaaaaaaaa',
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
    view: 'linear',
    setView: () => {},
  }),
}))
jest.mock('#/state/threadgate-hidden-replies', () => ({
  useMergeThreadgateHiddenReplies:
    () => (record?: {hiddenReplies?: string[]}) =>
      new Set(record?.hiddenReplies ?? []),
}))
jest.mock('#/alf', () => ({useBreakpoints: () => ({gtPhone: false})}))

import {type Client} from '@atproto/lex'
import {type QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook} from '@testing-library/react-native'

import {usePostThread} from '#/state/queries/usePostThread'
import {resetKnown} from '#/horizon/private/known'
import {clearCurrentClients} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {writeLocal} from '#/horizon/session/local-store'
import {resetLensRefusals, resetLensWaits} from '#/horizon/thread-lens/api'
import {installLensDirect, resetLensDirect} from '#/horizon/thread-lens/direct'
import {threadLensPreferenceKey} from '#/horizon/thread-lens/preference'
import {
  heldLensPrewarmCount,
  prewarmLensThread,
  resetLensPrewarms,
} from '#/horizon/thread-lens/prewarm'
import {resetLensViewPool} from '#/horizon/thread-lens/public-views'
import {resetLensRegistry} from '#/horizon/thread-lens/registry'
import {LENS_ROOT} from '#/horizon/thread-lens/snapshot'
import {
  AUTHOR,
  type Call,
  deferred,
  lensAnswer,
  postNode,
  publishClients,
  READER,
  type Reply,
  server,
  until,
  view,
} from './harness'

const ROOT = view('3kroot2222222')
const C1 = view('3kc1222222222', {parent: ROOT.uri, minutes: 2})
const GET_THREAD = 'app.nearhorizon.threadLens.getThread'

let held: ReturnType<typeof deferred<void>> | undefined
let prismCalls: Call[]
let directCalls: Call[]
let appviewCalls: Call[]

function lensHandler(call: Call): Promise<Reply> | Reply {
  if (call.nsid !== GET_THREAD) {
    return {status: 501, body: {error: 'MethodNotImplemented'}}
  }
  const answer = lensAnswer(ROOT.uri, [postNode(ROOT), postNode(C1)])
  return held ? held.promise.then(() => answer) : answer
}

function stockItem(post: typeof ROOT) {
  return {
    uri: post.uri,
    depth: 0,
    value: {
      $type: 'app.bsky.unspecced.defs#threadItemPost',
      post,
      moreParents: false,
      moreReplies: 0,
      opThread: false,
      hiddenByThreadgate: false,
      mutedByViewer: false,
    },
  }
}

function publish(): QueryClient {
  const prism = server(READER, lensHandler)
  const direct = server(READER, lensHandler)
  const appview = server(READER, call => {
    if (call.nsid === 'app.bsky.feed.getPosts') {
      const wanted = call.params.getAll('uris')
      return {
        status: 200,
        body: {posts: [ROOT, C1].filter(post => wanted.includes(post.uri))},
      }
    }
    return undefined
  })
  prismCalls = prism.calls
  directCalls = direct.calls
  appviewCalls = appview.calls
  mockDirectClient = direct.client
  mockAppview = appview.client
  return publishClients({prism: prism.client, appview: appview.client})
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

function renderThread(anchor: string, qc: QueryClient = publish()) {
  const hook = renderHook(() => usePostThread({anchor}), {
    wrapper: ({children}) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  })
  return {...hook, qc}
}

function count(calls: Call[], nsid: string) {
  return calls.filter(call => call.nsid === nsid).length
}

function askedUris(calls: Call[]) {
  return calls
    .filter(call => call.nsid === 'app.bsky.feed.getPosts')
    .flatMap(call => call.params.getAll('uris'))
}

beforeEach(() => {
  held = undefined
  mockPlaceholder = undefined
  mockToken = () => Promise.reject(new Error('no token'))
  resetPrismHealth()
  resetKnown()
  resetPrismFeatures()
  answerPrismFeatures(READER, ['private'])
  resetLensRefusals()
  resetLensWaits()
  resetLensRegistry()
  resetLensDirect()
  installLensDirect({
    token: () => mockToken(),
    client: () => mockDirectClient as Client,
    limitedUntil: () => undefined,
  })
  resetLensPrewarms()
  resetLensViewPool()
  writeLocal(threadLensPreferenceKey(READER), undefined)
  clearCurrentClients()
})

describe('Thread Lens first paint', () => {
  it('paints the cached anchor at once with no spinner, then the lens answer replaces it', async () => {
    mockPlaceholder = stockItem(ROOT)
    held = deferred<void>()
    const {result} = renderThread(ROOT.uri)
    // The first render: the lens key, the cached anchor, no anchor skeleton.
    expect(result.current.context.postThreadQueryKey[0]).toBe(LENS_ROOT)
    expect(result.current.state.isPlaceholderData).toBe(true)
    expect(result.current.state.lens.kind).toBe('placeholder')
    const first = result.current.data.items
    expect(first[0]).toMatchObject({type: 'threadPost', uri: ROOT.uri})
    expect(
      first.some(
        item =>
          item.type === 'skeleton' &&
          (item as {item?: string}).item === 'anchor',
      ),
    ).toBe(false)
    await settle()
    // Still waiting on prism: the cached anchor stays.
    expect(result.current.state.lens.kind).toBe('placeholder')
    expect(result.current.data.items[0]).toMatchObject({uri: ROOT.uri})

    held.resolve()
    await settle()
    expect(result.current.state.isPlaceholderData).toBe(false)
    expect(result.current.state.lens.kind).toBe('snapshot')
    const uris = result.current.data.items
      .filter(item => item.type === 'threadPost')
      .map(item => (item as {uri: string}).uri)
    expect(uris).toEqual([ROOT.uri, C1.uri])
  })

  it('opens a handle-form anchor without resolving the handle', async () => {
    mockPlaceholder = stockItem(ROOT)
    const handleUri = `at://${ROOT.author.handle}/app.bsky.feed.post/3kroot2222222`
    const {result} = renderThread(handleUri)
    await settle()
    expect(result.current.state.lens.kind).toBe('snapshot')
    expect(count(appviewCalls, 'com.atproto.identity.resolveHandle')).toBe(0)
    const body = prismCalls.find(call => call.nsid === GET_THREAD)?.body
    expect(body?.anchor).toBe(ROOT.uri)
  })
})

describe('Thread Lens transport', () => {
  it('calls prism directly when a token is at hand', async () => {
    mockToken = () => Promise.resolve('token')
    const {result} = renderThread(ROOT.uri)
    await settle()
    expect(result.current.state.lens.kind).toBe('snapshot')
    expect(count(directCalls, GET_THREAD)).toBe(1)
    expect(count(prismCalls, GET_THREAD)).toBe(0)
  })

  it('falls back to the PDS proxy when no token can be minted', async () => {
    const {result} = renderThread(ROOT.uri)
    await settle()
    expect(result.current.state.lens.kind).toBe('snapshot')
    expect(count(directCalls, GET_THREAD)).toBe(0)
    expect(count(prismCalls, GET_THREAD)).toBe(1)
  })

  it('sends a direct call that fails in transport through the proxy', async () => {
    mockToken = () => Promise.resolve('token')
    const qc = publish()
    mockDirectClient = server(
      READER,
      () => new TypeError('Failed to fetch'),
    ).client
    const {result} = renderThread(ROOT.uri, qc)
    await settle()
    expect(result.current.state.lens.kind).toBe('snapshot')
    expect(count(prismCalls, GET_THREAD)).toBe(1)
  })
})

describe('Thread Lens public-view pass', () => {
  it("starts the cached anchor's view beside getThread and does not ask again", async () => {
    mockPlaceholder = stockItem(ROOT)
    held = deferred<void>()
    const {result} = renderThread(ROOT.uri)
    await until(() => count(prismCalls, GET_THREAD) === 1)
    await until(() => askedUris(appviewCalls).includes(ROOT.uri))
    // The anchor's view was asked while getThread was still held.
    expect(result.current.state.lens.kind).toBe('placeholder')
    held.resolve()
    await settle()
    expect(result.current.state.lens.kind).toBe('snapshot')
    const asked = askedUris(appviewCalls)
    expect(asked.filter(uri => uri === ROOT.uri)).toHaveLength(1)
    expect(asked.filter(uri => uri === C1.uri)).toHaveLength(1)
  })
})

describe('Thread Lens press-in pre-warm', () => {
  it('starts one lens read per post, which the screen takes', async () => {
    const qc = publish()
    prewarmLensThread(qc, ROOT)
    prewarmLensThread(qc, ROOT)
    await until(() => count(prismCalls, GET_THREAD) === 1)
    expect(heldLensPrewarmCount()).toBe(1)
    const {result} = renderThread(ROOT.uri, qc)
    await settle()
    expect(result.current.state.lens.kind).toBe('snapshot')
    expect(count(prismCalls, GET_THREAD)).toBe(1)
    expect(heldLensPrewarmCount()).toBe(0)
  })

  it('starts nothing for a private post or with the lens off', async () => {
    const qc = publish()
    prewarmLensThread(qc, {
      ...ROOT,
      uri: `at://${AUTHOR}/tools.kryphocron.feed.postPrivate/3kpriv2222222`,
    })
    writeLocal(threadLensPreferenceKey(READER), '0')
    prewarmLensThread(qc, ROOT)
    await settle()
    expect(heldLensPrewarmCount()).toBe(0)
    expect(count(prismCalls, GET_THREAD)).toBe(0)
  })
})
