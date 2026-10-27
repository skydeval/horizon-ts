/*
 * The `fill` batcher, its caches and schedules (refract client design 5.1 to
 * 5.4). One per account, in memory.
 *
 * - **Batching (5.1).** Asks made in the same frame are merged and deduped,
 *   and keep merging into a batch while it waits for its send slot. Every
 *   URI's author is added to `dids`. A call carries at most 25 URIs, 25 DIDs
 *   and {@link FILL_COLD_DID_CAP} DIDs not yet known restored, with at most
 *   two calls in flight (write fallbacks excepted). A foreground ask joins a
 *   background batch waiting for its slot and sends it at once. An ask
 *   whose callers have all unmounted is dropped before sending. Invalid DIDs
 *   and URIs (a handle authority included) are dropped before sending.
 * - **Answers (5.2)** are read by `answer.ts`; their effects land here: the
 *   60 s memo, "unresolved" and "not restored" for 10 min, "missing" for
 *   60 s, the "seen pending" mark, the restored-post store, the profile
 *   query. An omission that needs a second answer gets one confirming re-ask
 *   at once (foreground unless only slots wait), and its callers receive the
 *   second answer.
 * - **Skips (5.3).** A DID not yet classified is first asked of stock
 *   `getProfiles` (batched per frame, 25 a call): one stock serves is
 *   stock-served for 1 h and never sent. "Not restored" DIDs are not sent.
 * - **Schedules (5.4).** A profile, a cold thread anchor or a feed tab waits
 *   on one schedule per DID: re-asks at t0 + 2, 5 and 10 s (offsets from the
 *   first `pending` or `unavailable` answer, each at least 1 s after the
 *   previous answer), then 30 and 60 s while a caller is mounted. A loading
 *   hold ends by 5.4's end rule, at the latest at t0 + 12 s. `refractRetry`
 *   starts a new schedule and moves the old one's waits onto it, adopting a
 *   call in flight. Write fallbacks keep their own offsets (2 and 5 s inside
 *   10 s), each its own call. Feed slots, and quote slots not on screen, get
 *   no call of their own: their `pending` DIDs ride along at most twice in
 *   fills sent anyway, at least 10 s apart, then are "unresolved". An
 *   on-screen quote slot re-asks after `pending` (`askSlot`'s `now`).
 * - **Clearing (5.2).** An account switch, a `getMembership` answer that
 *   changes `features`, and `NotEnabled` clear every cache and schedule; an
 *   answer that lands after is dropped, and every waiting caller is rejected
 *   with `RefractClearedError`.
 *
 * No log line here carries a DID or a URI.
 */

import {type AtIdentifierString} from '@atproto/syntax'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {
  authorOfUri,
  type DidVerdict,
  readFillAnswer,
  type UriVerdict,
} from '#/horizon/refract/answer'
import {
  classifyRefractError,
  onRefractNotEnabled,
  type PacedSlot,
  type RefractAnswer,
  refractCall,
  RefractClearedError,
  waitForBackgroundSlot,
} from '#/horizon/refract/api'
import {refractActive, subscribeRefractGate} from '#/horizon/refract/gate'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {
  clearNotedRestored,
  dropNotedRestored,
  fromRefract,
  isNotedRestored,
  noteRestored,
} from '#/horizon/refract/marker'
import {ownBlockOf} from '#/horizon/refract/relations'
import {
  clearRestoredStore,
  dropRestoredPost,
  dropRestoredPostsBy,
  putRestoredPost,
  setStaleReader,
} from '#/horizon/refract/store'
import {
  getCurrentClients,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  getPrismFeatures,
  subscribePrismFeatures,
} from '#/horizon/routing/features'
import {app} from '#/lexicons'

type ProfileView = app.bsky.actor.defs.ProfileViewDetailed

/** Batch limits (5.1, and prism's RF-S4 reply). */
export const FILL_SPLIT = 25
/**
 * The most DIDs not yet known restored in one `fill`. It was 8 while prism
 * walked cold profiles one at a time (needs-3 reply, RF-S4). prism's
 * `53128b9` (deployed 2026-10-23, with RF-S15) walks them in parallel and
 * answers a DID it can't finish in time as `withheld` `unavailable`, so a
 * call may carry 25.
 */
export const FILL_COLD_DID_CAP = 25
export const FILL_MAX_IN_FLIGHT = 2

/** Times (5.2 to 5.4). Mutable for tests. */
export const FILL_TIMING = {
  frameMs: 16,
  memoMs: 60_000,
  negativeMs: 10 * 60_000,
  missingMs: 60_000,
  stockServedMs: 60 * 60_000,
  seenPendingMs: 10 * 60_000,
  scheduleOffsetsMs: [2_000, 5_000, 10_000, 30_000, 60_000],
  /** The loading hold's index: the answer to the 10 s re-ask ends it. */
  holdLastIndex: 2,
  holdCapMs: 12_000,
  minGapMs: 1_000,
  writeOffsetsMs: [2_000, 5_000],
  writeDeadlineMs: 10_000,
  rideAlongGapMs: 10_000,
  rideAlongMax: 2,
  /**
   * An on-screen quote slot's re-asks after a `pending` author, each from
   * the last answer (5.5 s in all, inside the 7 s background deadline).
   */
  slotPendingReaskMs: [400, 600, 1_000, 1_500, 2_000],
}

const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/
const POST_URI_RE =
  /^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._~:-]+$/

/** Whether `did` parses as a DID. */
export function isValidFillDid(did: string): boolean {
  return DID_RE.test(did)
}

/** Whether `uri` is `at://<did>/app.bsky.feed.post/<rkey>`. */
export function isValidFillUri(uri: string): boolean {
  return POST_URI_RE.test(uri)
}

/** One id's outcome for a caller: a verdict, or the call's failure. */
export type DidOutcome = DidVerdict | {kind: 'failed'; error: unknown}
export type UriOutcome = UriVerdict | {kind: 'failed'; error: unknown}

/** What a caller receives for its ids. */
export type FillOutcome = {
  dids: Map<string, DidOutcome>
  uris: Map<string, UriOutcome>
  /** The answer was a visitor answer that landed after visitor form ended. */
  lateVisitor: boolean
  /** When the answer arrived. */
  answeredAt: number
}

/** Who is asking (5.2's "keeps its callers' kind"). */
export type AskKind =
  | 'profile'
  | 'anchor'
  | 'tab'
  | 'write'
  | 'slot'
  /** A search box's exact-handle match (`search.ts`): paced like a slot. */
  | 'search'

