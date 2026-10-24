import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

/*
 * The 4C pieces around the hooks (Phase 4 design 4.3, 7.4, 8.4, 8.5, 9.2,
 * 10, 11.3, 11.6; test 13 "Params reset", "Focus refetch", "Notice",
 * "Composer note", "Which rows are markers"): the screen hook's in-render
 * reset and refetches, the row decisions, the anchor's own "Load more
 * replies" row, the notice's lines, the composer note's rule and its walk
 * cache, and the split invalidation of the feature list.
 */

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({
    hasSession: true,
    currentAccount: {did: 'did:plc:readeraaaaaaaaaaaaaaaaaa'},
  }),
}))
jest.mock('#/horizon/thread-lens/GapRow', () => ({GapRow: () => null}))
jest.mock('#/horizon/thread-lens/MarkerRow', () => ({MarkerRow: () => null}))
jest.mock('#/screens/PostThread/components/ThreadItemReadMore', () => ({
  ThreadItemReadMore: () => null,
}))

import {type ReactElement} from 'react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {type ThreadItem} from '#/state/queries/usePostThread/types'
import {ThreadItemReadMore} from '#/screens/PostThread/components/ThreadItemReadMore'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {
  isLensAnchorRow,
  type LensState,
  selectLensAnswer,
  STOCK_LENS_STATE,
  withLensAnchorRow,
} from '#/horizon/thread-lens/adapt'
import {recordLensWait, resetLensWaits} from '#/horizon/thread-lens/api'
import {GapRow} from '#/horizon/thread-lens/GapRow'
import {MarkerRow} from '#/horizon/thread-lens/MarkerRow'
import {type LensNode} from '#/horizon/thread-lens/nodes'
import {lensNoticeLines} from '#/horizon/thread-lens/notice'
import {
  lensReplyNoteHolds,
  lensReplyNoteWalkCount,
} from '#/horizon/thread-lens/reply-note'
import {renderThreadLensRow} from '#/horizon/thread-lens/rows'
import {useThreadLensScreen} from '#/horizon/thread-lens/screen'
import {
  LENS_ROOT,
  lensQueryKey,
  type LensSnapshot,
} from '#/horizon/thread-lens/snapshot'
import {
  BRIDGING_LIMITED,
  BRIDGING_OFF,
  FALLBACK_NOTE,
  GAP_ONLY_NOTE,
  KEPT_NOTE,
  UNVERIFIED_NOTE,
} from '#/horizon/thread-lens/strings'
import {BLOCKED, publishClients, READER, server, uriOf, view} from './harness'

const ROOT = uriOf('3kroot2222222')
const B1 = uriOf('3kb1222222222', BLOCKED)
const C1 = uriOf('3kc1222222222')
const D1 = uriOf('3kd1222222222')
const E1 = uriOf('3ke1222222222', BLOCKED)

const KEY = lensQueryKey({
  did: READER,
  anchor: ROOT,
  depth: 10,
  mode: 'lens',
  marked: false,
})

function snapshot(
  nodes: LensNode[],
  extra: Partial<LensSnapshot> = {},
): LensSnapshot {
  return {
    form: 'snapshot',
    runId: 'run-1',
    anchor: {uri: ROOT, prismAnchor: ROOT},
    nodes: new Map(nodes.map(node => [node.uri, node])),
    markers: new Map(),
    stopped: new Set(),
    hidden: new Set(),
    bridging: ['full'],
    ...extra,
  }
}

function post(rkey: string, parentUri?: string, did?: string): LensNode {
  const v = view(rkey, {did, parent: parentUri, root: ROOT})
  return {kind: 'post', uri: v.uri, ...(parentUri ? {parentUri} : {}), view: v}
}

function gap(uri: string, kind: string, parentUri?: string): LensNode {
  return {
    kind: 'gap',
    uri,
    gap: kind,
    bridging: 'full',
    ...(parentUri ? {parentUri} : {}),
  }
}

function lens(partial: Partial<LensState>): LensState {
  return {...STOCK_LENS_STATE, ...partial}
}

beforeEach(() => {
  resetLensWaits()
  resetPrismFeatures()
})

