/*
 * The lens snapshot and the per-entry continuation queue (Phase 4 design
 * 9.1, TL-26).
 *
 * One owner: all lens state for a screen is the data of its lens cache
 * entry. A `queryFn` run builds a new snapshot from its first response
 * alone; a continuation, a retry, an optimistic reply or a threadgate write
 * builds the next one from the entry's current data at the moment it
 * writes, copying the maps and carrying every held view by reference.
 *
 * The queue runs one continuation or retry at a time per entry and holds
 * row state only, never a node. It is a store (TL-34): a `WeakMap` keyed by
 * the entry's own `Query` object, so a new query client (an account switch)
 * never shares a queue with an old one and an entry collected and opened
 * again gets a fresh one (v7: R5-L1). Rows read it through
 * {@link useLensRowState}, two primitive snapshots. A time's end is a store
 * event: each row's `retryAt` and "Still unavailable" have a timer that
 * moves the row and notifies (v8: R6-L1).
 *
 * A task writes only if, when its answer is in, (a) the entry's data is a
 * snapshot with the `runId` it started on, (b) the entry is not fetching,
 * (c) the cache's entry for its key is still the `Query` it started on and
 * (d) its queue is not dropped and is still the one serving that `Query`.
 * Its gaps are registered in that write only, for its key's DID (v8: R6-N3).
 * A queue is dropped when its `Query` is removed, or when the published DID
 * changes to another account (checked in a microtask after a
 * `subscribeCurrentClients` event, v9: R7-N1); dropping clears its timers
 * and waiting tasks, and its task in flight then writes nothing.
 */

import {useSyncExternalStore} from 'react'
import {
  type Query,
  type QueryCache,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query'

import {type UsePostThreadQueryResult} from '#/state/queries/usePostThread/types'
import {
  getCurrentDid,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  type LensMarkers,
  type LensNode,
  type MergeResult,
  UNVERIFIED_GAP,
} from '#/horizon/thread-lens/nodes'
import {registerLensGaps} from '#/horizon/thread-lens/registry'

/** The lens query key root (7.1). */
export const LENS_ROOT = 'horizon-thread-lens'

/** The lens key's parameters (7.1, TL-26). */
export type LensKeyParams = {
  did: string
  anchor: string
  /** The request depth: 10 linear, 6 tree (5.2). */
  depth: number
  mode: 'lens' | 'gap-only'
  /** The lens gap mark, from the route only (TL-33). */
  marked: boolean
}

/** The main lens key. */
export type LensQueryKey = readonly [typeof LENS_ROOT, LensKeyParams]

/** Build the main lens key. */
export function lensQueryKey(params: LensKeyParams): LensQueryKey {
  return [LENS_ROOT, params] as const
}

/** The lens key's parameters, when `key` is a main lens key. */
export function lensKeyParams(
  key: readonly unknown[],
): LensKeyParams | undefined {
  if (key[0] !== LENS_ROOT) return undefined
  const params = key[1]
  if (typeof params !== 'object' || params === null) return undefined
  return 'mode' in params ? (params as LensKeyParams) : undefined
}

/** The form of a lens answer that is not a stock fallback (4.3, 11.3). */
export type LensForm = 'snapshot' | 'gap-only' | 'unverified'

/**
 * Why a note shows (10, 11.3): the lens off or not served (gap-only and
 * unverified answers), a 429, or any other failure.
 */
export type LensNoteReason = 'off' | 'not-served' | '429' | 'unavailable'

/**
 * A note: its reason, the wait's end for a 429 or a `Reindexing`, and the
 * one automatic retry's state (11.3): `pending` until it fires, `spent`
 * after a second such answer in a row, `none` when there is none.
 */
export type LensNote = {
  reason: LensNoteReason
  retryAt?: number
  autoRetry: 'pending' | 'spent' | 'none'
}

/** The private continuation (5.5), held in the snapshot, never shared. */
export type PrivateCursor = {anchorUri: string; cursor: string; depth: number}

/** An immutable lens snapshot (9.1). */
export type LensSnapshot = {
  form: LensForm
  /** A fresh id per `queryFn` run. */
  runId: string
  /** The route's anchor and prism's anchor of the first response. */
  anchor: {uri: string; prismAnchor: string}
  nodes: ReadonlyMap<string, LensNode>
  markers: ReadonlyMap<string, LensMarkers>
  /** Rows the stop rule removed, as `<kind>:<uri>` (9.2). */
  stopped: ReadonlySet<string>
  /** URIs prism flagged `hiddenByThreadgate`, or-ed (7.5). */
  hidden: ReadonlySet<string>
  /** The first response's `bridging`, then each later one's (10). */
  bridging: readonly string[]
  privateCursor?: PrivateCursor
  /** A failed refetch's note on a kept snapshot (TL-35). */
  failure?: LensNote
  /** The note of a gap-only or unverified answer (11.3). */
  note?: LensNote
}

/** The tag on a stock answer stored under a lens key (TL-27). */
export type LensFallbackTag = {
  fallback: '429' | 'unavailable' | 'refused'
  retryAt?: number
  autoRetry: LensNote['autoRetry']
  /** The `sort` and rendered `below` the stock read used (TL-36). */
  readWith: {sort: string | undefined; below: number}
  runId: string
}

/** What a lens cache entry holds (7.1). */
export type LensQueryData =
  {lens: LensSnapshot} | (UsePostThreadQueryResult & {lens: LensFallbackTag})

function lensOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null
    ? (data as {lens?: unknown}).lens
    : undefined
}

