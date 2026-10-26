import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMember = true
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => (mockMember ? 'member' : 'not-member'),
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did && mockMember,
}))
// The device store is empty, but for the lens's handle cache, which keeps.
const mockHandles = new Map<string, string>()
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: (key: string) =>
    key === 'horizon:lensHandles' ? mockHandles.get(key) : undefined,
  writeLocal: (key: string, value: string | undefined) => {
    if (key !== 'horizon:lensHandles') return
    if (value === undefined) mockHandles.delete(key)
    else mockHandles.set(key, value)
  },
  subscribeLocal: () => () => {},
}))
jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))

import {hashKey, type QueryClient} from '@tanstack/react-query'

import {privateView} from '#/horizon/private/__tests__/read-fixtures'
import {resetThreadMuteResync} from '#/horizon/private/api/thread-mute'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {type LensSelected, selectLensAnswer} from '#/horizon/thread-lens/adapt'
import {
  getLensWaitUntil,
  resetLensRefusals,
  resetLensWaits,
} from '#/horizon/thread-lens/api'
import {
  installLensHandleResolver,
  loadEarlierLensPosts,
  loadMoreLensReplies,
  retryLensGaps,
  runLens,
} from '#/horizon/thread-lens/fetch'
import {
  cachedHandleDid,
  clearHandleCache,
} from '#/horizon/thread-lens/handle-cache'
import {resetLensViewPool} from '#/horizon/thread-lens/public-views'
import {
  getLensGapKind,
  registerLensGaps,
  resetLensRegistry,
} from '#/horizon/thread-lens/registry'
import {
  fallbackOf,
  getLensRowStatus,
  hasLensQueue,
  type LensKeyParams,
  lensQueryKey,
  type LensSnapshot,
  pendingLensTimerCount,
  resetLensQueues,
  setLensTaskStartSpy,
  snapshotOf,
  stopKey,
} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'
import {
  AUTHOR,
  BLOCKED,
  type Call,
  deferred,
  fakeAppview,
  flush,
  gapNode,
  lensAnswer,
  OTHER_READER,
  postNode,
  privateUriOf,
  publishClients,
  READER,
  type Reply,
  server,
  until,
  uriOf,
  view,
} from './harness'

type PostView = app.bsky.feed.defs.PostView

const ROOT = uriOf('3kroot2222222')
const ANCHOR = uriOf('3kanchor22222')
const GAP = uriOf('3kgap22222222', BLOCKED)
const UNDER = uriOf('3kunder222222')
const STOCK_KEY = [
  'post-thread-v2',
  {anchor: ANCHOR, sort: 'oldest', view: 'linear'},
] as const

type Handlers = {
  getThread?: (body: Record<string, unknown>) => Reply | Promise<Reply>
  resolve?: (body: Record<string, unknown>) => Reply | Promise<Reply>
  getReplies?: (params: URLSearchParams) => Reply | Promise<Reply>
}

let handlers: Handlers
let posts: PostView[]
let prism: {calls: Call[]}
let appview: {calls: Call[]}

function setup(did = READER): QueryClient {
  const fakePrism = server(did, call => {
    switch (call.nsid) {
      case 'app.nearhorizon.threadLens.getThread':
        return handlers.getThread?.(call.body ?? {})
      case 'app.nearhorizon.threadLens.resolve':
        return handlers.resolve?.(call.body ?? {})
      case 'app.nearhorizon.private.getReplies':
        return handlers.getReplies?.(call.params)
    }
    return undefined
  })
  const fakeView = fakeAppview({posts})
  prism = fakePrism
  appview = fakeView
  return publishClients({
    did,
    prism: fakePrism.client,
    appview: fakeView.client,
  })
}

function keyOf(params: Partial<LensKeyParams> = {}) {
  return lensQueryKey({
    did: READER,
    anchor: ANCHOR,
    depth: 10,
    mode: 'lens',
    marked: false,
    ...params,
  })
}

function options(qc: QueryClient, extra: object = {}) {
  return {
    qc,
    stockKey: STOCK_KEY,
    readWith: {sort: 'oldest', below: 10},
    ...extra,
  }
}

/** The thread used by most tests: root, anchor, a gap reply, a reply under it. */
function serveThread(extraNodes: unknown[] = []) {
  const root = view('3kroot2222222')
  const anchor = view('3kanchor22222', {parent: ROOT})
  const under = view('3kunder222222', {parent: GAP, root: ROOT})
  posts = [root, anchor, under]
  handlers.getThread = () =>
    lensAnswer(ANCHOR, [
      postNode(root),
      postNode(anchor),
      gapNode(GAP, 'blocking-you', {parentUri: ANCHOR}),
      postNode(under),
      ...extraNodes,
    ])
  return {root, anchor, under}
}

async function load(qc: QueryClient, key = keyOf()) {
  const run = await runLens(key, options(qc))
  if (run.data) qc.setQueryData(key, run.data)
  return {run, snapshot: snapshotOf(run.data)}
}