type Waiter = {
  dids: readonly string[]
  uris: readonly string[]
  kind: AskKind
  live: () => boolean
  resolve: (outcome: FillOutcome) => void
  reject: (error: unknown) => void
}

type Batch = {
  dids: Set<string>
  uris: Set<string>
  foreground: boolean
  screen: boolean
  confirming: Set<string>
  waiters: Waiter[]
  state: 'open' | 'sending'
  timer: ReturnType<typeof setTimeout> | undefined
  slot: PacedSlot | undefined
  /** A write fallback's own call: never merged, not held by the limit. */
  own: boolean
}

type Expiring = Map<string, number>

type RideAlong = {nextAt: number; count: number; uris: Set<string>}

type Account = {
  did: string
  gen: number
  memoProfiles: Map<string, {profile: ProfileView; until: number}>
  memoPosts: Map<string, {until: number}>
  unavailableMemo: Expiring
  unresolved: Expiring
  notRestored: Expiring
  missing: Expiring
  seenPending: Expiring
  stockServed: Expiring
  /** DIDs whose stock `getProfile` failed non-transiently (classified). */
  stockFailed: Expiring
  rideAlong: Map<string, RideAlong>
  /** The newest call's `seq` that answered each id (newest-sent-wins). */
  answeredSeq: Map<string, number>
  didStates: Map<string, DidOutcome>
  uriStates: Map<string, UriOutcome>
  open: Batch[]
  inFlight: number
  sendQueue: (() => void)[]
  schedules: Map<string, Schedule>
  precheck: {
    dids: Set<string>
    timer: ReturnType<typeof setTimeout> | undefined
    waiters: (() => void)[]
  }
  seq: number
}

let account: Account | undefined
const stateListeners = new Set<() => void>()
let stateVersion = 0

function newAccount(did: string, gen: number): Account {
  return {
    did,
    gen,
    memoProfiles: new Map(),
    memoPosts: new Map(),
    unavailableMemo: new Map(),
    unresolved: new Map(),
    notRestored: new Map(),
    missing: new Map(),
    seenPending: new Map(),
    stockServed: new Map(),
    stockFailed: new Map(),
    rideAlong: new Map(),
    answeredSeq: new Map(),
    didStates: new Map(),
    uriStates: new Map(),
    open: [],
    inFlight: 0,
    sendQueue: [],
    schedules: new Map(),
    precheck: {dids: new Set(), timer: undefined, waiters: []},
    seq: 0,
  }
}

let generation = 0
let watching = false
let featuresKey: string | undefined

function notifyState() {
  stateVersion++
  stateListeners.forEach(listener => listener())
}

function watch() {
  if (watching) return
  watching = true
  subscribeCurrentClients(() => {
    if (account && account.did !== getCurrentClients()?.did) {
      clearRefractCaches('switch')
    }
  })
  subscribePrismFeatures(() => {
    const did = getCurrentClients()?.did
    if (!did) return
    const key = JSON.stringify(getPrismFeatures(did) ?? null)
    if (featuresKey !== undefined && key !== featuresKey) {
      clearRefractCaches('features')
    }
    featuresKey = key
  })
  onRefractNotEnabled(() => clearRefractCaches('not-enabled'))
  setStaleReader(uri => {
    void askSlot(uri, {foreground: false, live: () => true}).catch(() => {})
  })
}

function current(): Account {
  watch()
  const did = getCurrentClients()?.did
  if (!did) throw new RefractClearedError()
  if (!account || account.did !== did) {
    if (account) clearRefractCaches('switch')
    account = newAccount(did, generation)
    featuresKey = JSON.stringify(getPrismFeatures(did) ?? null)
  }
  return account
}

function queryClient(): QueryClient | undefined {
  return getCurrentClients()?.queryClient
}

/**
 * Clear every cache, schedule and store (5.2). Each waiting caller is
 * rejected with `RefractClearedError`.
 */
export function clearRefractCaches(
  _reason: 'switch' | 'features' | 'not-enabled' | 'test' = 'test',
) {
  generation++
  const old = account
  account = undefined
  clearNotedRestored()
  clearRestoredStore()
  if (old) {
    for (const batch of old.open) {
      if (batch.timer) clearTimeout(batch.timer)
      batch.slot?.cancel()
      batch.waiters.forEach(waiter => waiter.reject(new RefractClearedError()))
    }
    if (old.precheck.timer) clearTimeout(old.precheck.timer)
    old.precheck.waiters.forEach(waiter => waiter())
    for (const schedule of old.schedules.values()) schedule.clear()
  }
  notifyState()
}

/* ------------------------------------------------------------------------ */
/* Caches                                                                    */
/* ------------------------------------------------------------------------ */

function live(map: Expiring, id: string, now = Date.now()): boolean {
  const until = map.get(id)
  if (until === undefined) return false
  if (until <= now) {
    map.delete(id)
    return false
  }
  return true
}

/** The DID's cached classification, for skips and URI reading. */
function authorCacheOf(
  state: Account,
  did: string,
): 'not-restored' | 'stock-served' | undefined {
  if (live(state.stockServed, did)) return 'stock-served'
  if (live(state.notRestored, did)) return 'not-restored'
  return undefined
}

/** Whether a DID is classified, so it needs no stock pre-check (5.3). */
function classified(state: Account, did: string): boolean {
  return (
    isNotedRestored(did) ||
    state.memoProfiles.has(did) ||
    live(state.notRestored, did) ||
    live(state.unresolved, did) ||
    live(state.seenPending, did) ||
    live(state.stockServed, did) ||
    live(state.stockFailed, did) ||
    state.didStates.has(did)
  )
}

/**
 * A stock `getProfile` for `did` just failed with a non-transient error
 * (4.1): it is classified, so no pre-check runs.
 */
export function markStockFailed(did: string) {
  const state = current()
  state.stockFailed.set(did, Date.now() + FILL_TIMING.stockServedMs)
  state.stockServed.delete(did)
}

/** A DID seen in a stock view without the marker or stamp (5.3). */
export function noteStockServed(did: string) {
  const state = current()
  if (isNotedRestored(did)) return
  state.stockServed.set(did, Date.now() + FILL_TIMING.stockServedMs)
}

/** The last state known for a DID, or `undefined`. */
export function refractDidState(did: string): DidOutcome | undefined {
  if (!account) return undefined
  const state = account
  if (live(state.notRestored, did)) return {kind: 'not-restored'}
  if (live(state.stockServed, did)) return {kind: 'not-restored'}
  return state.didStates.get(did)
}

