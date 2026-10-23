import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))
// As `queryCache.test.ts`: the stock finders and shadow, without the app.
jest.mock('#/state/cache/post-shadow', () => ({
  dangerousGetPostShadow: () => undefined,
  updatePostShadow: () => {},
}))
jest.mock('#/state/queries/bookmarks/useBookmarksQuery', () => ({
  findAllPostsInQueryData: function* () {},
}))
jest.mock('#/state/queries/explore-feed-previews', () => ({
  findAllPostsInQueryData: function* () {},
  findPostNumberingInQueryData: () => undefined,
}))
jest.mock('#/state/queries/notifications/feed', () => ({
  findAllPostsInQueryData: function* () {},
}))
jest.mock('#/state/queries/notifications/grouped', () => ({
  findAllPostsInQueryData: function* () {},
}))
jest.mock('#/state/queries/post-feed', () => ({
  findAllPostsInQueryData: function* () {},
  findPostNumberingInQueryData: () => undefined,
}))
jest.mock('#/state/queries/post-quotes', () => ({
  findAllPostsInQueryData: function* () {},
}))
jest.mock('#/state/queries/search-posts-v2', () => ({
  findAllPostsInQueryData: function* () {},
}))
jest.mock('#/state/queries/usePostThread', () => ({
  usePostThreadContext: () => undefined,
}))

import {QueryClient} from '@tanstack/react-query'

import {
  createCacheMutator,
  findAllPostsInQueryData,
} from '#/state/queries/usePostThread/queryCache'
import {type LensSelected} from '#/horizon/thread-lens/adapt'
import {
  findLensPlaceholderCandidates,
  findLensPosts,
  findLensProfiles,
} from '#/horizon/thread-lens/cache-finders'
import {
  checkLensNodes,
  EMPTY_BASE,
  mergeLensNodes,
  type PublicOutcome,
} from '#/horizon/thread-lens/nodes'
import {
  createThreadLens,
  lensKeyFor,
  lensOtherKey,
  type ThreadLensInputs,
  useLensRunId,
  withLensCacheMutator,
  writeLensThreadgate,
} from '#/horizon/thread-lens/query'
import {
  registerLensGaps,
  resetLensRegistry,
} from '#/horizon/thread-lens/registry'
import {
  firstSnapshot,
  LENS_ROOT,
  type LensSnapshot,
  snapshotOf,
} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'
import {
  BLOCKED,
  gapNode,
  OTHER_READER,
  postNode,
  privateUriOf,
  READER,
  uriOf,
  view,
} from './harness'

type PostView = app.bsky.feed.defs.PostView
type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem

const ANCHOR = uriOf('3kanchor22222')
const GAP = uriOf('3kgap22222222', BLOCKED)

const INPUTS: ThreadLensInputs = {
  did: READER,
  anchor: ANCHOR,
  sort: 'oldest',
  view: 'linear',
  below: 10,
  active: true,
  lensOnly: false,
  marked: false,
}

function snapshotWith(raw: unknown[], runId = 'run-1'): LensSnapshot {
  const checked = checkLensNodes(raw)
  const outcomes = new Map<string, PublicOutcome>()
  for (const node of checked) {
    if (node.type === 'post') {
      outcomes.set(node.uri, {
        kind: 'view',
        view: node.post as unknown as PostView,
      })
    }
  }
  const merged = mergeLensNodes(EMPTY_BASE, checked, {
    request: {kind: 'first'},
    bridging: 'full',
    outcomes,
  })
  return firstSnapshot({
    runId,
    anchorUri: ANCHOR,
    prismAnchor: ANCHOR,
    merged,
    bridging: 'full',
  })
}