function select(snapshot: LensSnapshot): LensSelected {
  return selectLensAnswer(
    {lens: snapshot},
    {
      sort: 'oldest',
      view: 'linear',
      below: 10,
    },
  ) as unknown as LensSelected
}

/** Every URI any request sent, by host: prism lens, prism other, AppView. */
function sentUris() {
  const out: {nsid: string; text: string}[] = []
  for (const call of [...prism.calls, ...appview.calls]) {
    out.push({
      nsid: call.nsid,
      text: `${call.params.toString()} ${JSON.stringify(call.body ?? {})}`,
    })
  }
  return out
}

beforeEach(() => {
  mockMember = true
  handlers = {}
  posts = []
  resetPrismHealth()
  resetPrismFeatures()
  answerPrismFeatures(READER, ['private', 'private.paging'])
  resetLensWaits()
  resetLensRefusals()
  resetLensRegistry()
  resetLensQueues()
  resetThreadMuteResync()
  setLensTaskStartSpy(undefined)
  resetLensViewPool()
})

describe('the first read (5, 6, 7.1)', () => {
  it('builds a snapshot, registers its gaps and sends gap URIs only to prism', async () => {
    serveThread()
    handlers.getReplies = () => ({status: 200, body: {replies: []}})
    const qc = setup()
    const {snapshot} = await load(qc)
    expect(snapshot?.form).toBe('snapshot')
    expect(getLensGapKind(READER, GAP)).toBe('blocking-you')
    const getPosts = appview.calls.filter(
      call => call.nsid === 'app.bsky.feed.getPosts',
    )
    expect(getPosts.map(call => call.params.getAll('uris'))).toEqual([
      [ROOT, ANCHOR, UNDER],
    ])
    for (const sent of sentUris()) {
      if (sent.text.includes(GAP)) {
        expect(sent.nsid).toBe('app.nearhorizon.threadLens.getThread')
      }
      // No request carries the blocked author's DID but prism's lens.
      if (sent.text.includes(BLOCKED)) {
        expect(sent.nsid.startsWith('app.nearhorizon.threadLens.')).toBe(true)
      }
    }
    const output = select(snapshot!)
    expect(output.thread.map(item => item.uri)).toEqual([
      ROOT,
      ANCHOR,
      GAP,
      UNDER,
    ])
  })

  it('renders the public view, not prism view (TL-5)', async () => {
    const {anchor} = serveThread()
    const publicAnchor = {...anchor, likeCount: 42}
    posts = posts.map(post => (post.uri === ANCHOR ? publicAnchor : post))
    const qc = setup()
    const {snapshot} = await load(qc)
    const node = snapshot!.nodes.get(ANCHOR)
    expect(node?.kind === 'post' && node.view.likeCount).toBe(42)
  })

  it('copies the stock placeholder knownLikers onto the anchor', async () => {
    serveThread()
    const qc = setup()
    const likers = {count: 1, actors: [{did: AUTHOR, handle: 'a.test'}]}
    const run = await runLens(
      keyOf(),
      options(qc, {
        placeholder: {value: {post: {viewer: {knownLikers: likers}}}},
      }),
    )
    const node = snapshotOf(run.data)!.nodes.get(ANCHOR)
    expect(node?.kind === 'post' && node.view.viewer?.knownLikers).toEqual(
      likers,
    )
  })

  it('resolves a handle anchor on the public AppView, not the account`s, and caches it for the stock screen', async () => {
    clearHandleCache()
    serveThread()
    const handles: string[] = []
    installLensHandleResolver(handle => {
      handles.push(handle)
      return Promise.resolve(AUTHOR)
    })
    try {
      const qc = setup()
      const {snapshot} = await load(
        qc,
        keyOf({anchor: 'at://author.test/app.bsky.feed.post/3kanchor22222'}),
      )
      expect(snapshot?.form).toBe('snapshot')
      expect(handles).toEqual(['author.test'])
      expect(
        appview.calls.some(
          call => call.nsid === 'com.atproto.identity.resolveHandle',
        ),
      ).toBe(false)
      expect(qc.getQueryData(['resolved-did', 'author.test'])).toBe(AUTHOR)
      const getThread = prism.calls.find(
        call => call.nsid === 'app.nearhorizon.threadLens.getThread',
      )
      expect(getThread?.body?.anchor).toBe(ANCHOR)
    } finally {
      installLensHandleResolver(undefined)
    }
  })

  it('answers a handle it resolved before from the device at once, and checks it again in the background', async () => {
    clearHandleCache()
    serveThread()
    const asked: string[] = []
    let answer!: (did: string) => void
    installLensHandleResolver(handle => {
      asked.push(handle)
      return asked.length === 1
        ? Promise.resolve(AUTHOR)
        : new Promise<string>(resolve => {
            answer = resolve
          })
    })
    try {
      const key = keyOf({
        anchor: 'at://author.test/app.bsky.feed.post/3kanchor22222',
      })
      // A fresh page each time: the stock handle cache starts empty.
      const fresh = () => {
        const qc = setup()
        qc.removeQueries({queryKey: ['resolved-did']})
        return qc
      }
      await load(fresh(), key)
      expect(cachedHandleDid('author.test')).toBe(AUTHOR)
      // The device answers while the check is still out.
      const {snapshot} = await load(fresh(), key)
      expect(snapshot?.form).toBe('snapshot')
      expect(asked).toEqual(['author.test', 'author.test'])
      // The check moves the handle; the next read takes it.
      answer(OTHER_READER)
      await until(() => cachedHandleDid('author.test') === OTHER_READER)
    } finally {
      installLensHandleResolver(undefined)
      clearHandleCache()
    }
  })

  describe("prism's handle-form anchors (threadLens.handleAnchor)", () => {
    const HANDLE_ANCHOR = 'at://author.test/app.bsky.feed.post/3kanchor22222'

    function anchorsSent() {
      return prism.calls
        .filter(call => call.nsid === 'app.nearhorizon.threadLens.getThread')
        .map(call => (call.body as {anchor?: string} | undefined)?.anchor)
    }

    async function withHandles<T>(run: (resolved: string[]) => Promise<T>) {
      clearHandleCache()
      const resolved: string[] = []
      installLensHandleResolver(handle => {
        resolved.push(handle)
        return Promise.resolve(AUTHOR)
      })
      answerPrismFeatures(READER, [
        'private',
        'private.paging',
        'threadLens',
        'threadLens.handleAnchor',
      ])
      try {
        return await run(resolved)
      } finally {
        installLensHandleResolver(undefined)
        clearHandleCache()
      }
    }

    function fresh() {
      const qc = setup()
      qc.removeQueries({queryKey: ['resolved-did']})
      return qc
    }

    it('sends the handle form at once and keys the read on the DID-form answer', async () => {
      await withHandles(async () => {
        serveThread()
        const {snapshot} = await load(fresh(), keyOf({anchor: HANDLE_ANCHOR}))
        expect(snapshot?.form).toBe('snapshot')
        expect(anchorsSent()).toEqual([HANDLE_ANCHOR])
        expect(cachedHandleDid('author.test')).toBe(AUTHOR)
      })
    })

    it('without the feature, sends the DID form', async () => {
      await withHandles(async () => {
        answerPrismFeatures(READER, ['private', 'private.paging', 'threadLens'])
        serveThread()
        await load(fresh(), keyOf({anchor: HANDLE_ANCHOR}))
        expect(anchorsSent()).toEqual([ANCHOR])
      })
    })

    it('HandleNotFound: retries in DID form with its own resolution', async () => {
      await withHandles(async resolved => {
        serveThread()
        const answer = handlers.getThread!
        handlers.getThread = body =>
          body.anchor === HANDLE_ANCHOR
            ? {status: 400, body: {error: 'HandleNotFound'}}
            : answer(body)
        const {snapshot} = await load(fresh(), keyOf({anchor: HANDLE_ANCHOR}))
        expect(snapshot?.form).toBe('snapshot')
        expect(anchorsSent()).toEqual([HANDLE_ANCHOR, ANCHOR])
        expect(resolved).toEqual(['author.test'])
      })
    })

    it('a 429 in handle form records no lens wait and retries once in DID form', async () => {
      await withHandles(async () => {
        serveThread()
        const answer = handlers.getThread!
        handlers.getThread = body =>
          body.anchor === HANDLE_ANCHOR
            ? {
                status: 429,
                body: {error: 'RateLimitExceeded'},
                headers: {'retry-after': '30'},
              }
            : answer(body)
        const {snapshot} = await load(fresh(), keyOf({anchor: HANDLE_ANCHOR}))
        expect(snapshot?.form).toBe('snapshot')
        expect(anchorsSent()).toEqual([HANDLE_ANCHOR, ANCHOR])
        expect(getLensWaitUntil(READER)).toBeUndefined()
      })
    })

    it('a not-found anchor for another DID than ours: asks again by ours', async () => {
      await withHandles(async () => {
        serveThread()
        const answer = handlers.getThread!
        const STALE = uriOf('3kanchor22222', OTHER_READER)
        handlers.getThread = body =>
          body.anchor === HANDLE_ANCHOR
            ? lensAnswer(STALE, [gapNode(STALE, 'not-found')])
            : answer(body)
        const {snapshot} = await load(fresh(), keyOf({anchor: HANDLE_ANCHOR}))
        expect(snapshot?.form).toBe('snapshot')
        expect(anchorsSent()).toEqual([HANDLE_ANCHOR, ANCHOR])
      })
    })
  })

  it('makes no request and reads the registry for a gap-only key', async () => {
    const qc = setup()
    registerLensGaps(READER, [[ANCHOR, 'blocking-you']])
    const run = await runLens(
      keyOf({mode: 'gap-only'}),
      options(qc, {inactiveReason: 'not-served'}),
    )
    const snapshot = snapshotOf(run.data)!
    expect(snapshot.form).toBe('gap-only')
    expect(snapshot.note).toEqual({reason: 'not-served', autoRetry: 'none'})
    expect(prism.calls).toHaveLength(0)
    expect(appview.calls).toHaveLength(0)
  })
})