/** The snapshot of any form `data` holds. */
export function snapshotOf(data: unknown): LensSnapshot | undefined {
  const lens = lensOf(data)
  return typeof lens === 'object' && lens !== null && 'form' in lens
    ? (lens as LensSnapshot)
    : undefined
}

/** The snapshot `data` holds when its form is `snapshot` (TL-35). */
export function heldSnapshotOf(data: unknown): LensSnapshot | undefined {
  const snapshot = snapshotOf(data)
  return snapshot?.form === 'snapshot' ? snapshot : undefined
}

/** The fallback tag `data` carries. */
export function fallbackOf(data: unknown): LensFallbackTag | undefined {
  const lens = lensOf(data)
  return typeof lens === 'object' && lens !== null && 'fallback' in lens
    ? (lens as LensFallbackTag)
    : undefined
}

/** The `runId` of a lens answer of any kind (7.1). */
export function runIdOf(data: unknown): string | undefined {
  return snapshotOf(data)?.runId ?? fallbackOf(data)?.runId
}

let runCounter = 0

/** A fresh `runId`. */
export function newRunId(): string {
  runCounter++
  return `lens-${runCounter}-${Date.now().toString(36)}`
}

/** The first snapshot of a run, from its first merged response. */
export function firstSnapshot({
  runId,
  anchorUri,
  prismAnchor,
  merged,
  bridging,
  privateCursor,
}: {
  runId: string
  anchorUri: string
  prismAnchor: string
  merged: MergeResult
  bridging: string
  privateCursor?: PrivateCursor
}): LensSnapshot {
  return {
    form: 'snapshot',
    runId,
    anchor: {uri: anchorUri, prismAnchor},
    nodes: merged.nodes,
    markers: merged.markers,
    stopped: new Set(),
    hidden: merged.hidden,
    bridging: [bridging],
    ...(privateCursor ? {privateCursor} : {}),
  }
}

/**
 * The next snapshot after a continuation or retry merged onto `current`
 * (9.1): the merged maps, its `bridging` recorded, `stopped` grown. The
 * private part, `failure` and `runId` are carried.
 */
export function withMerged(
  current: LensSnapshot,
  merged: MergeResult,
  bridging: string,
  stop?: string,
): LensSnapshot {
  const stopped = stop ? new Set([...current.stopped, stop]) : current.stopped
  return {
    ...current,
    nodes: merged.nodes,
    markers: merged.markers,
    hidden: merged.hidden,
    stopped,
    bridging: [...current.bridging, bridging],
  }
}