/** The last state known for a URI, or `undefined`. */
export function refractUriState(uri: string): UriOutcome | undefined {
  if (!account) return undefined
  const state = account
  const author = authorOfUri(uri)
  if (author && authorCacheOf(state, author)) return {kind: 'gone'}
  if (live(state.missing, uri)) return {kind: 'missing'}
  return state.uriStates.get(uri)
}

/** Whether the DID is "not restored" or stock-served right now. */
export function isDefinitelyNotRestored(did: string): boolean {
  if (!account) return false
  return !!authorCacheOf(account, did)
}

/** Whether the DID is "unresolved" right now (10 min). */
export function isUnresolved(did: string): boolean {
  return !!account && live(account.unresolved, did)
}

/** Subscribe to state changes, for `useSyncExternalStore`. */
export function subscribeRefractState(listener: () => void) {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

/** A version that changes with every applied answer and clear. */
export function refractStateVersion(): number {
  return stateVersion
}

function invalidateRestoreQueries(did: string) {
  const qc = queryClient()
  if (!qc) return
  void qc.invalidateQueries({queryKey: ['profile', did]})
  // The stock author feed queries (`post-feed`, `author|<did>|<filter>`).
  void qc.invalidateQueries({
    predicate: query =>
      query.queryKey[0] === 'post-feed' &&
      typeof query.queryKey[1] === 'string' &&
      query.queryKey[1].startsWith(`author|${did}|`),
  })
}

function writeProfileQuery(profile: ProfileView) {
  const qc = queryClient()
  if (!qc) return
  const key = ['profile', profile.did]
  const existing = qc.getQueryData(key)
  // Bluesky is the authority on its own accounts: a stock view stays.
  if (existing && !fromRefract(existing)) return
  qc.setQueryData(key, profile)
}

/** Restore ended (4.1, 5.2): drop everything held for the DID. */
function endRestore(state: Account, did: string) {
  dropNotedRestored(did)
  state.memoProfiles.delete(did)
  for (const uri of state.memoPosts.keys()) {
    if (authorOfUri(uri) === did) state.memoPosts.delete(uri)
  }
  dropRestoredPostsBy(did)
  state.notRestored.set(did, Date.now() + FILL_TIMING.negativeMs)
  state.seenPending.delete(did)
  invalidateRestoreQueries(did)
}

/** A feed tab's restore-ended error (`AccountTakedown` on `getAuthorFeed`). */
export function refractRestoreEnded(did: string) {
  const state = current()
  endRestore(state, did)
  state.didStates.set(did, {kind: 'ended'})
  notifyState()
}

function applyDid(
  state: Account,
  did: string,
  verdict: DidVerdict,
  seq: number,
) {
  const newer = (state.answeredSeq.get(did) ?? -1) > seq
  if (newer) return
  state.answeredSeq.set(did, seq)
  state.didStates.set(did, verdict)
  const now = Date.now()
  switch (verdict.kind) {
    case 'positive':
      noteRestored(did)
      state.memoProfiles.set(did, {
        profile: verdict.profile,
        until: now + FILL_TIMING.memoMs,
      })
      state.unresolved.delete(did)
      state.notRestored.delete(did)
      state.unavailableMemo.delete(did)
      state.seenPending.delete(did)
      state.rideAlong.delete(did)
      writeProfileQuery(verdict.profile)
      break
    case 'pending':
      state.seenPending.set(did, now + FILL_TIMING.seenPendingMs)
      break
    case 'unavailable':
      state.unavailableMemo.set(did, now + FILL_TIMING.memoMs)
      break
    case 'unresolved':
      state.unresolved.set(did, now + FILL_TIMING.negativeMs)
      state.rideAlong.delete(did)
      break
    case 'not-restored':
      state.notRestored.set(did, now + FILL_TIMING.negativeMs)
      state.seenPending.delete(did)
      state.memoProfiles.delete(did)
      state.rideAlong.delete(did)
      break
    case 'ended':
      endRestore(state, did)
      state.rideAlong.delete(did)
      break
    case 'confirm':
    case 'indefinite':
      break
  }
}

function applyUri(
  state: Account,
  uri: string,
  verdict: UriVerdict,
  seq: number,
  lateVisitor: boolean,
) {
  const newer = (state.answeredSeq.get(uri) ?? -1) > seq
  if (newer) return
  state.answeredSeq.set(uri, seq)
  const now = Date.now()
  switch (verdict.kind) {
    case 'positive': {
      const stored = putRestoredPost(verdict.post, {stale: lateVisitor})
      state.uriStates.set(uri, {kind: 'positive', post: stored})
      state.memoPosts.set(uri, {until: now + FILL_TIMING.memoMs})
      state.missing.delete(uri)
      state.unavailableMemo.delete(uri)
      queryClient()?.setQueryData(['post', uri], stored)
      return
    }
    case 'missing':
      state.missing.set(uri, now + FILL_TIMING.missingMs)
      dropRestoredPost(uri)
      break
    case 'unavailable':
      state.unavailableMemo.set(uri, now + FILL_TIMING.memoMs)
      break
  }
  state.uriStates.set(uri, verdict)
}

/* ------------------------------------------------------------------------ */
/* Pre-check (5.3)                                                           */
/* ------------------------------------------------------------------------ */

function runPrecheck(state: Account) {
  const dids = Array.from(state.precheck.dids)
  const waiters = state.precheck.waiters
  state.precheck = {dids: new Set(), timer: undefined, waiters: []}
  const appview = getCurrentClients()?.appviewClient
  const done = () => waiters.forEach(waiter => waiter())
  if (!appview || dids.length === 0) {
    done()
    return
  }
  const gen = state.gen
  const chunks: string[][] = []
  for (let i = 0; i < dids.length; i += FILL_SPLIT) {
    chunks.push(dids.slice(i, i + FILL_SPLIT))
  }
  void Promise.all(
    chunks.map(chunk =>
      appview
        .call(app.bsky.actor.getProfiles, {
          actors: chunk as AtIdentifierString[],
        })
        .then(res => {
          if (account !== state || state.gen !== gen) return
          const until = Date.now() + FILL_TIMING.stockServedMs
          for (const profile of res.profiles) {
            if (!fromRefract(profile)) state.stockServed.set(profile.did, until)
          }
        })
        .catch(error => {
          logger.info('refract: stock pre-check failed', {safeMessage: error})
        }),
    ),
  ).then(done)
}

/** Ask stock about unclassified DIDs before their first fill (5.3). */
function precheck(state: Account, dids: string[]): Promise<void> {
  const unclassified = dids.filter(did => !classified(state, did))
  if (unclassified.length === 0) return Promise.resolve()
  return new Promise(resolve => {
    unclassified.forEach(did => state.precheck.dids.add(did))
    state.precheck.waiters.push(resolve)
    if (!state.precheck.timer) {
      state.precheck.timer = setTimeout(
        () => runPrecheck(state),
        FILL_TIMING.frameMs,
      )
    }
  })
}

/* ------------------------------------------------------------------------ */
/* Batches (5.1)                                                             */
/* ------------------------------------------------------------------------ */

function emptyOutcome(): FillOutcome {
  return {
    dids: new Map(),
    uris: new Map(),
    lateVisitor: false,
    answeredAt: Date.now(),
  }
}

function openBatch(
  state: Account,
  {
    foreground,
    screen,
    own,
  }: {foreground: boolean; screen: boolean; own: boolean},
): Batch {
  if (!own) {
    const joinable = state.open.find(
      batch => batch.state === 'open' && !batch.own,
    )
    if (joinable) {
      if (foreground && !joinable.foreground) {
        // A foreground ask joins a waiting background batch and sends it now.
        joinable.foreground = true
        joinable.slot?.promote()
      }
      joinable.screen = joinable.screen || screen
      return joinable
    }
  }
  const batch: Batch = {
    dids: new Set(),
    uris: new Set(),
    foreground,
    screen,
    confirming: new Set(),
    waiters: [],
    state: 'open',
    timer: undefined,
    slot: undefined,
    own,
  }
  state.open.push(batch)
  // Asks in the same frame merge; a background batch then waits for its slot.
  batch.timer = setTimeout(() => {
    batch.timer = undefined
    if (batch.foreground) {
      seal(state, batch)
    } else {
      batch.slot = waitForBackgroundSlot(() => seal(state, batch), {
        screen: batch.screen,
      })
    }
  }, FILL_TIMING.frameMs)
  return batch
}

/** Ride-along DIDs due now join any fill that is sent anyway (5.4). */
function addRideAlongs(state: Account, batch: Batch) {
  const now = Date.now()
  for (const [did, ride] of state.rideAlong) {
    if (ride.nextAt > now) continue
    if (batch.dids.has(did)) continue
    batch.dids.add(did)
    ride.uris.forEach(uri => batch.uris.add(uri))
    ride.count += 1
    ride.nextAt = now + FILL_TIMING.rideAlongGapMs
  }
}

type Chunk = {dids: string[]; uris: string[]}

/** Split a batch's ids into calls within the limits (5.1, RF-S4). */
export function splitFill(
  dids: readonly string[],
  uris: readonly string[],
  isCold: (did: string) => boolean,
): Chunk[] {
  const chunks: Chunk[] = []
  const byAuthor = new Map<string, string[]>()
  for (const uri of uris) {
    const author = authorOfUri(uri) ?? ''
    const list = byAuthor.get(author) ?? []
    list.push(uri)
    byAuthor.set(author, list)
  }
  let chunk: Chunk = {dids: [], uris: []}
  let cold = 0
  const push = () => {
    if (chunk.dids.length || chunk.uris.length) chunks.push(chunk)
    chunk = {dids: [], uris: []}
    cold = 0
  }
  for (const did of dids) {
    const own = byAuthor.get(did) ?? []
    const coldDid = isCold(did)
    if (
      chunk.dids.length + 1 > FILL_SPLIT ||
      chunk.uris.length + Math.min(own.length, FILL_SPLIT) > FILL_SPLIT ||
      (coldDid && cold + 1 > FILL_COLD_DID_CAP)
    ) {
      push()
    }
    chunk.dids.push(did)
    if (coldDid) cold++
    for (const uri of own) {
      if (chunk.uris.length >= FILL_SPLIT) {
        // One author with more than 25 URIs: the rest go with it again.
        push()
        chunk.dids.push(did)
        if (coldDid) cold++
      }
      chunk.uris.push(uri)
    }
  }
  push()
  return chunks
}

function acquire(state: Account, own: boolean): Promise<void> {
  if (own) return Promise.resolve()
  if (state.inFlight < FILL_MAX_IN_FLIGHT) {
    state.inFlight++
    return Promise.resolve()
  }
  return new Promise(resolve => {
    state.sendQueue.push(() => {
      state.inFlight++
      resolve()
    })
  })
}

function release(state: Account, own: boolean) {
  if (own) return
  state.inFlight--
  const next = state.sendQueue.shift()
  if (next) next()
}

type CallResult = {
  dids: Map<string, DidOutcome>
  uris: Map<string, UriOutcome>
  lateVisitor: boolean
}

async function sendChunk(
  state: Account,
  chunk: Chunk,
  {
    foreground,
    screen,
    own,
    confirming,
  }: {
    foreground: boolean
    screen: boolean
    own: boolean
    confirming: Set<string>
  },
): Promise<CallResult> {
  const result: CallResult = {
    dids: new Map(),
    uris: new Map(),
    lateVisitor: false,
  }
  const seq = ++state.seq
  const gen = state.gen
  const queuedAt = Date.now()
  await acquire(state, own)
  const sentAt = Date.now()
  let answer: RefractAnswer<unknown>
  try {
    answer = await refractCall<unknown>(
      REFRACT_METHODS.fill,
      {dids: chunk.dids, uris: chunk.uris},
      {foreground, screen, paced: true},
    )
  } catch (error) {
    if (classifyRefractError(error) === 'cleared') throw error
    if (account !== state || state.gen !== gen) throw new RefractClearedError()
    chunk.dids.forEach(did => result.dids.set(did, {kind: 'failed', error}))
    chunk.uris.forEach(uri => result.uris.set(uri, {kind: 'failed', error}))
    return result
  } finally {
    release(state, own)
    logSlowFill(sentAt - queuedAt, Date.now() - sentAt)
  }
  if (account !== state || state.gen !== gen) throw new RefractClearedError()
  const read = readFillAnswer(answer.body, chunk, {
    form: answer.form,
    proxied: answer.proxied,
    noted: isNotedRestored,
    seenPending: did => live(state.seenPending, did),
    confirming,
    authorCache: did => authorCacheOf(state, did),
    ownBlock: did => !!ownBlockOf(did),
  })
  for (const [did, verdict] of read.dids) {
    applyDid(state, did, verdict, seq)
    result.dids.set(did, verdict)
  }
  for (const [uri, verdict] of read.uris) {
    applyUri(state, uri, verdict, seq, answer.lateVisitor)
    result.uris.set(uri, verdict)
  }
  result.lateVisitor = answer.lateVisitor
  return result
}

/** A fill slower than this in all gets a timing line in the console. */
const SLOW_FILL_MS = 1_000

/*
 * The timing line (2026-10-27), like Thread Lens's: how long a fill waited
 * for one of the two in-flight places, and how long the call took (the
 * token mint included). In the console in production builds too, so a slow
 * quote card can be read without a debugger. No DID or URI.
 */
function logSlowFill(waitedMs: number, callMs: number) {
  if (waitedMs + callMs < SLOW_FILL_MS) return
  globalThis.console.info(
    `refract fill: waited ${waitedMs} ms for a place, call took ${callMs} ms`,
  )
}

/** One sealed set of ids: send its chunks, then the confirming re-asks. */
async function sendIds(
  state: Account,
  dids: string[],
  uris: string[],
  options: {
    foreground: boolean
    screen: boolean
    own: boolean
    confirming: Set<string>
    kindsFor: (did: string) => AskKind[]
  },
): Promise<CallResult> {
  const chunks = splitFill(dids, uris, did => !isNotedRestored(did))
  const results = await Promise.all(
    chunks.map(chunk => sendChunk(state, chunk, options)),
  )
  const merged: CallResult = {
    dids: new Map(),
    uris: new Map(),
    lateVisitor: results.some(result => result.lateVisitor),
  }
  for (const result of results) {
    result.dids.forEach((value, key) => merged.dids.set(key, value))
    result.uris.forEach((value, key) => merged.uris.set(key, value))
  }
  // One confirming re-ask for omissions that need a second answer (5.2).
  const toConfirm = Array.from(merged.dids)
    .filter(([, verdict]) => verdict.kind === 'confirm')
    .map(([did]) => did)
  if (toConfirm.length > 0) {
    const confirmUris = uris.filter(uri => {
      const author = authorOfUri(uri)
      return !!author && toConfirm.includes(author)
    })
    const slotsOnly = toConfirm.every(did =>
      options.kindsFor(did).every(kind => kind === 'slot' || kind === 'search'),
    )
    const confirmed = await sendIds(state, toConfirm, confirmUris, {
      ...options,
      foreground: !slotsOnly,
      screen: slotsOnly,
      confirming: new Set(toConfirm),
    })
    confirmed.dids.forEach((value, key) => merged.dids.set(key, value))
    confirmed.uris.forEach((value, key) => merged.uris.set(key, value))
    merged.lateVisitor = merged.lateVisitor || confirmed.lateVisitor
  }
  return merged
}

function seal(state: Account, batch: Batch) {
  if (batch.state !== 'open') return
  batch.state = 'sending'
  if (batch.timer) clearTimeout(batch.timer)
  state.open = state.open.filter(other => other !== batch)
  if (account !== state) return
  addRideAlongs(state, batch)
  // Drop ids no live caller wants (ride-alongs are kept).
  const wanted = new Set<string>()
  for (const waiter of batch.waiters) {
    if (!waiter.live()) continue
    waiter.dids.forEach(did => wanted.add(did))
    waiter.uris.forEach(uri => wanted.add(uri))
  }
  const ride = (did: string) => state.rideAlong.has(did)
  const uris = Array.from(batch.uris).filter(
    uri => wanted.has(uri) || ride(authorOfUri(uri) ?? ''),
  )
  const authors = new Set(
    uris.map(uri => authorOfUri(uri)).filter((did): did is string => !!did),
  )
  const dids = Array.from(batch.dids).filter(
    did => wanted.has(did) || authors.has(did) || ride(did),
  )
  const waiters = batch.waiters
  if (dids.length === 0 && uris.length === 0) {
    waiters.forEach(waiter => waiter.resolve(emptyOutcome()))
    return
  }
  const kindsFor = (did: string) =>
    waiters
      .filter(
        waiter =>
          waiter.dids.includes(did) ||
          waiter.uris.some(uri => authorOfUri(uri) === did),
      )
      .map(waiter => waiter.kind)
  sendIds(state, dids, uris, {
    foreground: batch.foreground,
    screen: batch.screen,
    own: batch.own,
    confirming: batch.confirming,
    kindsFor,
  }).then(
    result => {
      // Ride-alongs that stayed pending past their last ride are unresolved.
      for (const [did, outcome] of result.dids) {
        const rideState = state.rideAlong.get(did)
        if (!rideState) continue
        if (outcome.kind !== 'pending') {
          state.rideAlong.delete(did)
        } else if (rideState.count >= FILL_TIMING.rideAlongMax) {
          state.rideAlong.delete(did)
          applyDid(state, did, {kind: 'unresolved'}, ++state.seq)
          result.dids.set(did, {kind: 'unresolved'})
        }
      }
      notifyState()
      const answeredAt = Date.now()
      for (const waiter of waiters) {
        const outcome: FillOutcome = {
          dids: new Map(),
          uris: new Map(),
          lateVisitor: result.lateVisitor,
          answeredAt,
        }
        for (const did of waiter.dids) {
          const value = result.dids.get(did)
          if (value) outcome.dids.set(did, value)
        }
        for (const uri of waiter.uris) {
          const value = result.uris.get(uri)
          if (value) outcome.uris.set(uri, value)
        }
        waiter.resolve(outcome)
      }
    },
    error => waiters.forEach(waiter => waiter.reject(error)),
  )
}

/** One ask's options. */
export type AskOptions = {
  kind: AskKind
  foreground: boolean
  /** A background ask for the open screen. */
  screen?: boolean
  /** Whether the caller is still mounted; an unmounted ask is dropped. */
  live?: () => boolean
  /** A write fallback's own call (5.4). */
  own?: boolean
  /** Skip the stock pre-check (the DID was classified by the caller). */
  skipPrecheck?: boolean
}

/**
 * Ask `fill` about DIDs and URIs (5.1). Invalid ids are dropped; every URI's
 * author is asked too; stock-served and "not restored" DIDs are not sent.
 * Resolves with the outcome of each asked id that was sent.
 */
export async function askFill(
  ids: {dids?: readonly string[]; uris?: readonly string[]},
  options: AskOptions,
): Promise<FillOutcome> {
  const state = current()
  const gen = state.gen
  const uris = Array.from(new Set(ids.uris ?? [])).filter(isValidFillUri)
  const dids = Array.from(
    new Set([
      ...(ids.dids ?? []).filter(isValidFillDid),
      ...uris.map(uri => authorOfUri(uri)!),
    ]),
  )
  if (!options.skipPrecheck) await precheck(state, dids)
  if (account !== state || state.gen !== gen) throw new RefractClearedError()
  const skipped = (did: string) => !!authorCacheOf(state, did)
  const sendDids = dids.filter(did => !skipped(did))
  const sendUris = uris.filter(uri => !skipped(authorOfUri(uri)!))
  const outcome = emptyOutcome()
  dids
    .filter(skipped)
    .forEach(did => outcome.dids.set(did, {kind: 'not-restored'}))
  uris
    .filter(uri => skipped(authorOfUri(uri)!))
    .forEach(uri => outcome.uris.set(uri, {kind: 'gone'}))
  if (sendDids.length === 0) return outcome

  const sent = await new Promise<FillOutcome>((resolve, reject) => {
    const batch = openBatch(state, {
      foreground: options.foreground,
      screen: !!options.screen,
      own: !!options.own,
    })
    sendDids.forEach(did => batch.dids.add(did))
    sendUris.forEach(uri => batch.uris.add(uri))
    batch.waiters.push({
      dids: sendDids,
      uris: sendUris,
      kind: options.kind,
      live: options.live ?? (() => true),
      resolve,
      reject,
    })
    if (options.own) seal(state, batch)
  })
  sent.dids.forEach((value, key) => outcome.dids.set(key, value))
  sent.uris.forEach((value, key) => outcome.uris.set(key, value))
  outcome.lateVisitor = sent.lateVisitor
  outcome.answeredAt = sent.answeredAt
  return outcome
}

/* ------------------------------------------------------------------------ */
/* Schedules (5.4)                                                           */
/* ------------------------------------------------------------------------ */

/** Why a hold ended without a profile (4.1's `ProfileUnavailableError`). */
export type HoldReason = 'transient' | 'pending' | 'unconfirmed'

/** How a schedule wait ends. */
export type ScheduleResult =
  | {kind: 'positive'; profile: ProfileView; lateVisitor: boolean}
  | {kind: 'definitive'; verdict: 'not-restored' | 'ended'}
  | {kind: 'unavailable'; reason: HoldReason; error?: unknown}

/** A mounted surface that wants the answers after its hold ended. */
export type LateListener = {
  live: () => boolean
  onAnswer: (verdict: DidVerdict, outcome: FillOutcome) => void
}

type Wait = {
  hold: boolean
  kind: AskKind
  uris: Set<string>
  live: () => boolean
  resolve: (result: ScheduleResult) => void
  reject: (error: unknown) => void
  settled: boolean
}

class Schedule {
  readonly did: string
  readonly state: Account
  t0: number | undefined
  nextIndex = 0
  lastAnswerAt = 0
  lastReason: HoldReason = 'pending'
  unavailableCount = 0
  holdOpen = true
  ended = false
  inFlight: Promise<FillOutcome> | undefined
  inFlightIndex = -1
  timer: ReturnType<typeof setTimeout> | undefined
  capTimer: ReturnType<typeof setTimeout> | undefined
  waits = new Set<Wait>()
  lates = new Set<LateListener>()
  uris = new Set<string>()

  constructor(state: Account, did: string) {
    this.state = state
    this.did = did
  }

  anyLive(): boolean {
    for (const wait of this.waits) if (!wait.settled && wait.live()) return true
    for (const late of this.lates) if (late.live()) return true
    return false
  }

  settle(wait: Wait, result: ScheduleResult) {
    if (wait.settled) return
    wait.settled = true
    this.waits.delete(wait)
    wait.resolve(result)
  }

  settleAll(result: ScheduleResult, onlyHold?: boolean) {
    for (const wait of Array.from(this.waits)) {
      if (onlyHold === undefined || wait.hold === onlyHold) {
        this.settle(wait, result)
      }
    }
  }

  endHold(reason: HoldReason, error?: unknown) {
    if (!this.holdOpen) return
    this.holdOpen = false
    if (this.capTimer) clearTimeout(this.capTimer)
    this.settleAll({kind: 'unavailable', reason, error}, true)
  }

  end() {
    this.ended = true
    if (this.timer) clearTimeout(this.timer)
    if (this.capTimer) clearTimeout(this.capTimer)
    if (this.state.schedules.get(this.did) === this) {
      this.state.schedules.delete(this.did)
    }
    // Waits still open take the last state, never hang.
    this.settleAll({kind: 'unavailable', reason: this.lastReason})
  }

  clear() {
    this.ended = true
    if (this.timer) clearTimeout(this.timer)
    if (this.capTimer) clearTimeout(this.capTimer)
    for (const wait of Array.from(this.waits)) {
      wait.settled = true
      wait.reject(new RefractClearedError())
    }
    this.waits.clear()
    this.lates.clear()
  }

  call(index: number): Promise<FillOutcome> {
    const live = () => this.anyLive()
    const promise = askFill(
      {dids: [this.did], uris: Array.from(this.uris)},
      {kind: 'profile', foreground: true, skipPrecheck: index > -1, live},
    )
    this.inFlight = promise
    this.inFlightIndex = index
    promise.then(
      outcome => this.onAnswer(promise, index, outcome),
      error => this.onFailure(promise, error),
    )
    return promise
  }

  onFailure(promise: Promise<FillOutcome>, error: unknown) {
    if (this.inFlight === promise) this.inFlight = undefined
    if (this.ended) return
    if (classifyRefractError(error) === 'cleared') {
      this.clear()
      return
    }
    this.onAnswer(promise, this.inFlightIndex, {
      dids: new Map([[this.did, {kind: 'failed', error}]]),
      uris: new Map(),
      lateVisitor: false,
      answeredAt: Date.now(),
    })
  }

  onAnswer(promise: Promise<FillOutcome>, index: number, outcome: FillOutcome) {
    if (this.inFlight === promise) this.inFlight = undefined
    const verdict = outcome.dids.get(this.did)
    if (this.ended) {
      // A call that outlived its schedule (after the cap or a Retry that did
      // not adopt it): its answer still reaches mounted surfaces.
      if (verdict && verdict.kind !== 'failed') {
        for (const late of this.lates)
          if (late.live()) late.onAnswer(verdict, outcome)
      }
      return
    }
    this.lastAnswerAt = Date.now()
    if (!verdict) {
      // The ask was dropped (no caller live): nothing was learnt.
      this.end()
      return
    }
    if (verdict.kind !== 'failed') {
      for (const late of this.lates)
        if (late.live()) late.onAnswer(verdict, outcome)
    }
    switch (verdict.kind) {
      case 'positive':
        this.settleAll({
          kind: 'positive',
          profile: verdict.profile,
          lateVisitor: outcome.lateVisitor,
        })
        this.end()
        return
      case 'not-restored':
      case 'ended':
        this.settleAll({kind: 'definitive', verdict: verdict.kind})
        this.end()
        return
      case 'unresolved':
      case 'indefinite':
      case 'confirm':
        this.lastReason = 'unconfirmed'
        this.settleAll({kind: 'unavailable', reason: 'unconfirmed'})
        this.end()
        return
      case 'failed':
        if (this.t0 === undefined) {
          this.settleAll({
            kind: 'unavailable',
            reason: 'transient',
            error: verdict.error,
          })
          this.end()
          return
        }
        this.endHold('transient', verdict.error)
        this.settleAll(
          {kind: 'unavailable', reason: 'transient', error: verdict.error},
          false,
        )
        this.scheduleNext()
        return
      case 'pending':
      case 'unavailable': {
        if (this.t0 === undefined) {
          this.t0 = this.lastAnswerAt
          this.capTimer = setTimeout(() => {
            if (!this.ended) this.endHold(this.lastReason)
          }, FILL_TIMING.holdCapMs)
        }
        if (verdict.kind === 'unavailable') this.unavailableCount++
        const reason: HoldReason =
          verdict.kind === 'unavailable' ? 'unconfirmed' : 'pending'
        this.lastReason = reason
        this.settleAll({kind: 'unavailable', reason}, false)
        if (this.holdOpen) {
          if (this.unavailableCount >= 2) this.endHold('unconfirmed')
          else if (index >= FILL_TIMING.holdLastIndex) this.endHold(reason)
        }
        this.scheduleNext()
        return
      }
    }
  }

  scheduleNext() {
    const offsets = FILL_TIMING.scheduleOffsetsMs
    if (this.nextIndex >= offsets.length || this.t0 === undefined) {
      this.end()
      return
    }
    const index = this.nextIndex
    const at = Math.max(
      this.t0 + offsets[index],
      this.lastAnswerAt + FILL_TIMING.minGapMs,
    )
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        if (this.ended) return
        if (!this.anyLive()) {
          this.end()
          return
        }
        this.nextIndex = index + 1
        void this.call(index).catch(() => {})
      },
      Math.max(0, at - Date.now()),
    )
  }

  /** Begin: the first call, or adopt one already in flight (Retry). */
  start(adopt?: Promise<FillOutcome>) {
    if (adopt) {
      this.inFlight = adopt
      this.inFlightIndex = -1
      adopt.then(
        outcome => this.onAnswer(adopt, -1, outcome),
        error => this.onFailure(adopt, error),
      )
      return
    }
    void this.call(-1).catch(() => {})
  }
}

