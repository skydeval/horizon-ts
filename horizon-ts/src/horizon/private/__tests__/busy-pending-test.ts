import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {AppState} from 'react-native'
import {QueryClient, QueryObserver} from '@tanstack/react-query'

/*
 * T-9 (prism busy design 6.6) and T-2's catch-up cases (2.4): the pending
 * store's one confirmation loop, entries kept past the TTL while the PDS has
 * them, and the rate-limited catch-up once per episode.
 */
import {
  CATCHUP_MIN_MS,
  isPrivateQuery,
  registerCatchUpStep,
  resetCatchUp,
  runCatchUp,
  startCatchUp,
} from '#/horizon/private/catch-up'
import {hold, isHeld, isSyncing, resetKnown} from '#/horizon/private/known'
import {
  confirmPendingNow,
  PENDING_RECHECK_MS,
  resetPendingLoop,
  startPendingLoop,
} from '#/horizon/private/pending-confirm'
import {
  addPendingPost,
  clearPrivateStores,
  getPendingPost,
  PENDING_TTL_MS,
  type PendingPost,
} from '#/horizon/private/store'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  reportProbeStatus,
  reportReadOutcome,
  resetPrismHealth,
} from '#/horizon/routing/health'
import {DID, fakeClient, privateUri, RECORD_CID, type Reply} from './fixtures'

const POST = privateUri('3kpending222')
const POST_2 = privateUri('3kpending333')

let now = 0
let timers: {at: number; run: () => void; id: number}[] = []
let nextId = 1
let appState = 'active'

/** Run every timer due by `now`, in order. */
function runDue() {
  for (;;) {
    timers.sort((a, b) => a.at - b.at)
    const next = timers[0]
    if (!next || next.at > now) return
    timers.shift()
    next.run()
  }
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

let prismReply: (uris: string[]) => Reply = () => ({
  status: 200,
  body: {posts: []},
})
let pdsReply: (rkey: string) => Reply = () => ({
  status: 200,
  body: {uri: POST, cid: RECORD_CID, value: {}},
})

function entry(uri: string, writtenAt: number): PendingPost {
  return {
    uri,
    cid: RECORD_CID,
    did: DID,
    record: {text: 'hi', createdAt: new Date(writtenAt).toISOString()} as never,
    postView: {uri, cid: RECORD_CID, author: {did: DID}} as never,
    feedItem: {post: {uri}} as never,
    createdAt: new Date(writtenAt).toISOString(),
    expiresAt: writtenAt + PENDING_TTL_MS,
    phase: 'written',
  }
}

let prism: ReturnType<typeof fakeClient>
let pds: ReturnType<typeof fakeClient>
let qc: QueryClient

beforeEach(() => {
  now = 10 * 60 * 60_000
  timers = []
  appState = 'active'
  Object.defineProperty(AppState, 'currentState', {
    get: () => appState,
    configurable: true,
  })
  resetPrismHealth({
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextId++
      timers.push({at: now + ms, run, id})
      return id
    },
    clearTimeout: id => {
      timers = timers.filter(timer => timer.id !== id)
    },
    random: () => 0,
  })
  resetKnown()
  resetPendingLoop()
  resetCatchUp()
  clearPrivateStores()
  prismReply = () => ({status: 200, body: {posts: []}})
  pdsReply = () => ({status: 200, body: {uri: POST, cid: RECORD_CID, value: {}}})
  prism = fakeClient(DID, call =>
    call.nsid === 'app.nearhorizon.private.getPosts'
      ? prismReply(call.params.getAll('uris'))
      : {status: 501, body: {error: 'MethodNotImplemented'}},
  )
  pds = fakeClient(DID, call =>
    call.nsid === 'com.atproto.repo.getRecord'
      ? pdsReply(call.params.get('rkey') ?? '')
      : {status: 501, body: {error: 'MethodNotImplemented'}},
  )
  qc = new QueryClient()
  publishCurrentClients({
    did: DID,
    queryClient: qc,
    prismClient: prism.client,
    pdsClient: pds.client,
  } as unknown as CurrentClients)
})

afterEach(() => {
  resetPendingLoop()
  resetCatchUp()
  clearCurrentClients()
  qc.clear()
})

function getRecordCalls() {
  return pds.calls.filter(call => call.nsid === 'com.atproto.repo.getRecord')
}

function getPostsCalls() {
  return prism.calls.filter(
    call => call.nsid === 'app.nearhorizon.private.getPosts',
  )
}

