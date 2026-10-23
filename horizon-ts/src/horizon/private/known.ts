/*
 * The suspect registry (prism busy design 4): one per account, in memory,
 * cleared on an account change. Every surface asks it what a post prism left
 * out means; no surface has its own rule.
 *
 * - A miss of the reader's own post is `suspect` until the PDS's
 *   `RecordNotFound` makes it `real`, the only way any miss becomes `real`.
 * - A miss of another author's post is never `real` (BR-5): `suspect` when
 *   prism said "can't tell now" for it (`signalled`), else `unknown`.
 * - A serve ends a suspect. `served` records when each URI was last served
 *   (the arrival of the 2xx), which the load gate (4.1) and the "Syncing"
 *   label read; it fills nothing.
 *
 * It also holds the load gate's per-URI floors (`gatedAt`, 4.1), the quotes'
 * `answered` verdicts (6.3) and the held queries the catch-up refetches (2.4).
 *
 * Answers are ordered by the `seq` taken when they were sent (design 2), so
 * an older answer's serve never ends a newer withholding, and an older miss
 * never undoes a newer serve.
 */

import {useSyncExternalStore} from 'react'
import {jsonToLex, type JsonValue, XrpcResponseError} from '@atproto/lex'
import {AtUri, type DidString} from '@atproto/syntax'
import {type QueryClient, type QueryKey} from '@tanstack/react-query'

import {logger} from '#/logger'
import {type AnswerContext} from '#/horizon/private/api/reads'
import {
  CONFIRM_AT_MS,
  getPendingPost,
  PENDING_TTL_MS,
  pendingPhase,
  subscribePrivateStores,
} from '#/horizon/private/store'
import {isPrivatePostUri, PP_COLLECTION} from '#/horizon/private/uri'
import {
  getCurrentClients,
  getCurrentDid,
  subscribeCurrentClients,
  useCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  getPrismHealth,
  healthEnvironment,
  isPrismConfirmed,
  subscribePrismHealth,
} from '#/horizon/routing/health'
import {type app, com} from '#/lexicons'

export type MissVerdict = 'unknown' | 'suspect' | 'real'

export type MissOptions = {
  /** prism said "can't tell now" for this URI. */
  signalled?: boolean
  /** A floor for the suspect clock (prism's hint). */
  retryAfterMs?: number
  /** An own URI prism listed as transient: no PDS check. */
  skipPdsCheck?: boolean
}

/** How many URIs `served`, `answered` and `gatedAt` keep, oldest dropped. */
export const REGISTRY_CAP = 5_000

/** The suspect clock's steps (4): about 2 minutes over five tries. */
export const SUSPECT_STEPS_MS = [4_000, 8_000, 16_000, 32_000, 60_000]

/** A held query's refetch interval stops after this many tries (4). */
export const SUSPECT_MAX_TRIES = SUSPECT_STEPS_MS.length

/**
 * A written pending post prism has not served this long after the write is
 * labelled "Syncing": the last background confirmation (6.6).
 */
export const SYNCING_AFTER_MS = CONFIRM_AT_MS[CONFIRM_AT_MS.length - 1]

type Suspect = {
  own: boolean
  since: number
  tries: number
  nextAt: number
  /** The `seq` of the latest answer that missed it. */
  missSeq: number
}

/** A query whose value is kept or stands in for a suspect (4, "Holds"). */
export type Hold = {queryKey: QueryKey; uri: string | undefined}

type Registry = {
  suspects: Map<string, Suspect>
  /** The arrival and `seq` of the latest 2xx that served each URI. */
  served: Map<string, {at: number; seq: number}>
  /** A 2xx whose quote verdict was `null` or `{unavailable}` (6.3). */
  answered: Map<string, number>
  gatedAt: Map<string, number>
  /** Raised when a `gatedAt` entry is evicted; read for a URI with none. */
  gatedFloor: number
  /** Own URIs the PDS answered for, this run. */
  pdsChecked: Map<string, 'present' | 'absent'>
  pdsInFlight: Set<string>
  holds: Map<string, Hold>
}

const registries = new Map<string, Registry>()
const listeners = new Set<() => void>()

let watching = false
let watchedDid: string | undefined

function notify() {
  listeners.forEach(listener => listener())
}

/*
 * Subscribed on first use rather than at import, so importing this module has
 * no side effect: an account change clears every registry, and a confirmed
 * account drops its load-gate floors (BR14-N4).
 */