/**
 * Wait on the DID's schedule (5.4): join the running one, or start one. A
 * wait made while the schedule is inside its hold (or before its first
 * answer) resolves by the hold's end rule; one that joins after the hold
 * ended resolves at the next answer. `late` gets every later answer while
 * it is live.
 */
export function waitOnSchedule(
  did: string,
  {
    kind,
    uris = [],
    hold = true,
    live = () => true,
    late,
  }: {
    kind: AskKind
    uris?: readonly string[]
    hold?: boolean
    live?: () => boolean
    late?: LateListener
  },
): Promise<ScheduleResult> {
  const state = current()
  let schedule = state.schedules.get(did)
  const fresh = !schedule || schedule.ended
  if (fresh) {
    schedule = new Schedule(state, did)
    state.schedules.set(did, schedule)
  }
  const running = schedule!
  uris.filter(isValidFillUri).forEach(uri => running.uris.add(uri))
  if (late) running.lates.add(late)
  const promise = new Promise<ScheduleResult>((resolve, reject) => {
    running.waits.add({
      hold: hold && running.holdOpen,
      kind,
      uris: new Set(uris),
      live,
      resolve,
      reject,
      settled: false,
    })
  })
  if (fresh) running.start()
  return promise
}

/** Whether the DID has a schedule running. */
export function hasRunningSchedule(did: string): boolean {
  const schedule = account?.schedules.get(did)
  return !!schedule && !schedule.ended
}