describe('the pending store past its TTL (6.6, T-9)', () => {
  it('keeps an entry past ten minutes while the PDS has it, labelled "Syncing"', async () => {
    addPendingPost(entry(POST, now - PENDING_TTL_MS - 60_000))
    await confirmPendingNow()
    expect(getPendingPost(POST)).toBeDefined()
    expect(getRecordCalls()).toHaveLength(1)
    expect(isSyncing(DID, POST)).toBe(true)
    // Present: no PDS read again until another TTL has passed.
    now += 60_000
    await confirmPendingNow()
    expect(getRecordCalls()).toHaveLength(1)
    now += PENDING_TTL_MS
    await confirmPendingNow()
    expect(getRecordCalls()).toHaveLength(2)
  })

  it('drops an entry only on the PDS’s RecordNotFound', async () => {
    addPendingPost(entry(POST, now - PENDING_TTL_MS - 1))
    pdsReply = () => ({status: 500, body: {error: 'InternalServerError'}})
    await confirmPendingNow()
    expect(getPendingPost(POST)).toBeDefined()
    // Unknown: asked again 2 min later.
    now += PENDING_RECHECK_MS - 1
    await confirmPendingNow()
    expect(getRecordCalls()).toHaveLength(1)
    now += 1
    pdsReply = () => ({status: 400, body: {error: 'RecordNotFound'}})
    await confirmPendingNow()
    expect(getRecordCalls()).toHaveLength(2)
    expect(getPendingPost(POST)).toBeUndefined()
  })

  it('an entry prism lists in unavailable[] is kept with no PDS read', async () => {
    addPendingPost(entry(POST, now - PENDING_TTL_MS - 1))
    prismReply = () => ({
      status: 200,
      body: {posts: [], unavailable: [{uri: POST, reason: 'syncing'}]},
    })
    await confirmPendingNow()
    expect(getPendingPost(POST)).toBeDefined()
    expect(getRecordCalls()).toHaveLength(0)
  })

  it('confirms what prism serves, and keeps the rest', async () => {
    addPendingPost(entry(POST, now - 60_000))
    addPendingPost(entry(POST_2, now - 60_000))
    prismReply = uris => ({
      status: 200,
      body: {
        posts: uris
          .filter(uri => uri === POST)
          .map(uri => ({
            uri,
            cid: RECORD_CID,
            author: {did: DID, handle: 'a.test'},
            record: {
              $type: 'tools.kryphocron.feed.postPrivate',
              text: 'hi',
              createdAt: new Date(now).toISOString(),
            },
            indexedAt: new Date(now).toISOString(),
            labels: [],
          })),
      },
    })
    await confirmPendingNow()
    expect(getPendingPost(POST)).toBeUndefined()
    expect(getPendingPost(POST_2)).toBeDefined()
  })

  it('skips prism while unwell or in the background, and asks every 30 to 60 s', async () => {
    addPendingPost(entry(POST, now - 60_000))
    reportProbeStatus(DID, 'reindexing')
    await confirmPendingNow()
    expect(getPostsCalls()).toHaveLength(0)
    reportProbeStatus(DID, 'member')
    appState = 'background'
    await confirmPendingNow()
    expect(getPostsCalls()).toHaveLength(0)
    appState = 'active'
    // The loop's own timer: 30 s with no jitter.
    startPendingLoop()
    now += 30_000
    runDue()
    await flush()
    expect(getPostsCalls()).toHaveLength(1)
  })

  it('slows to 5 min once the newest entry is 30 min old, and stops with nothing pending', async () => {
    addPendingPost(entry(POST, now - 31 * 60_000))
    startPendingLoop()
    const armed = timers.map(timer => timer.at - now)
    expect(Math.min(...armed)).toBe(5 * 60_000)
    clearPrivateStores()
    now += 5 * 60_000
    runDue()
    await flush()
    expect(getPostsCalls()).toHaveLength(0)
  })
})