function watch() {
  if (watching) return
  watching = true
  watchedDid = getCurrentDid()
  subscribeCurrentClients(() => {
    const next = getCurrentDid()
    if (next !== watchedDid) {
      watchedDid = next
      registries.clear()
      notify()
    }
  })
  subscribePrismHealth(() => {
    let changed = false
    registries.forEach((registry, did) => {
      if (
        (registry.gatedAt.size > 0 || registry.gatedFloor > 0) &&
        isPrismConfirmed(did)
      ) {
        registry.gatedAt.clear()
        registry.gatedFloor = 0
        changed = true
      }
    })
    if (changed) notify()
  })
}

function registryOf(did: string): Registry {
  watch()
  let registry = registries.get(did)
  if (!registry) {
    registry = {
      suspects: new Map(),
      served: new Map(),
      answered: new Map(),
      gatedAt: new Map(),
      gatedFloor: 0,
      pdsChecked: new Map(),
      pdsInFlight: new Set(),
      holds: new Map(),
    }
    registries.set(did, registry)
  }
  return registry
}

function now(): number {
  return healthEnvironment().now()
}

/** Set `key` as the newest entry, dropping the oldest past the cap. */
function setCapped<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  onEvict?: (value: V) => void,
) {
  map.delete(key)
  map.set(key, value)
  while (map.size > REGISTRY_CAP) {
    const oldest = map.keys().next().value as string
    const evicted = map.get(oldest) as V
    map.delete(oldest)
    onEvict?.(evicted)
  }
}