/**
 * Try again (4.1, 4.2, 5.4 "Shared callers"): end the DID's schedule and
 * start a new one. Every wait still on the old one moves to the new one and
 * holds by its end rule. A call of the old schedule in flight becomes the new
 * schedule's first call (no second call is sent); otherwise one is sent now.
 */
export function refractRetry(did: string, uris: readonly string[] = []) {
  if (!refractActive()) return
  const state = current()
  const old = state.schedules.get(did)
  const next = new Schedule(state, did)
  state.schedules.set(did, next)
  uris.filter(isValidFillUri).forEach(uri => next.uris.add(uri))
  let adopt: Promise<FillOutcome> | undefined
  if (old && !old.ended) {
    old.uris.forEach(uri => next.uris.add(uri))
    for (const wait of old.waits) {
      if (wait.settled) continue
      wait.hold = true
      next.waits.add(wait)
    }
    old.waits.clear()
    old.lates.forEach(late => next.lates.add(late))
    adopt = old.inFlight
    old.ended = true
    if (old.timer) clearTimeout(old.timer)
    if (old.capTimer) clearTimeout(old.capTimer)
  }
  next.start(adopt)
}

/* ------------------------------------------------------------------------ */
/* Write fallbacks (5.4, 9.3)                                                */
/* ------------------------------------------------------------------------ */