describe('the catch-up (2.4)', () => {
  function answered(seq: number) {
    reportReadOutcome(DID, {
      kind: 'answered',
      method: 'app.nearhorizon.private.getPosts',
      seq,
      read: true,
      degraded: false,
      retryAfterMs: undefined,
    })
  }

  it('tells private queries apart', () => {
    expect(isPrivateQuery({queryKey: ['horizon-private-search', DID]})).toBe(
      true,
    )
    expect(
      isPrivateQuery({queryKey: ['post-feed', 'following', {}, {horizonPrivate: DID}]}),
    ).toBe(true)
    expect(isPrivateQuery({queryKey: ['post-thread', POST]})).toBe(true)
    expect(isPrivateQuery({queryKey: ['post-feed', 'following', {}]})).toBe(
      false,
    )
  })

  it('refetches an active private query in error, marks an infinite one stale, and never refetches it in place', async () => {
    const single = jest.fn(() => Promise.resolve('ok'))
    const infinite = jest.fn(() => Promise.resolve({posts: []}))
    // An errored thread query, observed (active).
    await qc
      .fetchQuery({
        queryKey: ['post-thread', POST],
        queryFn: () => Promise.reject(new Error('down')),
        retry: false,
      })
      .catch(() => {})
    const watcher = new QueryObserver(qc, {
      queryKey: ['post-thread', POST],
      queryFn: single,
      retry: false,
      retryOnMount: false,
      refetchOnMount: false,
      staleTime: Infinity,
    })
    const off = watcher.subscribe(() => {})
    single.mockClear()
    await qc.prefetchInfiniteQuery({
      queryKey: ['horizon-private-search', DID, 'q'],
      queryFn: infinite,
      initialPageParam: undefined,
    })
    infinite.mockClear()
    const step = jest.fn()
    const unregister = registerCatchUpStep(step)
    runCatchUp(qc, DID)
    await flush()
    expect(single).toHaveBeenCalled()
    expect(infinite).not.toHaveBeenCalled()
    expect(
      qc.getQueryState(['horizon-private-search', DID, 'q'])?.isInvalidated,
    ).toBe(true)
    expect(step).toHaveBeenCalledWith(DID, qc)
    unregister()
    off()
  })

  it('runs once per episode after the jitter, no sooner than CATCHUP_MIN_MS after the last, doubling while episodes recur', () => {
    const step = jest.fn()
    const unregister = registerCatchUpStep(step)
    startCatchUp()
    reportProbeStatus(DID, 'reindexing')
    reportProbeStatus(DID, 'member')
    answered(1)
    runDue()
    expect(step).toHaveBeenCalledTimes(1)

    // A second episode 10 s later: the gap doubles to 60 s.
    now += 10_000
    reportProbeStatus(DID, 'reindexing')
    reportProbeStatus(DID, 'member')
    answered(2)
    runDue()
    expect(step).toHaveBeenCalledTimes(1)
    now += 2 * CATCHUP_MIN_MS - 10_000 - 1
    runDue()
    expect(step).toHaveBeenCalledTimes(1)
    now += 1
    runDue()
    expect(step).toHaveBeenCalledTimes(2)

    // A quiet episode long after: back to 30 s, and at once.
    now += 30 * 60_000
    reportProbeStatus(DID, 'reindexing')
    reportProbeStatus(DID, 'member')
    answered(3)
    runDue()
    expect(step).toHaveBeenCalledTimes(3)
    unregister()
  })

  it('does not run when the account is unwell again by its time', () => {
    const step = jest.fn()
    const unregister = registerCatchUpStep(step)
    startCatchUp()
    reportProbeStatus(DID, 'reindexing')
    reportProbeStatus(DID, 'member')
    answered(1)
    runDue()
    expect(step).toHaveBeenCalledTimes(1)
    now += 5_000
    reportProbeStatus(DID, 'reindexing')
    reportProbeStatus(DID, 'member')
    answered(2)
    reportProbeStatus(DID, 'reindexing')
    now += 10 * 60_000
    runDue()
    expect(step).toHaveBeenCalledTimes(1)
    unregister()
  })

  it('confirms pending entries on the catch-up', async () => {
    addPendingPost(entry(POST, now - 60_000))
    startPendingLoop()
    startCatchUp()
    reportProbeStatus(DID, 'reindexing')
    reportProbeStatus(DID, 'member')
    answered(1)
    runDue()
    await flush()
    expect(getPostsCalls()).toHaveLength(1)
  })
})

describe('holds with no URI end on recovery (HR2-L3)', () => {
  const KEY = ['post-thread', POST]
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))

  it('a query held over its data during an outage is not held once its next fetch succeeds', async () => {
    qc.setQueryData(KEY, 'kept')
    hold(KEY, undefined, qc, DID)
    expect(isHeld(DID, KEY)).toBe(true)
    await tick()
    // A manual write is not a 2xx.
    qc.setQueryData(KEY, 'written')
    expect(isHeld(DID, KEY)).toBe(true)
    await qc.fetchQuery({queryKey: KEY, queryFn: () => 'fresh', staleTime: 0})
    await flush()
    expect(isHeld(DID, KEY)).toBe(false)
  })

  it('the fetch that made the hold does not end it, even when it succeeds', async () => {
    await qc.fetchQuery({
      queryKey: KEY,
      queryFn: () => {
        hold(KEY, undefined, qc, DID)
        return 'partial'
      },
    })
    await flush()
    await tick()
    expect(isHeld(DID, KEY)).toBe(true)
    await qc.fetchQuery({queryKey: KEY, queryFn: () => 'full', staleTime: 0})
    await flush()
    expect(isHeld(DID, KEY)).toBe(false)
  })

  it('the catch-up releases holds with no URI, and keeps a URI’s until its serve', () => {
    qc.setQueryData(KEY, 'kept')
    qc.setQueryData(['horizon-private-quote', {uri: POST_2}], null)
    hold(KEY, undefined, qc, DID)
    hold(['horizon-private-quote', {uri: POST_2}], POST_2, qc, DID)
    runCatchUp(qc, DID)
    expect(isHeld(DID, KEY)).toBe(false)
    expect(isHeld(DID, ['horizon-private-quote', {uri: POST_2}])).toBe(true)
  })
})
