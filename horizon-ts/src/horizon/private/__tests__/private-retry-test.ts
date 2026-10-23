import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from '@tanstack/react-query'

/*
 * T-5's retry cases (prism busy design 5, BR-4, BR10-N6, BR11-L2, BR11-N2,
 * BR12-L2), against the query-core this app runs: the rethrow over data is
 * never retried and keeps `dataUpdatedAt`; a page the query does not have is
 * retried; a lead with data and a waiter without each get their own error;
 * Try again restarts a query sleeping between retries at once.
 */
import {getPrivateTimeline} from '#/horizon/private/api/reads'
import {
  isKeptError,
  keepOverData,
  PRIVATE_RETRY,
  PRIVATE_RETRY_TRIES,
  privateRetry,
  privateRetryDelay,
  PrivateSuspectMissError,
  PrivateWaiterError,
  restartPrivateQuery,
} from '#/horizon/private/api/transient'
import {heldQueries, noteMiss, resetKnown} from '#/horizon/private/known'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {getPrismHealth, resetPrismHealth} from '#/horizon/routing/health'
import {resetMembership} from '#/horizon/routing/membership'
import {type Call, DID, fakeClient, OTHER_DID, type Reply} from './fixtures'
import {privateView} from './read-fixtures'

type Held = {call: Call; resolve: (reply: Reply) => void}

const REINDEXING: Reply = {
  status: 503,
  body: {error: 'Reindexing', retryAfter: 30},
}
const PAGE: Reply = {status: 200, body: {feed: [privateView('3kpage222222')]}}

let held: Held[] = []
let prism: ReturnType<typeof fakeClient>
let qc: QueryClient

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

beforeEach(() => {
  resetPrismHealth({random: () => 0})
  resetMembership()
  resetPrismFeatures()
  resetKnown()
  held = []
  prism = fakeClient(
    DID,
    call => new Promise<Reply>(resolve => held.push({call, resolve})),
  )
  qc = new QueryClient()
  publishCurrentClients({
    did: DID,
    prismClient: prism.client,
    queryClient: qc,
  } as unknown as CurrentClients)
})

afterEach(async () => {
  await qc.cancelQueries()
  qc.clear()
  clearCurrentClients()
})

/** A private read as a query's own fetch, kept over data (design 5). */
function timelineQueryFn(context: Parameters<typeof keepOverData>[0]) {
  return keepOverData(context, () => getPrivateTimeline(prism.client, {}))
}

/** Answer the oldest held request. */
async function answer(reply: Reply) {
  await until(() => held.length > 0)
  held.shift()!.resolve(reply)
  await settle()
}

describe('privateRetry and privateRetryDelay (5)', () => {
  it('retries a transient error fewer than five times, never a permanent or kept one', async () => {
    const transient = new TypeError('Network request failed')
    expect(privateRetry(0, transient)).toBe(true)
    expect(privateRetry(PRIVATE_RETRY_TRIES - 1, transient)).toBe(true)
    expect(privateRetry(PRIVATE_RETRY_TRIES, transient)).toBe(false)
    expect(privateRetry(0, new Error('NotFound'))).toBe(false)
    const kept = new TypeError('Network request failed')
    qc.setQueryData(['kept'], 'data')
    await keepOverData({client: qc, queryKey: ['kept']}, () =>
      Promise.reject(kept),
    ).catch(() => {})
    expect(isKeptError(kept)).toBe(true)
    expect(privateRetry(0, kept)).toBe(false)
    expect(heldQueries(DID).map(h => h.queryKey)).toEqual([['kept']])
  })

  it('waits for health’s retryAt; a suspect’s miss waits for its suspect clock', async () => {
    const pending = getPrivateTimeline(prism.client, {}).catch(
      (e: unknown) => e,
    )
    await answer(REINDEXING)
    const error = await pending
    const wait = getPrismHealth(DID).retryAt - Date.now()
    expect(privateRetryDelay(1, error)).toBeGreaterThan(29_000)
    expect(privateRetryDelay(1, error)).toBeLessThanOrEqual(wait + 500)

    const uri = privateView('3ksuspect222', {did: OTHER_DID}).uri
    noteMiss({did: DID, seq: 99}, uri, {signalled: true, retryAfterMs: 90_000})
    const miss = new PrivateSuspectMissError(undefined, {did: DID, uri})
    expect(privateRetryDelay(1, miss)).toBeGreaterThan(89_000)
  })
})