/** How a write fallback's asks end. */
export type WriteResult =
  | {kind: 'positive'; post: app.bsky.feed.defs.PostView}
  | {kind: 'blocked'}
  | {kind: 'deleted'}
  /** Prism answered, but not definitively: "can't be replied to right now". */
  | {kind: 'not-now'}
  /** The call failed or ran out of time: the server-issues text. */
  | {kind: 'failed'; error: unknown}

function sleepUntil(at: number) {
  return new Promise<void>(resolve =>
    setTimeout(resolve, Math.max(0, at - Date.now())),
  )
}

/**
 * Resolve a post for a write (the reply parent, a pasted quote link): its
 * own calls, foreground and unpaced, with re-asks at 2 and 5 s from its own
 * first answer, inside {@link FILL_TIMING.writeDeadlineMs}. A re-ask that
 * can't start at least 1 s before the deadline is skipped.
 */
export async function resolveForWrite(uri: string): Promise<WriteResult> {
  const started = Date.now()
  const deadline = started + FILL_TIMING.writeDeadlineMs
  let t0: number | undefined
  let offset = 0
  let unavailableSeen = false
  for (;;) {
    let outcome: FillOutcome
    try {
      outcome = await withDeadline(
        askFill({uris: [uri]}, {kind: 'write', foreground: true, own: true}),
        deadline,
      )
    } catch (error) {
      if (classifyRefractError(error) === 'cleared' && refractActive()) {
        if (Date.now() < deadline - FILL_TIMING.minGapMs) continue
      }
      return {kind: 'failed', error}
    }
    const verdict = outcome.uris.get(uri)
    if (t0 === undefined) t0 = outcome.answeredAt
    if (!verdict) return {kind: 'deleted'}
    let again = false
    switch (verdict.kind) {
      case 'positive':
        return {kind: 'positive', post: verdict.post}
      case 'blocked':
        return {kind: 'blocked'}
      case 'gone':
      case 'missing':
        return {kind: 'deleted'}
      case 'failed':
        return {kind: 'failed', error: verdict.error}
      case 'unresolved':
        return {kind: 'not-now'}
      case 'unavailable':
        if (unavailableSeen) return {kind: 'not-now'}
        unavailableSeen = true
        again = true
        break
      case 'author':
        if (verdict.author === 'pending') again = true
        else if (verdict.author === 'unavailable' && !unavailableSeen) {
          unavailableSeen = true
          again = true
        } else return {kind: 'not-now'}
        break
    }
    if (!again) return {kind: 'not-now'}
    const offsets = FILL_TIMING.writeOffsetsMs
    if (offset >= offsets.length) return {kind: 'not-now'}
    const at = t0 + offsets[offset]
    offset++
    if (at > deadline - FILL_TIMING.minGapMs) return {kind: 'not-now'}
    await sleepUntil(at)
  }
}