describe('the private part (5.5, TL-28)', () => {
  function privateReply(rkey: string, parent = ANCHOR) {
    return {
      post: privateView(rkey, {
        did: AUTHOR,
        reply: {root: {uri: ROOT}, parent: {uri: parent}},
      }),
      replies: [],
    }
  }

  it('reads private replies after the lens answer and keeps one item per URI', async () => {
    const dup = privateUriOf('3kpriv222222')
    serveThread([gapNode(dup, 'tier-hidden', {parentUri: ANCHOR})])
    handlers.getReplies = () => ({
      status: 200,
      body: {replies: [privateReply('3kpriv222222')], cursor: 'p1'},
    })
    const qc = setup()
    const {snapshot} = await load(qc)
    expect(snapshot!.nodes.get(dup)?.kind).toBe('private')
    expect(snapshot!.privateCursor?.cursor).toBe('p1')
    expect(getLensGapKind(READER, dup)).toBeUndefined()
    const getReplies = prism.calls.filter(
      call => call.nsid === 'app.nearhorizon.private.getReplies',
    )
    expect(getReplies).toHaveLength(1)
    expect(getReplies[0].params.get('uri')).toBe(ANCHOR)
    // No private URI goes to the public AppView.
    for (const call of appview.calls) {
      expect(call.params.toString()).not.toContain('postPrivate')
    }
    const keys = select(snapshot!).thread.map(item => item.uri)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('asks for the private replies beside getThread, not after it', async () => {
    serveThread()
    const answer = handlers.getThread!
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    handlers.getThread = async body => {
      await gate
      return answer(body)
    }
    handlers.getReplies = () => ({
      status: 200,
      body: {replies: [privateReply('3kpriv222222')]},
    })
    const qc = setup()
    const loading = load(qc)
    await until(() =>
      prism.calls.some(c => c.nsid === 'app.nearhorizon.private.getReplies'),
    )
    release()
    const {snapshot} = await loading
    expect(snapshot!.nodes.get(privateUriOf('3kpriv222222'))?.kind).toBe(
      'private',
    )
    expect(
      prism.calls.filter(c => c.nsid === 'app.nearhorizon.private.getReplies'),
    ).toHaveLength(1)
  })

  it('never shows private replies for a gap anchor', async () => {
    handlers.getThread = () =>
      lensAnswer(ANCHOR, [gapNode(ANCHOR, 'blocking-you')])
    // Asked early, beside getThread, of prism only; the answer is dropped.
    handlers.getReplies = () => ({
      status: 200,
      body: {replies: [privateReply('3kpriv222222')]},
    })
    const qc = setup()
    const {snapshot} = await load(qc)
    for (const node of snapshot?.nodes.values() ?? []) {
      expect(node.kind).not.toBe('private')
    }
    for (const call of appview.calls) {
      expect(call.params.toString()).not.toContain('postPrivate')
    }
  })

  it('discards private replies when the public pass makes the anchor a gap', async () => {
    serveThread()
    posts = posts.map(post =>
      post.uri === ANCHOR
        ? {
            ...post,
            author: {...post.author, viewer: {blockedBy: true}},
          }
        : post,
    )
    handlers.getReplies = () => ({
      status: 200,
      body: {replies: [privateReply('3kpriv222222')]},
    })
    const qc = setup()
    const {snapshot} = await load(qc)
    expect(snapshot!.nodes.get(ANCHOR)?.kind).toBe('gap')
    for (const node of snapshot!.nodes.values()) {
      expect(node.kind).not.toBe('private')
    }
    expect(snapshot!.privateCursor).toBeUndefined()
  })

  it('reads no private part when the key is not the current account', async () => {
    serveThread()
    handlers.getReplies = () => ({status: 200, body: {replies: []}})
    const qc = setup()
    const run = await runLens(keyOf({did: OTHER_READER}), options(qc))
    // The key's account has no clients: the read fails, nothing private.
    expect(run.data).toBeUndefined()
    expect(
      prism.calls.some(c => c.nsid === 'app.nearhorizon.private.getReplies'),
    ).toBe(false)
  })
})

describe('failures of the main read (11.3)', () => {
  it('falls back for an anchor the lens did not draw, tagged with readWith', async () => {
    handlers.getThread = () => ({status: 500, body: {error: 'Internal'}})
    const qc = setup()
    const run = await runLens(keyOf(), options(qc))
    expect(run.data).toBeUndefined()
    const tagged = run.tag({thread: [], hasOtherReplies: false})
    expect(fallbackOf(tagged)).toMatchObject({
      fallback: 'unavailable',
      autoRetry: 'none',
      readWith: {sort: 'oldest', below: 10},
    })
    expect(typeof fallbackOf(tagged)?.runId).toBe('string')
  })

  it('carries a 429 retry through a run made during the wait, then spends it', async () => {
    handlers.getThread = () => ({
      status: 429,
      body: {error: 'RateLimitExceeded'},
      headers: {'retry-after': '30'},
    })
    const qc = setup()
    const key = keyOf()
    const first = await runLens(key, options(qc))
    const tagged = first.tag({thread: [], hasOtherReplies: false})
    expect(fallbackOf(tagged)).toMatchObject({
      fallback: '429',
      autoRetry: 'pending',
    })
    qc.setQueryData(key, tagged)
    const during = await runLens(key, options(qc))
    const again = during.tag({thread: [], hasOtherReplies: false})
    expect(fallbackOf(again)?.autoRetry).toBe('pending')
    expect(fallbackOf(again)?.retryAt).toBe(fallbackOf(tagged)?.retryAt)
    expect(
      prism.calls.filter(c => c.nsid.endsWith('threadLens.getThread')),
    ).toHaveLength(1)
    // The wait ends; the automatic retry meets a second 429.
    resetLensWaits()
    const retried = await runLens(key, options(qc))
    const spent = retried.tag({thread: [], hasOtherReplies: false})
    expect(fallbackOf(spent)?.autoRetry).toBe('spent')
  })

  it('writes the stock key on a refusal', async () => {
    handlers.getThread = () => ({status: 400, body: {error: 'NotEnrolled'}})
    const qc = setup()
    const run = await runLens(keyOf(), options(qc))
    const result = {thread: [], hasOtherReplies: false}
    const tagged = run.tag(result)
    expect(fallbackOf(tagged)?.fallback).toBe('refused')
    expect(qc.getQueryData(STOCK_KEY)).toBe(result)
  })

  it('keeps a held snapshot on a failed refetch, runId and all (TL-35)', async () => {
    serveThread()
    const qc = setup()
    const key = keyOf()
    const {snapshot} = await load(qc, key)
    handlers.getThread = () => ({status: 502, body: {error: 'UpstreamFailure'}})
    const run = await runLens(key, options(qc))
    const kept = snapshotOf(run.data)!
    expect(kept.runId).toBe(snapshot!.runId)
    expect(kept.nodes).toBe(snapshot!.nodes)
    expect(kept.failure).toEqual({reason: 'unavailable', autoRetry: 'none'})
    expect(
      appview.calls.filter(c => c.nsid === 'app.bsky.feed.getPosts'),
    ).toHaveLength(1)
  })

  it('keeps what was written while the refetch was in flight (R4-N7)', async () => {
    serveThread()
    const qc = setup()
    const key = keyOf()
    const {snapshot} = await load(qc, key)
    const held = deferred<Reply>()
    handlers.getThread = () => held.promise
    const running = runLens(key, options(qc))
    await until(
      () => prism.calls.filter(c => c.nsid.endsWith('getThread')).length === 2,
    )
    const optimistic = {...snapshot!, hidden: new Set(['written'])}
    qc.setQueryData(key, {lens: optimistic})
    held.resolve({status: 500, body: {error: 'Internal'}})
    const kept = snapshotOf((await running).data)!
    expect(kept.hidden.has('written')).toBe(true)
  })

  it('gives a lens-only anchor its gap-only answer, never a fallback', async () => {
    handlers.getThread = () => ({status: 500, body: {error: 'Internal'}})
    const qc = setup()
    registerLensGaps(READER, [[ANCHOR, 'blocked-by-you']])
    const run = await runLens(keyOf(), options(qc))
    const snapshot = snapshotOf(run.data)!
    expect(snapshot.form).toBe('gap-only')
    expect(snapshot.nodes.get(ANCHOR)).toMatchObject({gap: 'blocked-by-you'})
    expect(snapshot.note?.reason).toBe('unavailable')
    expect(appview.calls).toHaveLength(0)
  })

  it('gives a marked anchor the registry lacks the unverified answer', async () => {
    handlers.getThread = () => ({
      status: 429,
      body: {error: 'RateLimitExceeded'},
    })
    const qc = setup()
    const run = await runLens(keyOf({marked: true}), options(qc))
    const snapshot = snapshotOf(run.data)!
    expect(snapshot.form).toBe('unverified')
    expect(snapshot.note).toMatchObject({reason: '429', autoRetry: 'pending'})
    expect(getLensGapKind(READER, ANCHOR)).toBeUndefined()
  })

  it('gives a refusal over a held snapshot on a lens-only anchor the not-served note', async () => {
    serveThread()
    const qc = setup()
    const key = keyOf({marked: true})
    await load(qc, key)
    handlers.getThread = () => ({status: 400, body: {error: 'NotEnrolled'}})
    const run = await runLens(key, options(qc))
    const snapshot = snapshotOf(run.data)!
    expect(snapshot.form).toBe('unverified')
    expect(snapshot.note).toEqual({reason: 'not-served', autoRetry: 'none'})
  })

  it('fails an answer without its anchor node as malformed', async () => {
    handlers.getThread = () =>
      lensAnswer(ANCHOR, [postNode(view('3kroot2222222'))])
    posts = [view('3kroot2222222')]
    const qc = setup()
    const run = await runLens(keyOf(), options(qc))
    expect(run.data).toBeUndefined()
    expect(fallbackOf(run.tag({thread: []}))?.fallback).toBe('unavailable')
  })

  it('fails the read when a public-view batch fails (6.4)', async () => {
    serveThread()
    const qc = setup()
    const fakeView = fakeAppview({posts, fail: () => true})
    publishClients({
      prism: server(READER, call =>
        call.nsid.endsWith('getThread') ? handlers.getThread?.({}) : undefined,
      ).client,
      appview: fakeView.client,
      queryClient: qc,
    })
    const run = await runLens(keyOf(), options(qc))
    expect(run.data).toBeUndefined()
  })
})

describe('continuations (9.2) and retry (9.3)', () => {
  async function loaded(
    extra: PostView[] = [],
    marker: Record<string, unknown> = {},
  ) {
    const key = keyOf()
    serveThread(extra.map(post => postNode(post, marker)))
    posts.push(...extra)
    const qc = setup()
    await load(qc, key)
    return {qc, key, queueId: hashKey(key)}
  }

  function current(qc: QueryClient, key = keyOf()) {
    return snapshotOf(qc.getQueryData(key))!
  }

  it('"Load more replies" asks parentHeight 0, below - d and the cursor', async () => {
    const reply = view('3kreply222222', {parent: ANCHOR})
    const {qc, key, queueId} = await loaded([reply], {
      moreReplies: {cursor: 'c1'},
    })
    const heldView = (current(qc, key).nodes.get(reply.uri) as {view: PostView})
      .view
    const child = view('3kchild222222', {parent: reply.uri})
    posts.push(child)
    const bodies: unknown[] = []
    handlers.getThread = body => {
      bodies.push(body)
      return lensAnswer(reply.uri, [
        postNode(reply, {moreParents: true}),
        postNode(child),
      ])
    }
    const before = appview.calls.length
    expect(
      loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10}),
    ).toBe(true)
    await until(() => current(qc, key).nodes.has(child.uri))
    expect(bodies).toEqual([
      {anchor: reply.uri, parentHeight: 0, depth: 9, repliesCursor: 'c1'},
    ])
    const after = current(qc, key)
    expect((after.nodes.get(reply.uri) as {view: PostView}).view).toBe(heldView)
    const asked = appview.calls
      .slice(before)
      .flatMap(call => call.params.getAll('uris'))
    expect(asked).toEqual([child.uri])
    expect(after.markers.get(reply.uri)).toBeUndefined()
    const output = select(after)
    expect(output.lensState.markers.has(reply.uri)).toBe(false)
    // "Load earlier posts" never appears mid-thread (R2-L1).
    expect(
      output.thread.filter(
        i => (i.value as {moreParents?: boolean}).moreParents,
      ),
    ).toEqual([])
    await until(() => getLensRowStatus(qc, queueId, reply.uri) === 'idle')
  })

  it.each([
    ['the marker gone', {}],
    ['the cursor unchanged', {moreReplies: {cursor: 'c1'}}],
  ])('removes the row with nothing new and %s', async (_, marker) => {
    const reply = view('3kreply222222', {parent: ANCHOR})
    const {qc, key, queueId} = await loaded([reply], {
      moreReplies: {cursor: 'c1'},
    })
    handlers.getThread = () => lensAnswer(reply.uri, [postNode(reply, marker)])
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    await until(() => current(qc, key).bridging.length === 2)
    expect(current(qc, key).stopped.has(stopKey('replies', reply.uri))).toBe(
      true,
    )
  })

  it('keeps the row with nothing new but a changed cursor', async () => {
    const reply = view('3kreply222222', {parent: ANCHOR})
    const {qc, key, queueId} = await loaded([reply], {
      moreReplies: {cursor: 'c1'},
    })
    handlers.getThread = () =>
      lensAnswer(reply.uri, [postNode(reply, {moreReplies: {cursor: 'c2'}})])
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    await until(() => current(qc, key).bridging.length === 2)
    expect(current(qc, key).stopped.size).toBe(0)
    expect(current(qc, key).markers.get(reply.uri)).toEqual({
      moreReplies: {cursor: 'c2'},
    })
  })

  it('asks once more without a refused cursor, and removes the row after two', async () => {
    const reply = view('3kreply222222', {parent: ANCHOR})
    const {qc, key, queueId} = await loaded([reply], {
      moreReplies: {cursor: 'bad'},
    })
    const bodies: Record<string, unknown>[] = []
    handlers.getThread = body => {
      bodies.push(body)
      return {status: 400, body: {error: 'InvalidRequest'}}
    }
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    await until(() => current(qc, key).stopped.size === 1)
    expect(bodies.map(body => body.repliesCursor)).toEqual(['bad', undefined])
  })

  it('"Load earlier posts" asks depth 0 and parentHeight 80, keeping the replies marker', async () => {
    const top = view('3ktop22222222', {parent: uriOf('3kabove222222')})
    handlers.getThread = () =>
      lensAnswer(ANCHOR, [
        postNode(top, {moreParents: true}),
        postNode(view('3kanchor22222', {parent: top.uri}), {
          moreReplies: {cursor: 'r'},
        }),
      ])
    posts = [top, view('3kanchor22222', {parent: top.uri})]
    const qc = setup()
    const key = keyOf()
    await load(qc, key)
    const above = view('3kabove222222')
    posts.push(above)
    const bodies: unknown[] = []
    handlers.getThread = body => {
      bodies.push(body)
      return lensAnswer(top.uri, [postNode(above), postNode(top)])
    }
    loadEarlierLensPosts(qc, hashKey(key), {uri: top.uri})
    await until(() => current(qc, key).nodes.has(above.uri))
    expect(bodies).toEqual([{anchor: top.uri, depth: 0, parentHeight: 80}])
    const after = current(qc, key)
    expect(after.markers.get(ANCHOR)).toEqual({moreReplies: {cursor: 'r'}})
    expect(after.markers.get(top.uri)).toBeUndefined()
  })

  it('resolves 26 retryable gaps in calls of 25 and 1, and asks up from a resolved top', async () => {
    const gaps = Array.from({length: 26}, (_, i) =>
      uriOf(`3kgap${String(i).padStart(3, '0')}22222`, BLOCKED),
    )
    handlers.getThread = () =>
      lensAnswer(ANCHOR, [
        gapNode(gaps[0], 'block-state-unknown'),
        postNode(view('3kanchor22222', {parent: gaps[0]})),
        ...gaps
          .slice(1)
          .map(uri =>
            gapNode(uri, 'upstream-unavailable', {parentUri: ANCHOR}),
          ),
      ])
    posts = [view('3kanchor22222', {parent: gaps[0]})]
    const qc = setup()
    const key = keyOf()
    await load(qc, key)
    const resolvedTop = view(gaps[0].split('/').pop()!, {
      did: BLOCKED,
      parent: uriOf('3kfarabove222'),
    })
    posts.push(resolvedTop)
    const sizes: number[] = []
    handlers.resolve = body => {
      const uris = body.uris as string[]
      sizes.push(uris.length)
      return {
        status: 200,
        body: {
          bridging: 'full',
          items: uris.map(uri =>
            uri === gaps[0]
              ? postNode(resolvedTop)
              : gapNode(uri, 'upstream-unavailable'),
          ),
        },
      }
    }
    retryLensGaps(qc, hashKey(key), {uri: gaps[1]})
    await until(() => current(qc, key).nodes.get(gaps[0])?.kind === 'post')
    expect(sizes).toEqual([25, 1])
    const output = select(current(qc, key))
    expect(output.lensState.markers.get(gaps[0])).toEqual({kind: 'parents'})
    // The retried row answered the same kind.
    await until(
      () => getLensRowStatus(qc, hashKey(key), gaps[1]) === 'still-unavailable',
    )
    expect(pendingLensTimerCount()).toBe(1)
  })
})