/**
 * A gap-only answer (11.3), or the unverified answer (TL-33) when `gap` is
 * undefined: one parentless gap node as the anchor, and a note. Built with
 * no request.
 */
export function gapOnlySnapshot({
  runId,
  anchorUri,
  gap,
  note,
}: {
  runId: string
  anchorUri: string
  gap: string | undefined
  note: LensNote
}): LensSnapshot {
  const node: LensNode = {
    kind: 'gap',
    uri: anchorUri,
    gap: gap ?? UNVERIFIED_GAP,
    bridging: 'full',
  }
  return {
    form: gap === undefined ? 'unverified' : 'gap-only',
    runId,
    anchor: {uri: anchorUri, prismAnchor: anchorUri},
    nodes: new Map([[anchorUri, node]]),
    markers: new Map(),
    stopped: new Set(),
    hidden: new Set(),
    bridging: [],
    note,
  }
}

/** The stop-rule key of a row (9.2). */
export function stopKey(kind: 'parents' | 'replies', uri: string): string {
  return `${kind}:${uri}`
}

/*
 * The queue store.
 */

/** How long "Still unavailable" shows under a retried gap (9.3; v9: R7-N6). */
export const STILL_UNAVAILABLE_MS = 4_000

/** A row's state, as `MarkerRow` and `GapRow` draw it (9.1). */
export type LensRowStatus =
  'idle' | 'waiting' | 'running' | 'error' | 'still-unavailable'

/**
 * What a task's answer comes to: a write onto the current snapshot (with
 * the gaps to register and the row's state after it), a failure (with the
 * wait's end for a 429), or nothing to write.
 */
export type LensTaskOutcome =
  | {
      kind: 'write'
      apply: (current: LensSnapshot) => {
        next: LensSnapshot
        gaps: readonly (readonly [string, string])[]
        row?: 'idle' | 'still-unavailable'
      }
    }
  | {kind: 'error'; retryAt?: number}
  | {kind: 'none'}

/** One continuation or retry (9.2, 9.3), for the row of `uri`. */
export type LensTask = {
  uri: string
  run: (snapshot: LensSnapshot) => Promise<LensTaskOutcome>
}

type Row = {
  status: LensRowStatus
  retryAt: number
  timer?: ReturnType<typeof setTimeout>
}

type Queue = {
  qc: QueryClient
  query: Query
  did: string
  rows: Map<string, Row>
  waiting: LensTask[]
  running: boolean
  dropped: boolean
}

const queues = new WeakMap<Query, Queue>()
/** Queues that hold a timer, a waiting task or a task in flight. */
const pendingQueues = new Set<Queue>()
const subscribedCaches = new WeakSet<QueryCache>()
const rowListeners = new Set<() => void>()
let clientsSubscribed = false
let keptDid: string | undefined

/** Called whenever a task starts, for tests (13, the task-start spy). */
let onTaskStart: ((uri: string) => void) | undefined

function notifyRows() {
  rowListeners.forEach(listener => listener())
}

function hasTimer(queue: Queue): boolean {
  for (const row of queue.rows.values()) if (row.timer) return true
  return false
}

function updatePending(queue: Queue) {
  if (
    !queue.dropped &&
    (queue.running || queue.waiting.length > 0 || hasTimer(queue))
  ) {
    pendingQueues.add(queue)
  } else {
    pendingQueues.delete(queue)
  }
}

function setRow(
  queue: Queue,
  uri: string,
  status: LensRowStatus,
  {retryAt = 0, expireAt}: {retryAt?: number; expireAt?: number} = {},
) {
  const previous = queue.rows.get(uri)
  if (previous?.timer) clearTimeout(previous.timer)
  const row: Row = {status, retryAt}
  if (expireAt !== undefined) {
    row.timer = setTimeout(
      () => {
        if (queue.rows.get(uri) !== row) return
        queue.rows.set(uri, {status: 'idle', retryAt: 0})
        updatePending(queue)
        notifyRows()
      },
      Math.max(0, expireAt - Date.now()),
    )
  }
  queue.rows.set(uri, row)
  updatePending(queue)
}