describe('rows (TH-4, 8.4, 9.2)', () => {
  const thread = (state: LensState) => ({state: {lens: state, view: 'linear'}})
  const readMore = (uri: string): ThreadItem => ({
    type: 'readMore',
    key: `readMore:${uri}`,
    href: `/profile/x/post/y`,
    moreReplies: 1,
    depth: 2,
    skippedIndentIndices: new Set<number>(),
  })

  it('draws nothing under a stock key', () => {
    expect(renderThreadLensRow(readMore(C1), thread(STOCK_LENS_STATE))).toBe(
      null,
    )
  })

  it('draws a placeholder as a gap row, and a real post as stock', () => {
    const data = {
      lens: snapshot([post('3kroot2222222'), gap(B1, 'blocking-you', ROOT)]),
    }
    const answer = selectLensAnswer(data, {
      sort: 'oldest',
      view: 'linear',
      below: 10,
    }) as unknown as {
      thread: {value: {post: never}; depth: number; uri: string}[]
      lensState: LensState
    }
    const items = answer.thread.map(
      item =>
        ({
          type: 'threadPost',
          key: item.uri,
          uri: item.uri,
          depth: item.depth,
          value: item.value,
        }) as unknown as ThreadItem,
    )
    const state = thread(answer.lensState)
    expect(renderThreadLensRow(items[0], state)).toBe(null)
    const row = renderThreadLensRow(items[1], state) as ReactElement
    expect(row.type).toBe(GapRow)
  })

  it('tells a marker row from a stock row and a marked gap row', () => {
    const state = lens({
      kind: 'snapshot',
      markers: new Map([[C1, {kind: 'replies'}]]),
      gapUris: new Set([B1]),
    })
    expect(
      (renderThreadLensRow(readMore(C1), thread(state)) as ReactElement).type,
    ).toBe(MarkerRow)
    const marked = renderThreadLensRow(
      readMore(B1),
      thread(state),
    ) as ReactElement<{
      item: {href: string}
    }>
    expect(marked.type).toBe(ThreadItemReadMore)
    expect(marked.props.item.href).toBe('/profile/x/post/y?lens=gap')
    // A read-more row on a post node that is not a marker stays stock.
    expect(renderThreadLensRow(readMore(D1), thread(state))).toBe(null)
  })

  it('draws "Load earlier posts" only on a snapshot', () => {
    const up = {
      type: 'readMoreUp',
      key: `readMoreUp:${ROOT}`,
      href: '/p',
    } as ThreadItem
    const markers = new Map([[ROOT, {kind: 'parents' as const}]])
    expect(
      (
        renderThreadLensRow(
          up,
          thread(lens({kind: 'snapshot', markers})),
        ) as ReactElement
      ).type,
    ).toBe(MarkerRow)
    expect(
      renderThreadLensRow(up, thread(lens({kind: 'fallback', markers}))),
    ).toBe(null)
  })
})

describe("the anchor's own row (9.2; 4A risk 2)", () => {
  const anchor = {type: 'threadPost', key: ROOT, uri: ROOT, depth: 0}
  const reply = {type: 'threadPost', key: C1, uri: C1, depth: 1}
  const markers = new Map([[ROOT, {kind: 'replies' as const}]])

  it('goes after the replies and before the stock show-more row', () => {
    const other = {type: 'showOtherReplies', key: 'showOtherReplies'}
    const out = withLensAnchorRow(
      [anchor, reply, other],
      lens({kind: 'snapshot', markers}),
    )
    expect(out.map(item => item.key)).toEqual([
      ROOT,
      C1,
      `readMore:${ROOT}`,
      'showOtherReplies',
    ])
    expect(isLensAnchorRow(out[2])).toBe(true)
    expect((out[2] as unknown as {depth: number}).depth).toBe(1)
  })

  it('moves a stock row the traversal made for the anchor off depth 0', () => {
    const stock = {
      type: 'readMore',
      key: `readMore:${ROOT}`,
      href: '/held',
      depth: 0,
      moreReplies: 1,
      skippedIndentIndices: new Set(),
    }
    const out = withLensAnchorRow(
      [anchor, stock, reply],
      lens({kind: 'snapshot', markers}),
    )
    expect(out).toHaveLength(3)
    expect(out[1]).toMatchObject({depth: 1, href: '/held'})
  })

  it('adds nothing without the marker or outside a snapshot', () => {
    const items = [anchor, reply]
    expect(withLensAnchorRow(items, lens({kind: 'snapshot'}))).toBe(items)
    expect(withLensAnchorRow(items, lens({kind: 'fallback', markers}))).toBe(
      items,
    )
  })
})

