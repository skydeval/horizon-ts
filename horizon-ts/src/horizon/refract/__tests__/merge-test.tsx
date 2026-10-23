import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * 11.1 "thread", RF-B5b (refract client design 4.2 steps 2 and 3): the
 * thread hook's merge on read and its "lens active" skip. The merge, the
 * `getReplies` query and the hidden-parents fill run for a stock answer and
 * for a fallback whose anchor is not lens-only, never for a snapshot,
 * gap-only, unverified or placeholder answer under a lens key; no lens gap
 * URI and no private URI is ever sent. Synthetic fixtures; Refract's calls
 * are fakes.
 */

let mockActive = true
const mockRefractCall =
  jest.fn<
    (method: string, params: Record<string, unknown>) => Promise<unknown>
  >()
const mockAskFill = jest.fn<(request: {uris?: string[]}) => Promise<unknown>>()

jest.mock('#/horizon/refract/gate', () => ({
  refractActive: () => mockActive,
  useRefractActive: () => mockActive,
}))
jest.mock('#/horizon/refract/api', () => ({
  refractCall: (method: string, params: Record<string, unknown>) =>
    mockRefractCall(method, params),
}))
jest.mock('#/horizon/refract/fill', () => ({
  askFill: (request: {uris?: string[]}) => mockAskFill(request),
}))
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  subscribeMembership: () => () => {},
  isPrivateMember: () => true,
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentDid: () => 'did:plc:rfxreader000000000000000001',
  useCurrentClients: () => ({did: 'did:plc:rfxreader000000000000000001'}),
}))

import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook} from '@testing-library/react-native'

import {postItem} from '#/horizon/private/thread/fetch'
import {
  RF_READER_DID,
  RF_STOCK_DID,
  rfPost,
  rfUri,
} from '#/horizon/refract/fixtures'
import {addOwnRestoredReply, clearRestoredStore} from '#/horizon/refract/store'
import {
  hiddenParentUris,
  refractMergeAllowed,
  sendableToRefract,
  threadRootOf,
  useRestoredThreadMerge,
} from '#/horizon/refract/thread/merge'
import {
  registerLensGaps,
  resetLensRegistry,
} from '#/horizon/thread-lens/registry'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView
type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem

const ROOT = rfUri('root', RF_STOCK_DID)
const PARENT = rfUri('parent', RF_STOCK_DID)
const ANCHOR = rfUri('anchor', RF_STOCK_DID)
const PRIVATE_ROOT = `at://${RF_STOCK_DID}/tools.kryphocron.feed.postPrivate/p1`

function stockPost(rkey: string, reply?: {parent: string; root: string}) {
  return rfPost(rkey, {
    did: RF_STOCK_DID,
    restored: false,
    reply,
  }) as unknown as PostView
}

function notFound(uri: string, depth: number): ThreadItem {
  return {
    uri: uri as never,
    depth,
    value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'},
  }
}

const anchorPost = stockPost('anchor', {parent: PARENT, root: ROOT})
const restoredReply = rfPost('r1', {
  reply: {parent: ANCHOR, root: ROOT},
}) as unknown as PostView
const restoredParent = rfPost('parent', {
  did: RF_STOCK_DID,
}) as unknown as PostView