function dropQueue(queue: Queue) {
  if (queue.dropped) return
  queue.dropped = true
  for (const row of queue.rows.values()) {
    if (row.timer) clearTimeout(row.timer)
  }
  queue.rows.clear()
  queue.waiting = []
  if (queues.get(queue.query) === queue) queues.delete(queue.query)
  pendingQueues.delete(queue)
  notifyRows()
}

function subscribeCache(cache: QueryCache) {
  if (subscribedCaches.has(cache)) return
  subscribedCaches.add(cache)
  cache.subscribe(event => {
    if (event.type !== 'removed') return
    const queue = queues.get(event.query)
    if (queue) dropQueue(queue)
  })
}

function subscribeClients() {
  if (clientsSubscribed) return
  clientsSubscribed = true
  keptDid = getCurrentDid()
  subscribeCurrentClients(() => {
    /*
     * A replaced bundle for the same account clears and publishes in one
     * commit, so the DID is read once both have run. `Promise.resolve`
     * rather than `queueMicrotask`, which jest's fake timers fake (R8-N1).
     */
    void Promise.resolve().then(() => {
      const did = getCurrentDid()
      if (did === keptDid) return
      keptDid = did
      for (const queue of Array.from(pendingQueues)) {
        if (queue.did !== did) dropQueue(queue)
      }
    })
  })
}

function isServing(queue: Queue): boolean {
  return !queue.dropped && queues.get(queue.query) === queue
}

async function runNext(queue: Queue) {
  while (!queue.running && isServing(queue)) {
    const task = queue.waiting.shift()
    if (!task) break
    // A waiting task of A never starts with B's clients (R8-N2).
    if (getCurrentDid() !== queue.did) continue
    const started = heldSnapshotOf(queue.qc.getQueryData(queue.query.queryKey))
    if (!started) {
      setRow(queue, task.uri, 'idle')
      notifyRows()
      continue
    }
    queue.running = true
    setRow(queue, task.uri, 'running')
    notifyRows()
    onTaskStart?.(task.uri)
    let outcome: LensTaskOutcome
    try {
      outcome = await task.run(started)
    } catch {
      outcome = {kind: 'error'}
    }
    queue.running = false
    finish(queue, task, started.runId, outcome)
  }
  updatePending(queue)
}

function finish(
  queue: Queue,
  task: LensTask,
  runId: string,
  outcome: LensTaskOutcome,
) {
  // (d): a dropped queue, or one no longer serving its Query, writes nothing.
  if (!isServing(queue)) return
  // (c): the entry collected or rebuilt under the same hash writes nothing.
  const cache = queue.qc.getQueryCache()
  if (cache.get(queue.query.queryHash) !== queue.query) return
  const current = heldSnapshotOf(queue.qc.getQueryData(queue.query.queryKey))
  const fetching = queue.query.state.fetchStatus === 'fetching'
  // (a) and (b): a refetch started over; the answer is dropped.
  if (!current || current.runId !== runId || fetching) {
    setRow(queue, task.uri, 'idle')
    notifyRows()
    return
  }
  if (outcome.kind === 'write') {
    const {next, gaps, row} = outcome.apply(current)
    queue.qc.setQueryData(queue.query.queryKey, {lens: next})
    registerLensGaps(queue.did, gaps)
    if (row === 'still-unavailable') {
      setRow(queue, task.uri, 'still-unavailable', {
        expireAt: Date.now() + STILL_UNAVAILABLE_MS,
      })
    } else {
      setRow(queue, task.uri, 'idle')
    }
  } else if (outcome.kind === 'error') {
    setRow(queue, task.uri, 'error', {
      retryAt: outcome.retryAt ?? 0,
      ...(outcome.retryAt ? {expireAt: outcome.retryAt} : {}),
    })
  } else {
    setRow(queue, task.uri, 'idle')
  }
  notifyRows()
}