describe('the rethrow over data (5, BR-4)', () => {
  it('a refetch over data that fails transiently is not retried, keeps its data and dataUpdatedAt', async () => {
    const key = ['horizon-test-thread']
    qc.setQueryData(key, {kept: true}, {updatedAt: 1_000})
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: timelineQueryFn,
      staleTime: Infinity,
      ...PRIVATE_RETRY,
    })
    const off = observer.subscribe(() => {})
    void observer.refetch()
    await answer(REINDEXING)
    const state = qc.getQueryState(key)!
    expect(state.status).toBe('error')
    expect(state.fetchStatus).toBe('idle')
    expect(state.fetchFailureCount).toBe(1)
    expect(state.data).toEqual({kept: true})
    expect(state.dataUpdatedAt).toBe(1_000)
    expect(held).toHaveLength(0)
    off()
  })

  it('a fetchNextPage failure is retried; a refetch of a page shown is not, told apart by pageParam', async () => {
    const key = ['horizon-test-feed']
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: key,
      queryFn: timelineQueryFn,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: () => 'next',
      staleTime: Infinity,
      ...PRIVATE_RETRY,
    })
    const off = observer.subscribe(() => {})
    await answer(PAGE)
    expect(qc.getQueryState(key)?.status).toBe('success')

    void observer.fetchNextPage()
    await answer({status: 500, body: {error: 'InternalServerError'}})
    // Sleeping before its retry: still fetching, one failure counted.
    expect(qc.getQueryState(key)?.fetchStatus).toBe('fetching')
    expect(qc.getQueryState(key)?.fetchFailureCount).toBe(1)
    await qc.cancelQueries({queryKey: key})

    void observer.refetch()
    await answer({status: 500, body: {error: 'InternalServerError'}})
    expect(qc.getQueryState(key)?.fetchStatus).toBe('idle')
    expect(qc.getQueryState(key)?.status).toBe('error')
    expect(qc.getQueryData<{pages: unknown[]}>(key)?.pages).toHaveLength(1)
    off()
  })

  it('a lead with data and a waiter without, failing on one Reindexing: each its own error; the waiter retries, the lead does not (BR11-L2)', async () => {
    // A first Reindexing makes the account single-flight.
    const first = getPrivateTimeline(prism.client, {}).catch(() => {})
    await answer(REINDEXING)
    await first

    const withData = ['horizon-test-a']
    const withoutData = ['horizon-test-b']
    qc.setQueryData(withData, {kept: true}, {updatedAt: 1_000})
    const a = new QueryObserver(qc, {
      queryKey: withData,
      queryFn: timelineQueryFn,
      staleTime: Infinity,
      ...PRIVATE_RETRY,
    })
    const b = new QueryObserver(qc, {
      queryKey: withoutData,
      queryFn: timelineQueryFn,
      ...PRIVATE_RETRY,
    })
    const offA = a.subscribe(() => {})
    void a.refetch()
    await until(() => held.length === 1)
    const offB = b.subscribe(() => {})
    await settle()
    // b waits behind a's lead: one call in flight.
    expect(held).toHaveLength(1)
    await answer(REINDEXING)

    const stateA = qc.getQueryState(withData)!
    const stateB = qc.getQueryState(withoutData)!
    expect(stateA.fetchStatus).toBe('idle')
    expect(stateA.data).toEqual({kept: true})
    expect(stateB.fetchStatus).toBe('fetching')
    expect(stateB.fetchFailureCount).toBe(1)
    expect(stateB.fetchFailureReason).toBeInstanceOf(PrivateWaiterError)
    expect(stateB.fetchFailureReason).not.toBe(stateA.error)
    offA()
    offB()
  })
})

describe('Try again (restartPrivateQuery, BR12-L2)', () => {
  it('a query with no data sleeping between retries under Reindexing fetches at once, not after its delay', async () => {
    const key = ['horizon-test-empty']
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: timelineQueryFn,
      ...PRIVATE_RETRY,
    })
    const off = observer.subscribe(() => {})
    await answer(REINDEXING)
    expect(qc.getQueryState(key)?.fetchStatus).toBe('fetching')
    expect(held).toHaveLength(0)

    const startedAt = Date.now()
    void restartPrivateQuery(qc, key)
    await until(() => held.length === 1)
    await answer(PAGE)
    await until(() => qc.getQueryState(key)?.status === 'success')
    // The retry's own delay was about 30 s; this took well under it.
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    off()
  })
})