function authorOf(uri: string): string | undefined {
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

/** A private post of the account `did`. */
export function isOwnPrivateUri(uri: string, did: string): boolean {
  return isPrivatePostUri(uri) && authorOf(uri) === did
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const NOT_SERVED_TYPES: ReadonlySet<string> = new Set([
  'app.bsky.embed.record#viewNotFound',
  'app.bsky.embed.record#viewBlocked',
  'app.bsky.embed.record#viewDetached',
  'app.nearhorizon.private.defs#viewUnavailable',
])

/**
 * Every private post view an answer's body hydrated (4, "What counts as
 * served"): top-level views, quoted `#viewRecord`s at any depth, a feed
 * item's reply context and repost subject, thread nodes. A view is an object
 * with a private post URI, a CID and an author, carrying its record (`record`
 * on a post view, `value` on a quoted `#viewRecord`). `#viewNotFound`,
 * `#viewUnavailable` and the other stand-ins are not serves; a strong ref has
 * no author and is not one either.
 */
export function servedUrisOf(body: unknown): string[] {
  const uris = new Set<string>()
  const seen = new Set<object>()
  const walk = (value: unknown, depth: number) => {
    if (depth > 24 || !isObject(value) || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const type = typeof value.$type === 'string' ? value.$type : undefined
    if (type && NOT_SERVED_TYPES.has(type)) return
    if (
      typeof value.uri === 'string' &&
      isPrivatePostUri(value.uri) &&
      typeof value.cid === 'string' &&
      isObject(value.author) &&
      (isObject(value.record) || isObject(value.value))
    ) {
      uris.add(value.uri)
    }
    for (const key of Object.keys(value)) walk(value[key], depth + 1)
  }
  walk(body, 0)
  return Array.from(uris)
}

/**
 * Record a 2xx's serves (4): every URI is served at the answer's arrival,
 * and a suspect missed by an answer sent no later than this one ends. Also
 * drops a URI's load-gate floor once it is served after it, and the holds on
 * served URIs. `reportedPrismCall` calls it for every private 2xx.
 */
export function noteServed(
  answer: Pick<AnswerContext, 'did' | 'seq'> & {
    seqOf?: (uri: string) => number
  },
  views: Iterable<string | {uri: string}>,
): void {
  if (!answer.did) return
  const registry = registryOf(answer.did)
  const at = now()
  let changed = false
  for (const view of views) {
    const uri = typeof view === 'string' ? view : view.uri
    if (!isPrivatePostUri(uri)) continue
    const seq = answer.seqOf?.(uri) ?? answer.seq
    const previous = registry.served.get(uri)
    if (!previous || previous.seq <= seq) {
      setCapped(registry.served, uri, {at, seq})
    }
    const suspect = registry.suspects.get(uri)
    if (suspect && suspect.missSeq <= seq) registry.suspects.delete(uri)
    const floor = registry.gatedAt.get(uri)
    if (floor !== undefined && floor <= at) registry.gatedAt.delete(uri)
    for (const [key, held] of registry.holds) {
      if (held.uri === uri) registry.holds.delete(key)
    }
    changed = true
  }
  if (changed) notify()
}

/**
 * The PDS's answer for the reader's own private post: `present`, `absent`
 * (`RecordNotFound`) or `unknown` (any other failure, or no clients).
 */
async function readOwnRecordState(
  did: string,
  uri: string,
): Promise<'present' | 'absent' | 'unknown'> {
  const clients = getCurrentClients()
  if (!clients || clients.did !== did) return 'unknown'
  try {
    await clients.pdsClient.call(com.atproto.repo.getRecord, {
      repo: did as DidString,
      collection: PP_COLLECTION,
      rkey: new AtUri(uri).rkey,
    })
    return 'present'
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return 'absent'
    }
    return 'unknown'
  }
}

/**
 * One PDS check of an own URI per run (4): `absent` makes the miss `real`,
 * `present` keeps it `suspect` (never real). A failed read records nothing,
 * so a later miss may ask again.
 */
function checkOwnRecord(did: string, uri: string) {
  const registry = registryOf(did)
  if (registry.pdsChecked.has(uri) || registry.pdsInFlight.has(uri)) return
  registry.pdsInFlight.add(uri)
  readOwnRecordState(did, uri).then(
    state => {
      if (registries.get(did) !== registry) return
      registry.pdsInFlight.delete(uri)
      if (state === 'unknown') return
      registry.pdsChecked.set(uri, state)
      if (state === 'absent') registry.suspects.delete(uri)
      notify()
    },
    (error: unknown) => {
      registry.pdsInFlight.delete(uri)
      logger.warn('private post PDS check failed', {uri, safeMessage: error})
    },
  )
}

/** A step of the suspect clock: `d` times 0.75 to 1 (4). */
function clockStep(tries: number): number {
  const base = SUSPECT_STEPS_MS[Math.min(tries, SUSPECT_STEPS_MS.length) - 1]
  return base * (0.75 + healthEnvironment().random() * 0.25)
}

/**
 * A post `answer` left out (a 200's omission, a `NotFound`, the anchor of a
 * named `Unavailable`), judged once (4). Returns the verdict; a suspect's
 * clock advances only on a miss at or after its `nextAt`. A miss from an
 * answer sent before the URI's latest serve changes nothing.
 */
export function noteMiss(
  answer: Pick<AnswerContext, 'did' | 'seq'>,
  uri: string,
  opts: MissOptions = {},
): MissVerdict {
  const did = answer.did
  if (!did || !isPrivatePostUri(uri)) return 'unknown'
  const registry = registryOf(did)
  const served = registry.served.get(uri)
  if (served && served.seq > answer.seq) return missVerdict(did, uri)
  const own = isOwnPrivateUri(uri, did)
  if (own && registry.pdsChecked.get(uri) === 'absent') return 'real'
  const existing = registry.suspects.get(uri)
  if (!own && !opts.signalled && !existing) return 'unknown'

  const at = now()
  const suspect: Suspect = existing ?? {
    own,
    since: at,
    tries: 0,
    nextAt: 0,
    missSeq: answer.seq,
  }
  suspect.missSeq = Math.max(suspect.missSeq, answer.seq)
  if (at >= suspect.nextAt) {
    suspect.tries += 1
    suspect.nextAt =
      at + Math.max(clockStep(suspect.tries), opts.retryAfterMs ?? 0)
  }
  registry.suspects.set(uri, suspect)
  if (own && !opts.skipPdsCheck) checkOwnRecord(did, uri)
  notify()
  return 'suspect'
}

/**
 * Judge every URI `asked` that `answer` did not serve: `signalled` when the
 * answer is degraded or lists the URI in `unavailable[]`, which also skips
 * the PDS check (4, 7). Returns each omission's verdict.
 */
export function noteOmissions(
  answer: Pick<
    AnswerContext,
    'did' | 'seq' | 'degraded' | 'retryAfterMs' | 'unavailable'
  >,
  asked: Iterable<string>,
  served: Iterable<string>,
): Map<string, MissVerdict> {
  const servedSet = new Set(served)
  const listed = new Set<string>(answer.unavailable.map(item => item.uri))
  const verdicts = new Map<string, MissVerdict>()
  for (const uri of asked) {
    if (servedSet.has(uri) || verdicts.has(uri)) continue
    const inList = listed.has(uri)
    verdicts.set(
      uri,
      noteMiss(answer, uri, {
        signalled: answer.degraded || inList,
        retryAfterMs: answer.retryAfterMs,
        skipPdsCheck: inList && isOwnPrivateUri(uri, answer.did),
      }),
    )
  }
  return verdicts
}

/** The registry's current verdict on `uri` for `did`. */
export function missVerdict(did: string, uri: string): MissVerdict {
  const registry = registries.get(did)
  if (!registry) return 'unknown'
  if (isOwnPrivateUri(uri, did) && registry.pdsChecked.get(uri) === 'absent') {
    return 'real'
  }
  return registry.suspects.has(uri) ? 'suspect' : 'unknown'
}

/** Whether the PDS said the reader's own post at `uri` is gone (4). */
export function isOwnAbsent(did: string, uri: string): boolean {
  return registries.get(did)?.pdsChecked.get(uri) === 'absent'
}

/** A 2xx that arrived at or after `since` served `uri`. */
export function servedSince(did: string, uri: string, since: number): boolean {
  const served = registries.get(did)?.served.get(uri)
  return !!served && served.at >= since
}

/**
 * A 2xx that arrived at or after `since` served `uri` or gave its quote a
 * verdict (6.3, BR12-N6). Content still needs {@link servedSince}.
 */
export function answeredSince(
  did: string,
  uri: string,
  since: number,
): boolean {
  if (servedSince(did, uri, since)) return true
  const at = registries.get(did)?.answered.get(uri)
  return at !== undefined && at >= since
}

/**
 * A quote verdict (`null` or `{unavailable}`) that took effect (6.3,
 * BR13-N4): the quote is answered from now.
 */
export function noteAnswered(did: string, uri: string): void {
  if (!did) return
  setCapped(registryOf(did).answered, uri, now())
  notify()
}

/**
 * A load that began unconfirmed carries these URIs (4.1): each one's floor
 * rises to `at`, the load's start, and never falls; a URI served after its
 * floor drops it.
 */
export function gateUris(did: string, uris: Iterable<string>, at: number) {
  if (!did) return
  const registry = registryOf(did)
  let changed = false
  for (const uri of uris) {
    if (!isPrivatePostUri(uri)) continue
    const previous = registry.gatedAt.get(uri) ?? registry.gatedFloor
    if (previous >= at && registry.gatedAt.has(uri)) continue
    setCapped(registry.gatedAt, uri, Math.max(previous, at), evicted => {
      registry.gatedFloor = Math.max(registry.gatedFloor, evicted)
    })
    changed = true
  }
  if (changed) notify()
}

/** `uri`'s load-gate floor for `did`, if any (4.1). */
export function gatedAt(did: string, uri: string): number | undefined {
  const registry = registries.get(did)
  if (!registry) return undefined
  const at = registry.gatedAt.get(uri)
  if (at !== undefined) return at
  return registry.gatedFloor > 0 ? registry.gatedFloor : undefined
}

/**
 * When a held query may read `uri` again: the suspect clock, and never before
 * health's throttle allows (4).
 */
export function suspectRetryAt(did: string, uri: string): number {
  const nextAt = registries.get(did)?.suspects.get(uri)?.nextAt ?? 0
  return Math.max(nextAt, getPrismHealth(did).retryAt)
}

/**
 * The `refetchInterval` of a held non-infinite query standing in for the
 * suspect `uri` (4, "Holds"): until `suspectRetryAt`, at least 1 s; `false`
 * once the suspect ends or after {@link SUSPECT_MAX_TRIES} tries. An
 * infinite query never gets one.
 */
export function suspectRefetchInterval(
  did: string,
  uri: string,
): number | false {
  const suspect = registries.get(did)?.suspects.get(uri)
  if (!suspect || suspect.tries >= SUSPECT_MAX_TRIES) return false
  return Math.max(1_000, suspectRetryAt(did, uri) - now())
}

/**
 * {@link suspectRefetchInterval} for a non-infinite query of the post at
 * `uri` (a thread anchor, post 1), for the current account; `false` for a
 * public post or a handle authority, which has no suspect.
 */
export function heldPostRefetchInterval(
  uri: string | undefined,
  did: string | undefined = getCurrentDid(),
): number | false {
  if (!did || !uri || !isPrivatePostUri(uri)) return false
  return suspectRefetchInterval(did, uri)
}

function holdKey(queryKey: QueryKey, uri: string | undefined) {
  return `${JSON.stringify(queryKey)} ${uri ?? ''}`
}

/**
 * Mark the query invalidated (`refetchType: 'none'`) once its fetch has
 * settled, so it is written first and any verdict's `setQueryData` lands
 * before the mark.
 */
function invalidateWhenSettled(qc: QueryClient, queryKey: QueryKey) {
  const cache = qc.getQueryCache()
  const mark = () => {
    void qc.invalidateQueries({queryKey, exact: true, refetchType: 'none'})
  }
  const query = cache.find({queryKey, exact: true})
  if (!query || query.state.fetchStatus === 'idle') {
    setTimeout(mark, 0)
    return
  }
  const unsubscribe = cache.subscribe(event => {
    if (event.query !== query) return
    if (event.type === 'removed') {
      unsubscribe()
      return
    }
    if (query.state.fetchStatus === 'idle') {
      unsubscribe()
      mark()
    }
  })
}

/**
 * Record a query whose value is kept or stands in for a suspect (4): the
 * catch-up reads the list (2.4). It is marked invalidated once its fetch
 * settles. A hold on a URI ends when the URI is served.
 */
export function hold(
  queryKey: QueryKey,
  uri?: string,
  qc: QueryClient | undefined = getCurrentClients()?.queryClient,
  did: string | undefined = getCurrentDid(),
): void {
  if (!did) return
  const registry = registryOf(did)
  const key = holdKey(queryKey, uri)
  const fresh = !registry.holds.has(key)
  registry.holds.set(key, {queryKey, uri})
  if (qc) {
    invalidateWhenSettled(qc, queryKey)
    // A hold with no URI ends at the query's next 2xx (HR2-L3); a URI's on its serve.
    if (uri === undefined && fresh) releaseOnNextSuccess(qc, queryKey, did)
  }
}

/**
 * Drop the URI-less hold on `queryKey` once a fetch that starts after the
 * one that made it succeeds. That fetch may itself succeed (`keepOrHold`'s
 * does) and must not end it: the watch arms on the next turn, once that fetch
 * is idle, and then needs a fetch of its own followed by its success (a
 * manual `setQueryData` is not a 2xx).
 */
function releaseOnNextSuccess(qc: QueryClient, queryKey: QueryKey, did: string) {
  const cache = qc.getQueryCache()
  const query = cache.find({queryKey, exact: true})
  if (!query) return
  const registry = registryOf(did)
  let armed: 'no' | 'idle' | 'yes' = 'no'
  let fetched = false
  const unsubscribe = cache.subscribe(event => {
    if (event.query !== query) return
    if (event.type === 'removed' || registries.get(did) !== registry) {
      unsubscribe()
      return
    }
    if (!registry.holds.has(holdKey(queryKey, undefined))) {
      unsubscribe()
      return
    }
    if (armed === 'idle' && query.state.fetchStatus === 'idle') armed = 'yes'
    if (armed !== 'yes' || event.type !== 'updated') return
    if (event.action.type === 'fetch') fetched = true
    if (event.action.type === 'success' && fetched) {
      unsubscribe()
      registry.holds.delete(holdKey(queryKey, undefined))
      notify()
    }
  })
  setTimeout(() => {
    armed = query.state.fetchStatus === 'idle' ? 'yes' : 'idle'
  }, 0)
}

/**
 * Drop every hold of `did` that has no URI (2.4, HR2-L3): the catch-up calls
 * it once it has refetched them, so a query held during an outage is not held
 * for the rest of the session. A URI's hold still ends on its serve.
 */
export function releaseUnspecificHolds(did: string): void {
  const registry = registries.get(did)
  if (!registry) return
  let changed = false
  for (const [key, held] of registry.holds) {
    if (held.uri === undefined) {
      registry.holds.delete(key)
      changed = true
    }
  }
  if (changed) notify()
}

/** The held queries of `did` (2.4). */
export function heldQueries(did: string): Hold[] {
  return Array.from(registries.get(did)?.holds.values() ?? [])
}

/** Whether `did` holds the query at `queryKey`, for any URI (4.1's "held"). */
export function isHeld(did: string, queryKey: QueryKey): boolean {
  const key = JSON.stringify(queryKey)
  for (const held of registries.get(did)?.holds.values() ?? []) {
    if (JSON.stringify(held.queryKey) === key) return true
  }
  return false
}

/** Forget a hold (the catch-up refetched it). */
export function dropHold(did: string, queryKey: QueryKey, uri?: string) {
  registries.get(did)?.holds.delete(holdKey(queryKey, uri))
}

/**
 * The one condition for the "Syncing" label (4, BR10-N4): the reader's own
 * private post, not `absent` on the PDS, and one of:
 * - it is a suspect;
 * - it is a written pending post past {@link SYNCING_AFTER_MS} not served
 *   since it was written;
 * - its slot is gated (`floor` set, 4.1), a cause is set, and it has not been
 *   served since `floor` (so a launch gated only because nothing has
 *   answered shows none, BR10-N3).
 */
export function isSyncing(did: string, uri: string, floor?: number): boolean {
  if (!did || !isOwnPrivateUri(uri, did)) return false
  const registry = registries.get(did)
  if (registry?.pdsChecked.get(uri) === 'absent') return false
  if (registry?.suspects.has(uri)) return true
  const pending = getPendingPost(uri, did)
  if (pending && pendingPhase(pending) === 'written') {
    const writtenAt = pending.expiresAt - PENDING_TTL_MS
    if (
      now() - writtenAt >= SYNCING_AFTER_MS &&
      !servedSince(did, uri, writtenAt)
    ) {
      return true
    }
  }
  if (
    floor !== undefined &&
    getPrismHealth(did).causes.size > 0 &&
    !servedSince(did, uri, floor)
  ) {
    return true
  }
  return false
}

/**
 * Called on a serve, a verdict, `gateUris`, the PDS check and an account
 * change. Returns the unsubscribe function.
 */
export function subscribeRegistry(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The registry, the pending store and health together: everything
 * {@link isSyncing} reads.
 */
function subscribeSyncing(listener: () => void) {
  const off = [
    subscribeRegistry(listener),
    subscribePrivateStores(listener),
    subscribePrismHealth(listener),
  ]
  return () => off.forEach(unsubscribe => unsubscribe())
}

/** {@link isSyncing} for the current account, kept current. */
export function useIsSyncing(uri: string, floor?: number): boolean {
  const did = useCurrentClients()?.did
  return useSyncExternalStore(subscribeSyncing, () =>
    did ? isSyncing(did, uri, floor) : false,
  )
}

/** The quote cache's key root (`quotes/cache.ts`), which holds JSON. */
const QUOTE_ROOT = 'horizon-private-quote'

type PostView = app.bsky.feed.defs.PostView

/** A post view of `uri` in `data`, at any depth; not one built from cache. */
function findViewIn(data: unknown, uri: string): PostView | undefined {
  const seen = new Set<object>()
  let partial: PostView | undefined
  const walk = (value: unknown, depth: number): PostView | undefined => {
    if (depth > 24 || !isObject(value) || seen.has(value)) return undefined
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1)
        if (found) return found
      }
      return undefined
    }
    if (
      value.uri === uri &&
      typeof value.cid === 'string' &&
      isObject(value.author) &&
      isObject(value.record) &&
      value.horizonFromCache === undefined
    ) {
      // A full view (with counts) beats a partial one, as stock prefers.
      if (value.likeCount != null) return value as PostView
      partial ??= value as PostView
    }
    for (const key of Object.keys(value)) {
      const found = walk(value[key], depth + 1)
      if (found) return found
    }
    return undefined
  }
  return walk(data, 0) ?? partial
}