function stockThread(): ThreadItem[] {
  return [notFound(ROOT, -2), notFound(PARENT, -1), postItem(anchorPost, 0, {})]
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

function render(
  props: Partial<Parameters<typeof useRestoredThreadMerge>[0]> = {},
) {
  const qc = new QueryClient({defaultOptions: {queries: {retry: false}}})
  const thread = props.thread ?? stockThread()
  return renderHook(
    () =>
      useRestoredThreadMerge({
        anchor: ANCHOR,
        thread,
        allowed: true,
        isPlaceholderData: false,
        below: 10,
        branchingFactor: 1,
        sort: 'oldest',
        ...props,
      }),
    {
      wrapper: ({children}) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    },
  )
}

function uris(items: ThreadItem[]) {
  return items.map(item => `${item.depth}:${item.uri.split('/').pop()}`)
}

function sentUris(): string[] {
  return [
    ...mockRefractCall.mock.calls.flatMap(([, params]) => [
      params.anchor as string,
      params.root as string,
    ]),
    ...mockAskFill.mock.calls.flatMap(([request]) => request.uris ?? []),
  ]
}

beforeEach(() => {
  mockActive = true
  mockRefractCall.mockReset()
  mockRefractCall.mockResolvedValue({
    body: {posts: [restoredReply]},
    lateVisitor: false,
  })
  mockAskFill.mockReset()
  mockAskFill.mockResolvedValue({
    uris: new Map([[PARENT, {kind: 'positive', post: restoredParent}]]),
  })
  clearRestoredStore()
  resetLensRegistry()
})

describe('refractMergeAllowed (the seam)', () => {
  it('merges stock and a fallback, skips everything else under a lens key', () => {
    const allowed = (kind: string, lensKey = true, lensOnly = false) =>
      refractMergeAllowed({kind, lensKey, lensOnly})
    expect(allowed('stock', false)).toBe(true)
    expect(allowed('fallback')).toBe(true)
    expect(allowed('snapshot')).toBe(false)
    expect(allowed('gap-only')).toBe(false)
    expect(allowed('unverified')).toBe(false)
    expect(allowed('placeholder')).toBe(false)
    // A lens-key answer that reads as stock is not trusted.
    expect(allowed('stock', true)).toBe(false)
    // A fallback whose anchor has become lens-only.
    expect(allowed('fallback', true, true)).toBe(false)
  })
})

describe('the inputs', () => {
  it('reads the root from the anchor, or the anchor when top-level', () => {
    expect(threadRootOf(stockThread(), ANCHOR)).toBe(ROOT)
    const top = stockPost('anchor')
    expect(threadRootOf([postItem(top, 0, {})], ANCHOR)).toBe(ANCHOR)
    expect(threadRootOf([notFound(ANCHOR, 0)], ANCHOR)).toBeUndefined()
  })

  it('names only the parent and root stock shows as not found', () => {
    expect(hiddenParentUris(stockThread(), ANCHOR)).toEqual([PARENT, ROOT])
    const shown = [
      postItem(stockPost('root'), -2, {}),
      notFound(PARENT, -1),
      postItem(anchorPost, 0, {}),
    ]
    expect(hiddenParentUris(shown, ANCHOR)).toEqual([PARENT])
  })

  it('never sends a lens gap or a private URI', () => {
    expect(sendableToRefract(RF_READER_DID, ROOT)).toBe(true)
    registerLensGaps(RF_READER_DID, [[ROOT, 'blocking-you']])
    expect(sendableToRefract(RF_READER_DID, ROOT)).toBe(false)
    expect(sendableToRefract(RF_READER_DID, PRIVATE_ROOT)).toBe(false)
  })
})

describe('useRestoredThreadMerge', () => {
  it('merges the dropped replies and the filled parent into a stock thread', async () => {
    const {result} = render()
    await settle()
    expect(mockRefractCall).toHaveBeenCalledTimes(1)
    expect(mockRefractCall.mock.calls[0][1]).toEqual({
      anchor: ANCHOR,
      root: ROOT,
    })
    expect(mockAskFill.mock.calls[0][0].uris).toEqual([PARENT, ROOT])
    expect(uris(result.current)).toEqual([
      '-2:root',
      '-1:parent',
      '0:anchor',
      '1:r1',
    ])
    expect(result.current[1].value.$type).toBe(
      'app.bsky.unspecced.defs#threadItemPost',
    )
  })

  it('places the reader’s own reply under a restored parent', async () => {
    const own = rfPost('own', {
      did: RF_READER_DID,
      restored: false,
      reply: {parent: restoredReply.uri, root: ROOT},
    }) as unknown as PostView
    addOwnRestoredReply(own)
    const {result} = render()
    await settle()
    expect(uris(result.current)).toContain('2:own')
  })

  it('sends nothing and returns the thread itself when skipped', async () => {
    const thread = stockThread()
    const {result} = render({thread, allowed: false})
    await settle()
    expect(mockRefractCall).not.toHaveBeenCalled()
    expect(mockAskFill).not.toHaveBeenCalled()
    expect(result.current).toBe(thread)
  })

  it('sends nothing while Refract is not active', async () => {
    mockActive = false
    const thread = stockThread()
    const {result} = render({thread})
    await settle()
    expect(mockRefractCall).not.toHaveBeenCalled()
    expect(mockAskFill).not.toHaveBeenCalled()
    expect(result.current).toBe(thread)
  })

  it('never sends a URI the lens drew as a gap', async () => {
    registerLensGaps(RF_READER_DID, [[ROOT, 'blocking-you']])
    const {result} = render()
    await settle()
    expect(sentUris()).not.toContain(ROOT)
    // The root is the getReplies selector: without it, no getReplies.
    expect(mockRefractCall).not.toHaveBeenCalled()
    expect(mockAskFill.mock.calls[0][0].uris).toEqual([PARENT])
    expect(uris(result.current)).toEqual(['-2:root', '-1:parent', '0:anchor'])
  })

  it('never sends anything for an anchor the lens drew as a gap', async () => {
    registerLensGaps(RF_READER_DID, [[ANCHOR, 'blocking-you']])
    render()
    await settle()
    expect(mockRefractCall).not.toHaveBeenCalled()
    expect(mockAskFill).not.toHaveBeenCalled()
  })

  it('a gap drawn after mount stops the next requests for it', async () => {
    const {rerender} = render({thread: stockThread()})
    await settle()
    mockAskFill.mockClear()
    act(() => registerLensGaps(RF_READER_DID, [[PARENT, 'blocking-you']]))
    rerender({})
    await settle()
    for (const [request] of mockAskFill.mock.calls) {
      expect(request.uris).not.toContain(PARENT)
    }
  })

  it('asks while placeholder data shows but merges only over the answer', async () => {
    const thread = [postItem(anchorPost, 0, {})]
    const {result} = render({thread, isPlaceholderData: true})
    await settle()
    expect(mockRefractCall).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(thread)
  })

  it('a failed getReplies leaves the stock thread as it is', async () => {
    mockRefractCall.mockRejectedValue(new Error('offline'))
    mockAskFill.mockResolvedValue({uris: new Map()})
    const thread = stockThread()
    const {result} = render({thread})
    await settle()
    expect(result.current).toBe(thread)
  })
})