/** The `Query` of `queueId` in `qc`, if the entry exists. */
function queryOf(qc: QueryClient, queueId: string | undefined) {
  return queueId ? qc.getQueryCache().get(queueId) : undefined
}

/**
 * Queue `task` on the entry `queueId` resolves to in `qc` (a reader's tap).
 * The first tap creates the entry's queue. A row already waiting or running
 * is not queued twice. Returns whether it was queued.
 */
export function enqueueLensTask(
  qc: QueryClient,
  queueId: string | undefined,
  task: LensTask,
): boolean {
  const query = queryOf(qc, queueId)
  const params = query ? lensKeyParams(query.queryKey) : undefined
  if (!query || !params) return false
  let queue = queues.get(query)
  if (!queue) {
    subscribeCache(qc.getQueryCache())
    subscribeClients()
    queue = {
      qc,
      query,
      did: params.did,
      rows: new Map(),
      waiting: [],
      running: false,
      dropped: false,
    }
    queues.set(query, queue)
  }
  const status = queue.rows.get(task.uri)?.status
  if (status === 'waiting' || status === 'running') return false
  queue.waiting.push(task)
  setRow(queue, task.uri, 'waiting')
  notifyRows()
  void runNext(queue)
  return true
}

function rowOf(qc: QueryClient, queueId: string | undefined, uri: string) {
  const query = queryOf(qc, queueId)
  return query ? queues.get(query)?.rows.get(uri) : undefined
}

/** Called on every row change. Returns the unsubscribe function. */
export function subscribeLensRows(listener: () => void) {
  rowListeners.add(listener)
  return () => {
    rowListeners.delete(listener)
  }
}

/** A row's status, a plain read for non-render code and tests. */
export function getLensRowStatus(
  qc: QueryClient,
  queueId: string | undefined,
  uri: string,
): LensRowStatus {
  return rowOf(qc, queueId, uri)?.status ?? 'idle'
}

/**
 * A row's state for `MarkerRow` and `GapRow` (9.1): two primitive reads on
 * the queue store's `subscribe`, status and `retryAt` (0 with none). The
 * `Query` lookup runs inside each `getSnapshot` (v8: R6-N5). Reading never
 * creates a queue.
 */
export function useLensRowState(
  queueId: string | undefined,
  uri: string,
): {status: LensRowStatus; retryAt: number} {
  const qc = useQueryClient()
  const status = useSyncExternalStore(
    subscribeLensRows,
    () => rowOf(qc, queueId, uri)?.status ?? 'idle',
  )
  const retryAt = useSyncExternalStore(
    subscribeLensRows,
    () => rowOf(qc, queueId, uri)?.retryAt ?? 0,
  )
  return {status, retryAt}
}

/** Tests: the row timers the queues hold (13; v9: R7-N4). */
export function pendingLensTimerCount(): number {
  let count = 0
  for (const queue of pendingQueues) {
    for (const row of queue.rows.values()) if (row.timer) count++
  }
  return count
}

/** Tests: how many queues hold something pending. */
export function pendingLensQueueCount(): number {
  return pendingQueues.size
}

/** Tests: whether the entry `queueId` resolves to has a queue. */
export function hasLensQueue(
  qc: QueryClient,
  queueId: string | undefined,
): boolean {
  const query = queryOf(qc, queueId)
  return !!query && queues.has(query)
}

/** Tests: watch task starts. */
export function setLensTaskStartSpy(spy: ((uri: string) => void) | undefined) {
  onTaskStart = spy
}

/** Tests: drop every pending queue and forget the clients subscription's DID. */
export function resetLensQueues() {
  for (const queue of Array.from(pendingQueues)) dropQueue(queue)
  keptDid = getCurrentDid()
}