/**
 * A cached view of the post at `uri` (4): the pending store, then any
 * query's data (the stock thread, feed, notification and search caches and
 * Horizon's private lists alike), then the quote cache, skipping views
 * tagged `horizonFromCache`. Surfaces use it only for the reader's own posts;
 * the outbox for an own parent's `parentView` (9). It reads the cache
 * generically, so the placement path imports no stock query module.
 */
export function findCachedPrivatePostView(
  qc: QueryClient,
  uri: string,
): PostView | undefined {
  const pending = getPendingPost(uri)
  if (pending) return pending.postView
  let partial: PostView | undefined
  let quote: PostView | undefined
  for (const query of qc.getQueryCache().getAll()) {
    const data = query.state.data
    if (data === undefined || data === null) continue
    if (query.queryKey[0] === QUOTE_ROOT) {
      const args = query.queryKey[1] as {uri?: unknown} | undefined
      if (
        args?.uri === uri &&
        isObject(data) &&
        (data as {unavailable?: unknown}).unavailable !== true
      ) {
        quote = jsonToLex(data as JsonValue) as unknown as PostView
      }
      continue
    }
    const found = findViewIn(data, uri)
    if (found?.likeCount != null) return found
    partial ??= found
  }
  return partial ?? quote
}

/** Forget every account's registry (tests). */
export function resetKnown() {
  registries.clear()
  notify()
}