class WriteDeadlineError extends Error {
  constructor() {
    super('Refract write deadline')
    this.name = 'RefractDeadlineError'
  }
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new WriteDeadlineError()),
      Math.max(0, deadline - Date.now()),
    )
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/* ------------------------------------------------------------------------ */
/* Slots (4.4, 5.4)                                                          */
/* ------------------------------------------------------------------------ */

/**
 * A quote slot's ask (4.4). A background ask is answered from the memo
 * (positive, or `unavailable` for 60 s) and the negative caches without a
 * call; Try again (`foreground`) skips the memo. `now` (a card on screen,
 * prism's agreement 2026-10-27) sends the call within the frame, merged with
 * the frame's other asks, instead of waiting for a background slot: the
 * queue held a deleted author's quote on "Loading" for 2-3 s while `fill`
 * itself answers in about 5 ms. `now` also skips the stock pre-check (5.3):
 * the card would otherwise wait on a `getProfiles` through the reader's
 * AppView, batched with every unclassified DID on screen, before its fill;
 * a stock-served author just comes back not restored. With `now`, a
 * `pending` author (prism
 * still resolving it, usually done in well under a second) is asked again
 * at {@link FILL_TIMING.slotPendingReaskMs} until the answer is final, the
 * card unmounts, or the offsets run out; without it, a `pending` author
 * only rides along in later fills (5.4). Resolves with the URI's last
 * outcome.
 */
