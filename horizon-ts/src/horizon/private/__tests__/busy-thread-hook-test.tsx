import {beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  useMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))
let mockPlaceholder: unknown
jest.mock('#/state/queries/usePostThread/queryCache', () => ({
  getThreadPlaceholder: () => mockPlaceholder,
}))

/*
 * T-6's wait cap and errors (prism busy design 5, 6.1): a private thread with
 * nothing to show waits at most 30 s on the skeleton, then the quiet row; a
 * transient failure over something to show never reaches `ThreadError`.
 */
import {XrpcResponseError} from '@atproto/lex'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook} from '@testing-library/react-native'

import {resetKnown} from '#/horizon/private/known'
import {EMPTY_WAIT_MS} from '#/horizon/private/load-gate'
import {useThreadBusy} from '#/horizon/private/thread/busy'
import {isUnavailableValue, postItem} from '#/horizon/private/thread/fetch'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {resetPrismHealth} from '#/horizon/routing/health'
import {DID, privateUri, RECORD_CID} from './fixtures'

const ANCHOR = privateUri('3kanchor')
const KEY = ['post-thread-v2', {anchor: ANCHOR}]

let now = 1_000_000
let timers: {at: number; run: () => void}[] = []

function reindexing() {
  const body = {error: 'Reindexing', message: 'x'}
  return new XrpcResponseError(
    {nsid: 'app.nearhorizon.private.getPostThread'} as never,
    new Response(JSON.stringify(body), {
      status: 503,
      headers: {'content-type': 'application/json'},
    }),
    {encoding: 'application/json', body} as never,
  )
}

function placeholderItem() {
  return postItem(
    {
      uri: ANCHOR,
      cid: RECORD_CID,
      author: {did: DID, handle: 'me.test'},
      record: {},
      indexedAt: '',
    } as never,
    0,
    {},
  )
}

function renderBusy(query: Record<string, unknown>) {
  const qc = new QueryClient()
  return renderHook(
    (props: {query: Record<string, unknown>}) =>
      useThreadBusy({anchor: ANCHOR, queryKey: KEY, query: props.query as never}),
    {
      initialProps: {query},
      wrapper: ({children}) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    },
  )
}

beforeEach(() => {
  now = 1_000_000
  timers = []
  mockPlaceholder = undefined
  resetPrismHealth({
    now: () => now,
    random: () => 0.5,
    setTimeout: (run, ms) => {
      timers.push({at: now + ms, run})
      return timers.length
    },
    clearTimeout: () => {},
  })
  resetKnown()
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'me.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: {} as never,
    appviewClient: {} as never,
  })
})

const waiting = {
  data: {thread: [], hasOtherReplies: false},
  isPlaceholderData: true,
  status: 'pending',
  fetchStatus: 'fetching',
  isFetching: true,
  error: null,
}

describe('the wait cap (design 5)', () => {
  it('shows the skeleton, then the quiet row once it has waited 30 s', () => {
    const {result} = renderBusy(waiting)
    expect(result.current.isLoading).toBe(true)
    expect(result.current.thread).toEqual([])
    act(() => {
      now += EMPTY_WAIT_MS
      timers.filter(timer => timer.at <= now).forEach(timer => timer.run())
    })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.thread).toHaveLength(1)
    expect(isUnavailableValue(result.current.thread[0].value)).toBe(true)
  })
})

describe('errors (6.1)', () => {
  it('after the tries, a transient failure with a placeholder keeps it, with the quiet row below, and no ThreadError', () => {
    mockPlaceholder = placeholderItem()
    const {result} = renderBusy({
      data: undefined,
      isPlaceholderData: false,
      status: 'error',
      fetchStatus: 'idle',
      isFetching: false,
      error: reindexing(),
    })
    expect(result.current.error).toBeUndefined()
    expect(result.current.quietRow).toBe(true)
    expect(result.current.thread.map(item => item.uri)).toEqual([ANCHOR])
  })

  it('a transient failure over data keeps the data and passes no error; a permanent one passes', () => {
    const data = {thread: [placeholderItem()], hasOtherReplies: false}
    const {result, rerender} = renderBusy({
      data,
      isPlaceholderData: false,
      status: 'error',
      fetchStatus: 'idle',
      isFetching: false,
      error: reindexing(),
    })
    expect(result.current.error).toBeUndefined()
    expect(result.current.thread).toHaveLength(1)
    const permanent = new Error('boom')
    rerender({
      query: {
        data,
        isPlaceholderData: false,
        status: 'error',
        fetchStatus: 'idle',
        isFetching: false,
        error: permanent,
      },
    })
    expect(result.current.error).toBe(permanent)
  })
})