describe('the notice (10, 11.3)', () => {
  const ids = (state: LensState) =>
    lensNoticeLines(state).map(line => [line.text.id, line.retry])

  it('words bridging, with Try again on the main off', () => {
    expect(ids(lens({kind: 'snapshot', bridging: 'full'}))).toEqual([])
    expect(ids(lens({kind: 'snapshot', bridging: 'limited'}))).toEqual([
      [BRIDGING_LIMITED.id, false],
    ])
    expect(ids(lens({kind: 'snapshot', bridging: 'off'}))).toEqual([
      [BRIDGING_OFF.id, true],
    ])
  })

  it('puts a kept failure first, then bridging', () => {
    expect(
      ids(
        lens({
          kind: 'snapshot',
          bridging: 'limited',
          note: {reason: '429', retryAt: 5, autoRetry: 'pending'},
        }),
      ),
    ).toEqual([
      [KEPT_NOTE['429'].id, true],
      [BRIDGING_LIMITED.id, false],
    ])
  })

  it('words fallbacks, gap-only and unverified answers', () => {
    expect(
      ids(
        lens({
          kind: 'fallback',
          note: {reason: 'unavailable', autoRetry: 'none'},
        }),
      ),
    ).toEqual([[FALLBACK_NOTE.unavailable.id, true]])
    // A refusal's fallback has no note.
    expect(ids(lens({kind: 'fallback'}))).toEqual([])
    expect(
      ids(lens({kind: 'gap-only', note: {reason: 'off', autoRetry: 'none'}})),
    ).toEqual([[GAP_ONLY_NOTE.off.id, false]])
    expect(
      ids(
        lens({kind: 'unverified', note: {reason: '429', autoRetry: 'spent'}}),
      ),
    ).toEqual([[UNVERIFIED_NOTE['429'].id, true]])
  })
})

describe('the composer note (8.5)', () => {
  const nodes = [
    gap(ROOT, 'blocking-you'),
    post('3kc1222222222', ROOT),
    post('3kd1222222222', C1),
    gap(E1, 'blocked-by-you', ROOT),
  ]

  it('shows under a blocking-you gap two levels up, not for blocked-by-you', () => {
    const qc = new QueryClient()
    qc.setQueryData(KEY, {lens: snapshot(nodes)})
    expect(lensReplyNoteHolds(qc, D1)).toBe(true)
    expect(lensReplyNoteHolds(qc, uriOf('3koutside2222'))).toBe(false)
    const other = new QueryClient()
    other.setQueryData(KEY, {
      lens: snapshot([
        post('3kroot2222222'),
        gap(E1, 'blocked-by-you', ROOT),
        post('3kd1222222222', E1),
      ]),
    })
    expect(lensReplyNoteHolds(other, D1)).toBe(false)
  })

  it('follows the latest snapshot and walks once per snapshot', () => {
    const qc = new QueryClient()
    const held = snapshot(nodes)
    qc.setQueryData(KEY, {lens: held})
    const before = lensReplyNoteWalkCount()
    expect(lensReplyNoteHolds(qc, D1)).toBe(true)
    expect(lensReplyNoteHolds(qc, D1)).toBe(true)
    expect(lensReplyNoteWalkCount()).toBe(before + 1)
    // A refetch whose answer no longer has the gap clears it.
    qc.setQueryData(KEY, {
      lens: snapshot([
        post('3kroot2222222'),
        post('3kc1222222222', ROOT),
        post('3kd1222222222', C1),
      ]),
    })
    expect(lensReplyNoteHolds(qc, D1)).toBe(false)
  })

  it('goes on past a cut chain in an older snapshot, never past a held post', () => {
    const qc = new QueryClient()
    const rootKey = KEY
    const d1Key = lensQueryKey({...KEY[1], anchor: D1})
    qc.setQueryData(
      rootKey,
      {
        lens: snapshot([
          post('3kroot2222222'),
          gap(B1, 'blocking-you', ROOT),
          post('3kc1222222222', B1),
          post('3kd1222222222', C1),
        ]),
      },
      {updatedAt: 1},
    )
    // D1's own screen, read later, holds C1 without its parent B1.
    qc.setQueryData(
      d1Key,
      {
        lens: snapshot([post('3kc1222222222', B1), post('3kd1222222222', C1)], {
          anchor: {uri: D1, prismAnchor: D1},
        }),
      },
      {updatedAt: 2},
    )
    expect(lensReplyNoteHolds(qc, D1)).toBe(true)
    // A later read that holds B1 as a post (an unblock) decides alone.
    qc.setQueryData(
      d1Key,
      {
        lens: snapshot(
          [
            post('3kroot2222222'),
            post('3kb1222222222', ROOT, BLOCKED),
            post('3kc1222222222', B1),
            post('3kd1222222222', C1),
          ],
          {anchor: {uri: D1, prismAnchor: D1}},
        ),
      },
      {updatedAt: 3},
    )
    expect(lensReplyNoteHolds(qc, D1)).toBe(false)
  })
})