function postItem(post: PostView, depth: number): ThreadItem {
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

beforeEach(() => {
  resetLensRegistry()
})

describe('the lens keys (7.1)', () => {
  it('has its own root, the request depth and marked, and no sort or below', () => {
    const key = lensKeyFor(INPUTS)!
    expect(key).toEqual([
      LENS_ROOT,
      {did: READER, anchor: ANCHOR, depth: 10, mode: 'lens', marked: false},
    ])
    expect(key).toHaveLength(2)
    expect(lensKeyFor({...INPUTS, view: 'tree', below: 4})![1].depth).toBe(6)
    expect(lensKeyFor({...INPUTS, view: 'tree', below: 6})![1].depth).toBe(6)
    expect(lensKeyFor({...INPUTS, sort: 'top', below: 4})).toEqual(key)
    expect(lensKeyFor({...INPUTS, marked: true})![1].marked).toBe(true)
  })

  it('is the gap-only key for a lens-only anchor with the lens inactive', () => {
    expect(
      lensKeyFor({...INPUTS, active: false, lensOnly: true})![1].mode,
    ).toBe('gap-only')
    expect(lensKeyFor({...INPUTS, active: false})).toBeUndefined()
  })

  it('is never used for a private anchor or signed out', () => {
    expect(
      lensKeyFor({...INPUTS, anchor: privateUriOf('3kpriv222222')}),
    ).toBeUndefined()
    expect(lensKeyFor({...INPUTS, did: undefined})).toBeUndefined()
  })

  it('gives two DIDs two keys, and carries runId in the other key', () => {
    const a = lensKeyFor(INPUTS)!
    const b = lensKeyFor({...INPUTS, did: OTHER_READER})!
    expect(a).not.toEqual(b)
    expect(lensOtherKey(a, 'r1')).toEqual([
      LENS_ROOT,
      'other',
      {did: READER, anchor: ANCHOR, depth: 10, runId: 'r1'},
    ])
  })
})

describe('the lens object (7.1)', () => {
  const stockKey = ['post-thread-v2', {anchor: ANCHOR, view: 'linear'}] as never
  const stockOther = ['post-thread-v2', 'other', {anchor: ANCHOR}] as never

  it('is the stock query when the lens is not involved', () => {
    const lens = createThreadLens(
      new QueryClient(),
      {...INPUTS, active: false},
      undefined,
    )
    expect(lens.key).toBeUndefined()
    expect(lens.queryKey(stockKey)).toBe(stockKey)
    expect(lens.otherQueryKey(stockOther)).toBe(stockOther)
    const data = {thread: []}
    expect(lens.select(data)).toBe(data)
    expect(lens.refetchOnReconnect).toBeUndefined()
  })

  it('swaps in the lens keys and turns off the reconnect refetch', () => {
    const lens = createThreadLens(new QueryClient(), INPUTS, 'r1')
    expect(lens.queryKey(stockKey)).toEqual(lensKeyFor(INPUTS))
    expect(lens.otherQueryKey(stockOther)).toEqual(
      lensOtherKey(lensKeyFor(INPUTS)!, 'r1'),
    )
    expect(lens.refetchOnReconnect).toBe(false)
  })

  it('never asks getPostThreadOtherV2 on a snapshot or a lens-only fallback', async () => {
    const qc = new QueryClient()
    const key = lensKeyFor(INPUTS)!
    const fetchStock = jest.fn(() => Promise.resolve({thread: []}))
    qc.setQueryData(key, {
      lens: snapshotWith([postNode(view('3kanchor22222'))]),
    })
    const lens = createThreadLens(qc, INPUTS, 'run-1')
    await lens.otherReplies(fetchStock)
    expect(fetchStock).not.toHaveBeenCalled()
    const fallback = {
      thread: [],
      hasOtherReplies: true,
      lens: {
        fallback: 'unavailable',
        autoRetry: 'none',
        readWith: {sort: 'oldest', below: 10},
        runId: 'r2',
      },
    }
    qc.setQueryData(key, fallback)
    await lens.otherReplies(fetchStock)
    expect(fetchStock).toHaveBeenCalledTimes(1)
    // The anchor becomes lens-only: the call-time test sends nothing.
    registerLensGaps(READER, [[ANCHOR, 'blocking-you']])
    await lens.otherReplies(fetchStock)
    expect(fetchStock).toHaveBeenCalledTimes(1)
  })
})

describe('the writers (7.1)', () => {
  const parent = view('3kanchor22222', {replyCount: 0})
  const reply = view('3kreply222222', {parent: ANCHOR})

  function setup() {
    const qc = new QueryClient({
      defaultOptions: {queries: {structuralSharing: false}},
    })
    const key = lensKeyFor(INPUTS)!
    const other = lensOtherKey(key, 'run-1')
    const snapshot = snapshotWith([postNode(parent)])
    qc.setQueryData(key, {lens: snapshot})
    const params = {view: 'linear' as const, below: 10}
    const stock = createCacheMutator({
      queryClient: qc,
      postThreadQueryKey: key as never,
      postThreadOtherQueryKey: other as never,
      params,
    })
    const stockInsert = jest.spyOn(stock, 'insertReplies')
    const mutator = withLensCacheMutator(stock, {
      queryClient: qc,
      postThreadQueryKey: key as never,
      postThreadOtherQueryKey: other as never,
      params,
    })
    return {qc, key, other, snapshot, mutator, stockInsert}
  }

  it('adds a reply to the snapshot and raises the parent count once', () => {
    const {qc, key, mutator, stockInsert} = setup()
    const heldParent = (
      snapshotOf(qc.getQueryData(key))!.nodes.get(ANCHOR) as {
        view: PostView
      }
    ).view
    mutator.insertReplies(ANCHOR, [postItem(reply, 1)])
    expect(stockInsert).not.toHaveBeenCalled()
    const next = snapshotOf(qc.getQueryData(key))!
    expect(next.nodes.get(reply.uri)).toMatchObject({
      kind: 'optimistic',
      parentUri: ANCHOR,
    })
    expect(heldParent.replyCount).toBe(1)
    // Nothing stock-shaped is written into the snapshot.
    expect(qc.getQueryData(key)).not.toHaveProperty('thread')
  })

  it('writes a reply under an other-replies post there, once', () => {
    const {qc, key, other, mutator} = setup()
    const elsewhere = view('3kelsewhere22', {parent: ANCHOR, replyCount: 0})
    qc.setQueryData(other, {thread: [postItem(elsewhere, 1)]})
    const child = view('3kchild222222', {parent: elsewhere.uri})
    mutator.insertReplies(elsewhere.uri, [postItem(child, 2)])
    const list = qc.getQueryData<{thread: ThreadItem[]}>(other)!
    expect(list.thread.map(item => item.uri)).toEqual([
      elsewhere.uri,
      child.uri,
    ])
    expect(elsewhere.replyCount).toBe(1)
    expect(snapshotOf(qc.getQueryData(key))!.nodes.has(child.uri)).toBe(false)
  })

  it('runs the stock mutator outside a snapshot', () => {
    const {qc, key, mutator, stockInsert} = setup()
    qc.setQueryData(key, {
      thread: [postItem(parent, 0)],
      hasOtherReplies: false,
    })
    mutator.insertReplies(ANCHOR, [postItem(reply, 1)])
    expect(stockInsert).toHaveBeenCalledTimes(1)
  })

  it('replaces the anchor view once for a threadgate write', () => {
    const {qc, key, snapshot} = setup()
    const gate = {
      uri: `at://${READER}/app.bsky.feed.threadgate/3kanchor22222`,
      record: {
        $type: 'app.bsky.feed.threadgate',
        post: ANCHOR,
        createdAt: new Date(0).toISOString(),
        hiddenReplies: [],
      },
    } as unknown as app.bsky.feed.defs.ThreadgateView
    expect(writeLensThreadgate(qc, key, gate)).toBe(true)
    const next = snapshotOf(qc.getQueryData(key))!
    const held = next.nodes.get(ANCHOR) as {view: PostView}
    const old = snapshot.nodes.get(ANCHOR) as {view: PostView}
    expect(held.view).not.toBe(old.view)
    expect(held.view.threadgate).toBe(gate)
    expect(next).not.toHaveProperty('threadgate')
    const lens = createThreadLens(qc, INPUTS, next.runId)
    const output = lens.select(qc.getQueryData(key)) as LensSelected
    expect(output.threadgate).toBe(gate)
    qc.setQueryData(key, {thread: [], hasOtherReplies: false})
    expect(writeLensThreadgate(qc, key, gate)).toBe(false)
  })
})

describe('the shadows and the placeholder search (7.7)', () => {
  function setup() {
    const qc = new QueryClient()
    const key = lensKeyFor(INPUTS)!
    const anchor = view('3kanchor22222')
    qc.setQueryData(key, {
      lens: snapshotWith([
        postNode(anchor),
        gapNode(GAP, 'blocking-you', {parentUri: ANCHOR}),
      ]),
    })
    // Select builds placeholders; they must never be found.
    const lens = createThreadLens(qc, INPUTS, 'run-1')
    lens.select(qc.getQueryData(key))
    return {qc, key, anchor}
  }

  it('finds held views and never a placeholder', () => {
    const {qc} = setup()
    const found = Array.from(findLensPosts(qc, ANCHOR))
    expect(found.map(post => post.uri)).toEqual([ANCHOR])
    expect(Array.from(findLensPosts(qc, GAP))).toEqual([])
    expect(Array.from(findLensProfiles(qc, BLOCKED))).toEqual([])
    expect(Array.from(findLensPlaceholderCandidates(qc, GAP))).toEqual([])
    expect(
      Array.from(findLensPlaceholderCandidates(qc, ANCHOR)).map(c => c.uri),
    ).toEqual([ANCHOR])
  })

  it('walks a stock-shaped entry and skips an empty cid', () => {
    const qc = new QueryClient()
    const key = lensKeyFor(INPUTS)!
    const real = view('3kanchor22222')
    const lookAlike = {...view('3kgap22222222', {did: BLOCKED}), cid: ''}
    qc.setQueryData(key, {
      thread: [postItem(real, 0), postItem(lookAlike, 1)],
      hasOtherReplies: false,
      lens: {
        fallback: 'unavailable',
        autoRetry: 'none',
        readWith: {sort: 'oldest', below: 10},
        runId: 'r',
      },
    })
    expect(Array.from(findLensPosts(qc, ANCHOR))).toHaveLength(1)
    expect(Array.from(findLensPosts(qc, GAP))).toEqual([])
    expect(Array.from(findLensProfiles(qc, BLOCKED))).toEqual([])
  })

  it('leaves the stock thread finder blind to lens entries', () => {
    const {qc} = setup()
    expect(Array.from(findAllPostsInQueryData(qc, ANCHOR))).toEqual([])
  })
})

describe('compiled reads (TL-34)', () => {
  it('re-reads the runId when a refetch writes a new snapshot', () => {
    const qc = new QueryClient()
    const key = lensKeyFor(INPUTS)!
    qc.setQueryData(key, {
      lens: snapshotWith([postNode(view('3kanchor22222'))], 'r1'),
    })
    const {result} = renderHook(() => useLensRunId(qc, key))
    expect(result.current).toBe('r1')
    act(() => {
      qc.setQueryData(key, {
        lens: snapshotWith([postNode(view('3kanchor22222'))], 'r2'),
      })
    })
    expect(result.current).toBe('r2')
  })
})
