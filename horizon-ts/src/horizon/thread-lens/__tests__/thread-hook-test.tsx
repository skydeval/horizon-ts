import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The stock thread query with the Thread Lens hooks (Phase 4 design 7.1,
 * 11.3, 12.2: TH-1, TH-2, TH-14, TH-17, TH-18, TH-22): the real
 * `usePostThread` over fake prism and AppView servers. A member's public
 * thread reads the lens under its own key and renders gaps as placeholders
 * with the conversation kept; turning the lens off reads the stock thread
 * under the stock key; a failed lens read falls back to the stock read in
 * the same run, tagged; a private anchor never touches the lens.
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
jest.mock('#/state/queries/usePostThread/queryCache', () => ({
  createCacheMutator: () => ({insertReplies: () => {}}),
  getThreadPlaceholder: () => undefined,
  useUpdatePostThreadThreadgateQueryCache: () => () => {},
}))
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

import {QueryClientProvider} from '@tanstack/react-query'
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
import {gapInfoOf} from '#/horizon/thread-lens/adapt'
import {resetLensRefusals, resetLensWaits} from '#/horizon/thread-lens/api'
import {THREAD_LENS_PREFERENCE_KEY} from '#/horizon/thread-lens/preference'
import {resetLensRegistry} from '#/horizon/thread-lens/registry'
import {LENS_ROOT} from '#/horizon/thread-lens/snapshot'
import {
  BLOCKED,
  type Call,
  gapNode,
  lensAnswer,
  postNode,
  privateUriOf,
  publishClients,
  READER,
  server,
  uriOf,
  view,
} from './harness'

const ROOT = view('3kroot2222222')
const B1 = uriOf('3kb1222222222', BLOCKED)
const C1 = view('3kc1222222222', {parent: B1, root: ROOT.uri, minutes: 2})

let lensFails: boolean
let prismCalls: Call[]
let appviewCalls: Call[]

function stockItem(post: typeof ROOT, depth: number) {
  return {
    uri: post.uri,
    depth,
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

function publish() {
  const prism = server(READER, call => {
    if (call.nsid === 'app.nearhorizon.threadLens.getThread') {
      if (lensFails) return {status: 500, body: {error: 'InternalServerError'}}
      return lensAnswer(ROOT.uri, [
        postNode(ROOT),
        gapNode(B1, 'blocking-you', {parentUri: ROOT.uri}),
        postNode(C1),
      ])
    }
    return {status: 501, body: {error: 'MethodNotImplemented'}}
  })
  const appview = server(READER, call => {
    if (call.nsid === 'app.bsky.feed.getPosts') {
      const wanted = call.params.getAll('uris')
      return {
        status: 200,
        body: {posts: [ROOT, C1].filter(post => wanted.includes(post.uri))},
      }
    }
    if (call.nsid === 'app.bsky.unspecced.getPostThreadV2') {
      return {
        status: 200,
        body: {thread: [stockItem(ROOT, 0)], hasOtherReplies: false},
      }
    }
    return undefined
  })
  prismCalls = prism.calls
  appviewCalls = appview.calls
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

function renderThread(anchor: string) {
  const qc = publish()
  const hook = renderHook(() => usePostThread({anchor}), {
    wrapper: ({children}) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  })
  return {...hook, qc}
}

function nsids(calls: Call[]) {
  return calls.map(call => call.nsid)
}

beforeEach(() => {
  lensFails = false
  resetPrismHealth()
  resetKnown()
  resetPrismFeatures()
  answerPrismFeatures(READER, ['private'])
  resetLensRefusals()
  resetLensWaits()
  resetLensRegistry()
  writeLocal(THREAD_LENS_PREFERENCE_KEY, undefined)
  clearCurrentClients()
})

describe('usePostThread with Thread Lens', () => {
  it("reads a member's public thread through the lens, gaps as placeholders", async () => {
    const {result} = renderThread(ROOT.uri)
    await settle()
    expect(result.current.context.postThreadQueryKey[0]).toBe(LENS_ROOT)
    expect(result.current.state.lens.kind).toBe('snapshot')
    const posts = result.current.data.items.filter(
      item => item.type === 'threadPost',
    ) as {uri: string; value: {post: typeof ROOT}}[]
    expect(posts.map(item => item.uri)).toEqual([ROOT.uri, B1, C1.uri])
    expect(gapInfoOf(posts[1].value.post)?.gap).toBe('blocking-you')
    expect(gapInfoOf(posts[2].value.post)).toBeUndefined()
    // One source per mode (TL-4): no stock thread read.
    expect(nsids(appviewCalls)).not.toContain(
      'app.bsky.unspecced.getPostThreadV2',
    )
    // The gap URI went only to prism's lens (U-5).
    const getPosts = appviewCalls.filter(
      call => call.nsid === 'app.bsky.feed.getPosts',
    )
    expect(getPosts.flatMap(call => call.params.getAll('uris'))).not.toContain(
      B1,
    )
    expect(nsids(prismCalls)).toContain('app.nearhorizon.threadLens.getThread')
  })

  it('reads the stock thread under the stock key with the lens off', async () => {
    writeLocal(THREAD_LENS_PREFERENCE_KEY, '0')
    const {result} = renderThread(ROOT.uri)
    await settle()
    expect(result.current.context.postThreadQueryKey[0]).toBe('post-thread-v2')
    expect(result.current.state.lens.kind).toBe('stock')
    expect(nsids(prismCalls)).not.toContain(
      'app.nearhorizon.threadLens.getThread',
    )
    expect(nsids(appviewCalls)).toContain('app.bsky.unspecced.getPostThreadV2')
  })

  it('falls back to the stock read in the same run when the lens fails', async () => {
    lensFails = true
    const {result} = renderThread(ROOT.uri)
    await settle()
    expect(result.current.context.postThreadQueryKey[0]).toBe(LENS_ROOT)
    expect(result.current.state.lens.kind).toBe('fallback')
    expect(result.current.state.lens.note?.reason).toBe('unavailable')
    expect(result.current.state.error).toBeFalsy()
    expect(
      result.current.data.items.some(
        item => item.type === 'threadPost' && item.uri === ROOT.uri,
      ),
    ).toBe(true)
  })

  it('never uses the lens for a private anchor', async () => {
    const {result} = renderThread(privateUriOf('3kprivanchor2'))
    await settle()
    expect(result.current.context.postThreadQueryKey[0]).toBe('post-thread-v2')
    expect(result.current.state.lens.kind).toBe('stock')
    expect(nsids(prismCalls)).not.toContain(
      'app.nearhorizon.threadLens.getThread',
    )
  })
})