export async function askSlot(
  uri: string,
  options: {foreground: boolean; now?: boolean; live: () => boolean},
): Promise<UriOutcome | undefined> {
  let verdict = await askSlotOnce(uri, options)
  if (!options.now) return verdict
  for (const delay of FILL_TIMING.slotPendingReaskMs) {
    if (!isPendingOutcome(verdict) || !options.live()) return verdict
    await new Promise(resolve => setTimeout(resolve, delay))
    if (!options.live()) return verdict
    verdict = await askSlotOnce(uri, {...options, foreground: false})
  }
  return verdict
}

function isPendingOutcome(outcome: UriOutcome | undefined): boolean {
  return outcome?.kind === 'author' && outcome.author === 'pending'
}

/** One slot ask: the caches, else one fill call. */
async function askSlotOnce(
  uri: string,
  {
    foreground,
    now = false,
    live: mounted,
  }: {foreground: boolean; now?: boolean; live: () => boolean},
): Promise<UriOutcome | undefined> {
  if (!isValidFillUri(uri)) return undefined
  const state = current()
  const author = authorOfUri(uri)!
  if (authorCacheOf(state, author)) return {kind: 'gone'}
  if (live(state.missing, uri)) return {kind: 'missing'}
  if (!foreground) {
    const cached = state.uriStates.get(uri)
    if (
      cached?.kind === 'positive' &&
      (state.memoPosts.get(uri)?.until ?? 0) > Date.now()
    ) {
      return cached
    }
    if (
      live(state.unavailableMemo, uri) ||
      live(state.unavailableMemo, author)
    ) {
      return {kind: 'unavailable'}
    }
    if (live(state.unresolved, author)) return {kind: 'unresolved'}
  }
  const outcome = await askFill(
    {uris: [uri]},
    {
      kind: 'slot',
      foreground: foreground || now,
      // An on-screen card never waits on stock's getProfiles (5.3) first.
      skipPrecheck: now,
      live: mounted,
      screen: true,
    },
  )
  const verdict = outcome.uris.get(uri)
  if (
    verdict?.kind === 'author' &&
    verdict.author === 'pending' &&
    account === state
  ) {
    const ride = state.rideAlong.get(author) ?? {
      nextAt: Date.now() + FILL_TIMING.rideAlongGapMs,
      count: 0,
      uris: new Set<string>(),
    }
    ride.uris.add(uri)
    state.rideAlong.set(author, ride)
  }
  return verdict
}

/** Test-only: forget everything. */
export function resetRefractFill() {
  clearRefractCaches('test')
  featuresKey = undefined
}

/** Test-only: the in-flight count and open batches. */
export function fillDebugState() {
  return {
    inFlight: account?.inFlight ?? 0,
    open: account?.open.length ?? 0,
    schedules: account?.schedules.size ?? 0,
  }
}

// Visitor form ending (9.2): refresh the views that hold visitor stamps.
let lastVisitor: boolean | undefined
let visitorWatch = false

/** Start watching for visitor form ending (once). */
export function watchVisitorForm(isVisitor: () => boolean, onEnd: () => void) {
  if (visitorWatch) return
  visitorWatch = true
  lastVisitor = isVisitor()
  subscribeRefractGate(() => {
    const now = isVisitor()
    if (lastVisitor && !now) {
      if (account) account.memoProfiles.clear()
      if (account) account.memoPosts.clear()
      onEnd()
    }
    lastVisitor = now
  })
}