describe('the screen hook (TH-6)', () => {
  function threadOf(
    state: LensState,
    {
      key = KEY,
      isFetching = false,
      refetch = jest.fn(),
    }: {
      key?: readonly unknown[]
      isFetching?: boolean
      refetch?: () => unknown
    } = {},
  ) {
    return {
      context: {postThreadQueryKey: key},
      state: {lens: state, isFetching},
      actions: {refetch},
    }
  }

  function render(qc: QueryClient, initial: ReturnType<typeof threadOf>) {
    const prepare = jest.fn()
    const hook = renderHook(
      ({thread}: {thread: ReturnType<typeof threadOf>}) =>
        useThreadLensScreen({
          prepareForParamsUpdate: prepare,
          thread,
          anchor: ROOT,
        }),
      {
        initialProps: {thread: initial},
        wrapper: ({children}) => (
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        ),
      },
    )
    return {...hook, prepare}
  }

  it('resets once when the first lens answer replaces a stock answer', () => {
    const qc = new QueryClient()
    const stockKey = ['post-thread-v2', {anchor: ROOT}]
    const {rerender, prepare} = render(
      qc,
      threadOf(STOCK_LENS_STATE, {key: stockKey}),
    )
    expect(prepare).not.toHaveBeenCalled()
    rerender({thread: threadOf(lens({kind: 'placeholder'}))})
    expect(prepare).not.toHaveBeenCalled()
    rerender({thread: threadOf(lens({kind: 'snapshot'}))})
    expect(prepare).toHaveBeenCalledTimes(1)
    rerender({thread: threadOf(lens({kind: 'snapshot'}))})
    expect(prepare).toHaveBeenCalledTimes(1)
    rerender({thread: threadOf(lens({kind: 'fallback'}))})
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('does not reset from placeholder data to the first answer (a cold load)', () => {
    const qc = new QueryClient()
    const {rerender, prepare} = render(
      qc,
      threadOf(lens({kind: 'placeholder'})),
    )
    rerender({thread: threadOf(lens({kind: 'snapshot'}))})
    expect(prepare).not.toHaveBeenCalled()
  })

  it('refetches once after an invalidation of its lens key, not during a wait', async () => {
    const qc = new QueryClient()
    qc.setQueryData(KEY, {lens: snapshot([post('3kroot2222222')])})
    const refetch = jest.fn()
    const state = lens({kind: 'snapshot'})
    const {rerender} = render(qc, threadOf(state, {refetch}))
    act(() => recordLensWait(READER, Date.now() + 60_000))
    await act(async () => {
      await qc.invalidateQueries({queryKey: [LENS_ROOT], refetchType: 'none'})
    })
    expect(refetch).not.toHaveBeenCalled()
    act(() => resetLensWaits())
    expect(refetch).toHaveBeenCalledTimes(1)
    // The fetch it starts clears the flag, so nothing more runs.
    await act(async () => {
      await qc.fetchQuery({
        queryKey: KEY,
        queryFn: () => ({lens: snapshot([])}),
      })
    })
    rerender({thread: threadOf(state, {refetch, isFetching: true})})
    rerender({thread: threadOf(state, {refetch})})
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('re-reads a stale fallback once per pair, also during a wait', () => {
    const qc = new QueryClient()
    act(() => recordLensWait(READER, Date.now() + 60_000))
    const refetch = jest.fn()
    const stale = lens({kind: 'fallback', fallbackStale: true})
    const {rerender} = render(qc, threadOf(stale, {refetch}))
    expect(refetch).toHaveBeenCalledTimes(1)
    rerender({thread: threadOf(stale, {refetch})})
    expect(refetch).toHaveBeenCalledTimes(1)
    // A fallback whose read keeps failing keeps its state: no loop.
    rerender({thread: threadOf(stale, {refetch, isFetching: true})})
    rerender({thread: threadOf(stale, {refetch})})
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('runs the one automatic 429 retry at its time', async () => {
    const qc = new QueryClient()
    const refetch = jest.fn()
    const state = lens({
      kind: 'fallback',
      note: {reason: '429', retryAt: Date.now() + 30, autoRetry: 'pending'},
    })
    render(qc, threadOf(state, {refetch}))
    expect(refetch).not.toHaveBeenCalled()
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    expect(refetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})

describe('the feature list (11.6)', () => {
  it('marks lens entries stale without refetching, and invalidates the rest', () => {
    const {client} = server(READER, () => undefined)
    const qc = publishClients({prism: client, appview: client})
    const spy = jest.spyOn(qc, 'invalidateQueries')
    answerPrismFeatures(READER, ['private', 'threadLens'])
    expect(spy).toHaveBeenCalledTimes(2)
    const [first, second] = spy.mock.calls.map(call => call[0]) as {
      predicate?: (query: {queryKey: unknown[]}) => boolean
      queryKey?: unknown[]
      refetchType?: string
    }[]
    expect(first.predicate?.({queryKey: [LENS_ROOT, {}]})).toBe(false)
    expect(first.predicate?.({queryKey: ['post-thread-v2', {}]})).toBe(true)
    expect(second).toEqual({queryKey: [LENS_ROOT], refetchType: 'none'})
  })
})