describe('ordering and the queue (9.1)', () => {
  async function loaded() {
    const reply = view('3kreply222222', {parent: ANCHOR})
    serveThread([postNode(reply, {moreReplies: {cursor: 'c1'}})])
    posts.push(reply)
    const qc = setup()
    const key = keyOf()
    await load(qc, key)
    return {qc, key, queueId: hashKey(key), reply}
  }

  it('drops a continuation whose run was replaced by a refetch', async () => {
    const {qc, key, queueId, reply} = await loaded()
    const held = deferred<Reply>()
    handlers.getThread = () => held.promise
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    await until(() => getLensRowStatus(qc, queueId, reply.uri) === 'running')
    // A refetch's new snapshot (a new runId).
    const refetched = {...snapshotOf(qc.getQueryData(key))!, runId: 'new'}
    qc.setQueryData(key, {lens: refetched})
    held.resolve(
      lensAnswer(reply.uri, [
        postNode(reply),
        gapNode(uriOf('3knewgap22222', BLOCKED), 'blocking-you', {
          parentUri: reply.uri,
        }),
      ]),
    )
    await until(() => getLensRowStatus(qc, queueId, reply.uri) === 'idle')
    expect(snapshotOf(qc.getQueryData(key))).toBe(refetched)
    expect(getLensGapKind(READER, uriOf('3knewgap22222', BLOCKED))).toBe(
      undefined,
    )
  })

  it('drops a continuation that finishes while a refetch is in flight', async () => {
    const {qc, key, queueId, reply} = await loaded()
    const held = deferred<Reply>()
    handlers.getThread = () => held.promise
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    await until(() => getLensRowStatus(qc, queueId, reply.uri) === 'running')
    const before = snapshotOf(qc.getQueryData(key))
    void qc.fetchQuery({queryKey: key, queryFn: () => new Promise(() => {})})
    held.resolve(lensAnswer(reply.uri, [postNode(reply)]))
    await until(() => getLensRowStatus(qc, queueId, reply.uri) === 'idle')
    expect(snapshotOf(qc.getQueryData(key))).toBe(before)
  })

  it('runs one task at a time and merges both', async () => {
    const {qc, key, queueId, reply} = await loaded()
    const gap = uriOf('3kretry222222', BLOCKED)
    const withGap = snapshotOf(qc.getQueryData(key))!
    const nodes = new Map(withGap.nodes)
    nodes.set(gap, {
      kind: 'gap',
      uri: gap,
      parentUri: ANCHOR,
      gap: 'block-state-unknown',
      bridging: 'full',
    })
    qc.setQueryData(key, {lens: {...withGap, nodes}})
    const held = deferred<Reply>()
    handlers.getThread = () => held.promise
    handlers.resolve = () => ({
      status: 200,
      body: {bridging: 'full', items: [gapNode(gap, 'blocking-you')]},
    })
    const starts: string[] = []
    setLensTaskStartSpy(uri => starts.push(uri))
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    retryLensGaps(qc, queueId, {uri: gap})
    await until(() => starts.length === 1)
    expect(getLensRowStatus(qc, queueId, gap)).toBe('waiting')
    expect(prism.calls.filter(c => c.nsid.endsWith('resolve'))).toHaveLength(0)
    held.resolve(lensAnswer(reply.uri, [postNode(reply)]))
    await until(
      () =>
        snapshotOf(qc.getQueryData(key))!.nodes.get(gap)?.kind === 'gap' &&
        (snapshotOf(qc.getQueryData(key))!.nodes.get(gap) as {gap: string})
          .gap === 'blocking-you',
    )
    expect(starts).toEqual([reply.uri, gap])
    expect(snapshotOf(qc.getQueryData(key))!.bridging).toHaveLength(3)
  })

  it('writes nothing after its entry is removed', async () => {
    const {qc, key, queueId, reply} = await loaded()
    const held = deferred<Reply>()
    handlers.getThread = () => held.promise
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    await until(() => getLensRowStatus(qc, queueId, reply.uri) === 'running')
    qc.removeQueries({queryKey: key, exact: true})
    expect(hasLensQueue(qc, queueId)).toBe(false)
    held.resolve(lensAnswer(reply.uri, [postNode(reply)]))
    await flush(50)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(qc.getQueryCache().find({queryKey: key, exact: true})).toBe(
      undefined,
    )
  })

  it('drops a waiting task and the late answer on an account switch', async () => {
    const {qc, key, queueId, reply} = await loaded()
    const gap = uriOf('3kretry222222', BLOCKED)
    const base = snapshotOf(qc.getQueryData(key))!
    const nodes = new Map(base.nodes)
    nodes.set(gap, {
      kind: 'gap',
      uri: gap,
      parentUri: ANCHOR,
      gap: 'block-state-unknown',
      bridging: 'full',
    })
    qc.setQueryData(key, {lens: {...base, nodes}})
    const held = deferred<Reply>()
    handlers.getThread = () => held.promise
    const starts: string[] = []
    setLensTaskStartSpy(uri => starts.push(uri))
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    retryLensGaps(qc, queueId, {uri: gap})
    await until(() => starts.length === 1)
    const before = snapshotOf(qc.getQueryData(key))
    // Another account is published.
    clearCurrentClients()
    publishCurrentClients({
      did: OTHER_READER,
      handle: 'other.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: server(OTHER_READER, () => undefined).client,
      appviewClient: server(OTHER_READER, () => undefined).client,
    })
    await flush()
    held.resolve(
      lensAnswer(reply.uri, [
        postNode(reply),
        gapNode(uriOf('3klategap22222', BLOCKED), 'blocking-you', {
          parentUri: reply.uri,
        }),
      ]),
    )
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(starts).toEqual([reply.uri])
    expect(snapshotOf(qc.getQueryData(key))).toBe(before)
    expect(getLensRowStatus(qc, queueId, reply.uri)).toBe('idle')
    expect(getLensGapKind(READER, uriOf('3klategap22222', BLOCKED))).toBe(
      undefined,
    )
    expect(pendingLensTimerCount()).toBe(0)
  })

  it('keeps everything across a bundle replaced for the same account', async () => {
    const {qc, key, queueId, reply} = await loaded()
    const held = deferred<Reply>()
    handlers.getThread = () => held.promise
    loadMoreLensReplies(qc, queueId, {uri: reply.uri, depth: 1, below: 10})
    await until(() => getLensRowStatus(qc, queueId, reply.uri) === 'running')
    const child = view('3kchild222222', {parent: reply.uri})
    posts.push(child)
    // A clear and a publish of the same DID, as a replaced bundle does.
    const clients = {
      did: READER,
      handle: 'reader.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: server(READER, () => undefined).client,
      appviewClient: fakeAppview({posts}).client,
      queryClient: qc,
    }
    clearCurrentClients()
    publishCurrentClients(clients)
    await flush()
    held.resolve(lensAnswer(reply.uri, [postNode(reply), postNode(child)]))
    await until(() => snapshotOf(qc.getQueryData(key))!.nodes.has(child.uri))
  })
})
