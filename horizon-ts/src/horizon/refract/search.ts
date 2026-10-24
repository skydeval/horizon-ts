/*
 * Restored accounts in the search box and on the Search screen's People tab.
 * Bluesky's AppView leaves banned accounts out of `searchActors` and
 * `searchActorsTypeahead`, so a restored account can't be found by name.
 *
 * - **Prism's search** (prism `0c4634d`). While prism lists `refract.search`,
 *   `refract.searchActorsTypeahead` (the search box) and `refract.searchActors`
 *   (People, paged with stock) run beside stock's own search; their actors
 *   are merged by DID, prism's exact handle first, the rest after stock's.
 *   prism drops blocked, gate-hidden and muted accounts and, for visitors,
 *   lists unchecked ones in `withheld`.
 * - **Exact match (the fallback).** Without `refract.search`, or for a DID,
 *   a query that is a full handle (a dot, no spaces, an optional leading
 *   `@`) or a DID is resolved to a DID (stock
 *   `resolveHandle` on the AppView, sharing the profile screen's
 *   `['resolved-did', handle]` cache) and asked of `fill` once, paced like
 *   a quote slot (background, the open screen's). Partial text asks nothing.
 * - **One ask per query per account.** A definitive answer (restored, not
 *   restored, an unknown handle, a block) is kept for the session; a
 *   non-definitive one (`pending`, `unavailable`, a failed or skipped call)
 *   for {@link REFRACT_SEARCH_TIMING.retryMs}. Refract's own `retryAt`, the
 *   `withheld` rules and the stock pre-check apply, since this goes through
 *   `askFill`.
 * - **Blocks.** A view with a block flag, or a DID in the reader's own block
 *   set, is never offered.
 * - **Visitor form.** A view kept from a visitor answer is asked again once
 *   visitor form ends, so the row carries member viewer state.
 * - **Pacing.** Refract's asks wait {@link REFRACT_SEARCH_TIMING.debounceMs}
 *   after the last keystroke and go as background calls for the open screen;
 *   stock's never wait on them.
 *
 * The views keep their marker and stamp, so they render like any account
 * and the profile they open is prewarmed. No log line carries a DID or a
 * handle.
 */

import {useEffect, useState, useSyncExternalStore} from 'react'
import {XrpcResponseError} from '@atproto/lex'
import {type HandleString, isValidHandle} from '@atproto/syntax'

import {hasBlockFlag} from '#/horizon/refract/answer'
import {refractCall} from '#/horizon/refract/api'
import {
  askFill,
  isDefinitelyNotRestored,
  isValidFillDid,
} from '#/horizon/refract/fill'
import {
  refractActive,
  restoredVisitorForm,
  subscribeRefractGate,
} from '#/horizon/refract/gate'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {readRestored, stampOf} from '#/horizon/refract/marker'
import {loadOwnBlocks, ownBlockOf} from '#/horizon/refract/relations'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {servesFeature} from '#/horizon/routing/features'
import {type app, com} from '#/lexicons'

type ProfileView = app.bsky.actor.defs.ProfileViewDetailed

/** Times. Mutable for tests. */
export const REFRACT_SEARCH_TIMING = {
  /**
   * The wait after the last keystroke before a new query is asked. Stock's
   * typeahead has no debounce of its own (it asks per keystroke); this only
   * holds the Refract ask, never stock's. Without it every keystroke would
   * be a call in prism's one refract rate class, and a 429 there sets
   * `retryAt` for every refract read on the account.
   */
  debounceMs: 200,
  /** How long a non-definitive answer is kept before it is asked again. */
  retryMs: 60_000,
  /** How long prefix matches for one query are kept. */
  prefixMs: 60_000,
}

/** Where a late restored entry goes: first, or after what is shown. */
export type RestoredPlacement = 'top' | 'end'

/**
 * The exact actor a query names, or `undefined` for partial text: a
 * lowercased handle (leading `@` dropped) or a DID.
 */
export function exactActorQuery(raw: string): string | undefined {
  const q = raw.trim().replace(/^@/, '')
  if (!q || /\s/.test(q)) return undefined
  if (q.startsWith('did:')) return isValidFillDid(q) ? q : undefined
  const handle = q.toLowerCase()
  if (!handle.includes('.')) return undefined
  return isValidHandle(handle) ? handle : undefined
}

type Entry = {
  /** `null`: nothing to offer. */
  profile: ProfileView | null
  until: number
}

type Memo = {
  did: string
  entries: Map<string, Entry>
  inFlight: Map<string, Promise<ProfileView | null>>
  prefix: Map<string, {actors: ProfileView[]; until: number}>
  prefixInFlight: Map<string, Promise<ProfileView[]>>
}

let memo: Memo | undefined
const listeners = new Set<() => void>()
let version = 0

function notify() {
  version++
  listeners.forEach(listener => listener())
}

function currentMemo(): Memo | undefined {
  const did = getCurrentClients()?.did
  if (!did) return undefined
  if (memo?.did !== did) {
    memo = {
      did,
      entries: new Map(),
      inFlight: new Map(),
      prefix: new Map(),
      prefixInFlight: new Map(),
    }
  }
  return memo
}

function offerable(profile: ProfileView): boolean {
  return !hasBlockFlag(profile) && !ownBlockOf(profile.did)
}

/** A kept entry that still holds, else `undefined` (ask again). */
function liveEntry(state: Memo, key: string): Entry | undefined {
  const entry = state.entries.get(key)
  if (!entry) return undefined
  if (entry.until <= Date.now()) {
    state.entries.delete(key)
    return undefined
  }
  if (entry.profile) {
    // A visitor view is asked again once visitor form ends.
    if (stampOf(entry.profile) === 'visitor' && !restoredVisitorForm()) {
      state.entries.delete(key)
      return undefined
    }
    // A restore that ended since, or a stock view since: nothing to add.
    if (isDefinitelyNotRestored(entry.profile.did)) {
      return {profile: null, until: entry.until}
    }
  }
  return entry
}

/**
 * The kept answer for `query`: a restored view, `null` (nothing to offer),
 * or `undefined` (not asked, or asked again).
 */
export function peekRestoredActor(
  query: string,
): ProfileView | null | undefined {
  const key = exactActorQuery(query)
  if (!key || !refractActive()) return null
  const state = currentMemo()
  if (!state) return null
  const entry = liveEntry(state, key)
  if (!entry) return undefined
  if (entry.profile && !offerable(entry.profile)) return null
  return entry.profile
}

async function resolveDid(key: string): Promise<string | null> {
  if (key.startsWith('did:')) return key
  const clients = getCurrentClients()
  if (!clients) return null
  const resolve = async () => {
    const data = await clients.appviewClient.call(
      com.atproto.identity.resolveHandle,
      {handle: key as HandleString},
    )
    return data.did as string
  }
  if (!clients.queryClient) return resolve()
  // The profile screen's `useResolveDidQuery` key, so a tap opens at once.
  return clients.queryClient.fetchQuery({
    queryKey: ['resolved-did', key],
    staleTime: 60 * 60_000,
    queryFn: resolve,
  })
}

const SESSION = Number.POSITIVE_INFINITY

async function lookup(state: Memo, key: string): Promise<Entry> {
  let did: string | null
  try {
    did = await resolveDid(key)
  } catch (error) {
    // A handle that doesn't resolve is definitive; anything else isn't.
    const definitive =
      error instanceof XrpcResponseError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    return {
      profile: null,
      until: definitive ? SESSION : Date.now() + REFRACT_SEARCH_TIMING.retryMs,
    }
  }
  if (!did || !isValidFillDid(did)) return {profile: null, until: SESSION}
  if (isDefinitelyNotRestored(did)) return {profile: null, until: SESSION}
  let verdict
  try {
    const outcome = await askFill(
      {dids: [did]},
      {kind: 'search', foreground: false, screen: true},
    )
    verdict = outcome.dids.get(did)
  } catch {
    return {profile: null, until: Date.now() + REFRACT_SEARCH_TIMING.retryMs}
  }
  switch (verdict?.kind) {
    case 'positive': {
      await loadOwnBlocks()
      const profile = verdict.profile
      if (!readRestored(profile) || !offerable(profile)) {
        return {profile: null, until: SESSION}
      }
      return {profile, until: SESSION}
    }
    case 'not-restored':
    case 'ended':
      return {profile: null, until: SESSION}
    default:
      return {profile: null, until: Date.now() + REFRACT_SEARCH_TIMING.retryMs}
  }
}

/**
 * Ask whether `query` names a restored account, once per query per account
 * (see the header). Resolves with the view, or `null`.
 */
export function lookupRestoredActor(
  query: string,
): Promise<ProfileView | null> {
  const key = exactActorQuery(query)
  if (!key || !refractActive()) return Promise.resolve(null)
  const state = currentMemo()
  if (!state) return Promise.resolve(null)
  const kept = peekRestoredActor(query)
  if (kept !== undefined) return Promise.resolve(kept)
  const running = state.inFlight.get(key)
  if (running) return running
  const promise = lookup(state, key).then(entry => {
    state.inFlight.delete(key)
    if (memo !== state) return null
    state.entries.set(key, entry)
    notify()
    return peekRestoredActor(query) ?? null
  })
  state.inFlight.set(key, promise)
  return promise
}

/* ------------------------------------------------------------------------ */
/* Prefix matches (planned prism methods, feature `refract.search`)          */
/* ------------------------------------------------------------------------ */

/** Whether prism serves restored-account search for the reader. */
export function refractSearchActive(): boolean {
  return refractActive() && servesFeature('refract.search')
}

/** prism refuses a `q` over this many characters (`InvalidRequest`). */
const MAX_Q = 100

/** The query as prism matches it (`@` dropped), or `undefined`. */
export function prefixQuery(raw: string): string | undefined {
  const q = raw.trim().replace(/^@/, '').toLowerCase()
  return q && q.length <= MAX_Q ? q : undefined
}

function prefixActors(body: unknown): ProfileView[] {
  const actors = (body as {actors?: unknown} | undefined)?.actors
  if (!Array.isArray(actors)) return []
  return (actors as ProfileView[]).filter(
    actor =>
      !!actor &&
      typeof actor.did === 'string' &&
      typeof actor.handle === 'string' &&
      !!readRestored(actor) &&
      offerable(actor),
  )
}

/** A kept page from a visitor answer is asked again once visitor form ends. */
function stillFits(actors: readonly ProfileView[]): boolean {
  return (
    restoredVisitorForm() || !actors.some(actor => stampOf(actor) === 'visitor')
  )
}

/**
 * prism's prefix matches for the typeahead (`refract.searchActorsTypeahead`),
 * `[]` while `refract.search` isn't listed. An answer is kept per query for
 * {@link REFRACT_SEARCH_TIMING.prefixMs}; a failed call is not kept.
 */
export function searchRestoredActorsTypeahead(
  raw: string,
  limit = 8,
): Promise<ProfileView[]> {
  const q = prefixQuery(raw)
  if (!q || !refractSearchActive()) return Promise.resolve([])
  const state = currentMemo()
  if (!state) return Promise.resolve([])
  const key = `${limit}|${q}`
  const kept = state.prefix.get(key)
  if (kept && kept.until > Date.now() && stillFits(kept.actors)) {
    return Promise.resolve(kept.actors.filter(offerable))
  }
  const running = state.prefixInFlight.get(key)
  if (running) return running
  const promise = refractCall<unknown>(
    REFRACT_METHODS.searchActorsTypeahead,
    {q, limit},
    {foreground: false, screen: true},
  )
    .then(
      answer => {
        const actors = prefixActors(answer.body)
        if (memo === state) {
          state.prefix.set(key, {
            actors,
            until: Date.now() + REFRACT_SEARCH_TIMING.prefixMs,
          })
        }
        return actors
      },
      () => [] as ProfileView[],
    )
    .then(actors => {
      state.prefixInFlight.delete(key)
      if (memo === state) notify()
      return actors
    })
  state.prefixInFlight.set(key, promise)
  return promise
}

/** How many prism pages one People page reads at most to find an actor. */
export const SEARCH_PAGES_PER_FETCH = 3

/**
 * One page of prism's prefix matches for People (`refract.searchActors`).
 * prism drops blocked, gate-hidden and muted accounts after cutting a page,
 * so an empty page with a cursor is followed, up to
 * {@link SEARCH_PAGES_PER_FETCH} calls. `{actors: []}` while `refract.search`
 * isn't listed; a failed call rejects.
 */
export async function searchRestoredActors(
  raw: string,
  {limit = 25, cursor}: {limit?: number; cursor?: string} = {},
): Promise<{actors: ProfileView[]; cursor?: string}> {
  const q = prefixQuery(raw)
  if (!q || !refractSearchActive()) return {actors: []}
  let next = cursor
  for (let page = 0; page < SEARCH_PAGES_PER_FETCH; page++) {
    const answer = await refractCall<{cursor?: unknown}>(
      REFRACT_METHODS.searchActors,
      {q, limit, ...(next ? {cursor: next} : {})},
      {foreground: true},
    )
    const actors = prefixActors(answer.body)
    next =
      typeof answer.body.cursor === 'string' && answer.body.cursor
        ? answer.body.cursor
        : undefined
    if (actors.length > 0 || !next) return {actors, cursor: next}
  }
  return {actors: [], cursor: next}
}

function peekPrefix(raw: string, limit: number): ProfileView[] {
  const q = prefixQuery(raw)
  if (!q || !refractSearchActive()) return []
  const kept = currentMemo()?.prefix.get(`${limit}|${q}`)
  if (!kept || kept.until <= Date.now() || !stillFits(kept.actors)) return []
  return kept.actors.filter(offerable)
}

/* ------------------------------------------------------------------------ */
/* Hooks                                                                     */
/* ------------------------------------------------------------------------ */

/** Subscribe to answers and gate changes (the hooks' store). */
export function subscribeRefractSearch(listener: () => void) {
  listeners.add(listener)
  const unsubscribe = subscribeRefractGate(listener)
  return () => {
    listeners.delete(listener)
    unsubscribe()
  }
}

/** The query after {@link REFRACT_SEARCH_TIMING.debounceMs} of no change. */
function useSettledQuery(query: string): string {
  const [settled, setSettled] = useState(query)
  useEffect(() => {
    if (settled === query) return
    const timer = setTimeout(
      () => setSettled(query),
      REFRACT_SEARCH_TIMING.debounceMs,
    )
    return () => clearTimeout(timer)
  }, [query, settled])
  return settled
}

/** What {@link useRestoredActorMatches} offers. */
export type RestoredMatches = {
  /** The exact match first (when offered), then prism's prefix matches. */
  actors: ProfileView[]
  /** The exact match's DID, when `actors` starts with it. */
  exactDid: string | undefined
}

const NO_MATCHES: RestoredMatches = {actors: [], exactDid: undefined}

/** The hooks' snapshot: changes with every answer and gate change. */
export function refractSearchSnapshot() {
  return `${version}|${refractActive()}|${restoredVisitorForm()}`
}

/**
 * Restored accounts for a search query: the exact match first (when the
 * query names one), then prism's prefix matches (only while
 * `refract.search` is listed). Empty while nothing is known; stock's
 * results never wait on this. Pass `''` to ask nothing.
 */
export function useRestoredActorMatches(
  query: string,
  {
    prefixLimit = 8,
    prefix = true,
  }: {prefixLimit?: number; prefix?: boolean} = {},
): RestoredMatches {
  const settled = useSettledQuery(query)
  /*
   * The store and gate are read through this snapshot: it is passed to every
   * read below so the React Compiler recomputes them when it changes.
   */
  const store = useSyncExternalStore(
    subscribeRefractSearch,
    refractSearchSnapshot,
  )
  const keys = queryKeys(query, settled, store, prefix)

  useEffect(() => {
    if (keys.settledExact) void lookupRestoredActor(settled)
  }, [keys.settledExact, settled])
  useEffect(() => {
    if (keys.settledPrefix) {
      void searchRestoredActorsTypeahead(settled, prefixLimit)
    }
  }, [keys.settledPrefix, settled, prefixLimit])

  return readMatches(query, prefixLimit, keys, store)
}

function queryKeys(
  query: string,
  settled: string,
  _store: string,
  prefix: boolean,
) {
  const active = refractActive()
  const searching = active && refractSearchActive()
  const exact = active ? exactActorQuery(query) : undefined
  // With prism's search listed, the exact handle comes from it; `fill` stays
  // the path for a DID and for a prism without the method.
  const exactKey =
    exact && (!searching || exact.startsWith('did:')) ? exact : undefined
  const prefixKey = searching && prefix ? prefixQuery(query) : undefined
  return {
    exactKey,
    prefixKey,
    exactHandle: prefixKey && exact && !exactKey ? exact : undefined,
    settledExact: !!exactKey && exactActorQuery(settled) === exactKey,
    settledPrefix: !!prefixKey && prefixQuery(settled) === prefixKey,
  }
}

function readMatches(
  query: string,
  prefixLimit: number,
  {
    exactKey,
    prefixKey,
    exactHandle,
  }: {exactKey?: string; prefixKey?: string; exactHandle?: string},
  _store: string,
): RestoredMatches {
  if (!exactKey && !prefixKey) return NO_MATCHES
  // A kept answer shows at once, before the debounce settles.
  let exact = exactKey ? peekRestoredActor(query) : null
  const prefix = prefixKey ? peekPrefix(query, prefixLimit) : []
  if (!exact && exactHandle) {
    exact =
      prefix.find(actor => actor.handle.toLowerCase() === exactHandle) ?? null
  }
  const actors: ProfileView[] = []
  if (exact) actors.push(exact)
  for (const actor of prefix) {
    if (!actors.some(other => other.did === actor.did)) actors.push(actor)
  }
  if (actors.length === 0) return NO_MATCHES
  return {actors, exactDid: exact?.did}
}

/**
 * Where restored entries go for `key`, decided once when they first show:
 * first while `navigated` is false, else after what is shown, so a row the
 * reader moved to stays put.
 */
export function useRestoredPlacement(
  key: string,
  present: boolean,
  navigated: boolean,
): RestoredPlacement {
  const [placed, setPlaced] = useState<
    {key: string; at: RestoredPlacement} | undefined
  >(undefined)
  if (placed?.key === key) return placed.at
  if (!present) return 'top'
  const at: RestoredPlacement = navigated ? 'end' : 'top'
  setPlaced({key, at})
  return at
}

/**
 * Merge restored entries into a list of stock profiles: those whose DID
 * stock already has are dropped; the exact match goes first (`'top'`, after
 * `leading` fixed rows such as "Search for") or after the list (`'end'`);
 * prefix matches always go after stock's.
 */
export function withRestoredActors<T>(
  stock: readonly T[],
  restored: readonly ProfileView[],
  {
    placement,
    didOf,
    toItem,
    exact,
    leading = 0,
  }: {
    placement: RestoredPlacement
    didOf: (item: T) => string | undefined
    toItem: (profile: ProfileView) => T
    /** The DID of the exact match, if `restored` starts with one. */
    exact?: string
    /** Fixed rows at the head that stay first. */
    leading?: number
  },
): T[] {
  if (restored.length === 0) return stock as T[]
  const seen = new Set<string>()
  for (const item of stock) {
    const did = didOf(item)
    if (did) seen.add(did)
  }
  const fresh = restored.filter(profile => {
    if (seen.has(profile.did)) return false
    seen.add(profile.did)
    return true
  })
  if (fresh.length === 0) return stock as T[]
  const head = fresh[0]?.did === exact ? fresh[0] : undefined
  const tail = fresh.filter(profile => profile !== head).map(toItem)
  const out = [...stock]
  if (head) {
    if (placement === 'top')
      out.splice(Math.min(leading, out.length), 0, toItem(head))
    else out.push(toItem(head))
  }
  out.push(...tail)
  return out
}

/**
 * Whether the reader moved through a Sift list with the keyboard since the
 * query last changed (web; always `false` where the input has no DOM).
 */
export function useKeyboardNavigated(input: unknown, query: string): boolean {
  const [navigated, setNavigated] = useState<string | undefined>(undefined)
  useEffect(() => {
    const target = input as
      | {
          addEventListener?: (
            type: string,
            fn: (e: {key: string}) => void,
          ) => void
          removeEventListener?: (
            type: string,
            fn: (e: {key: string}) => void,
          ) => void
        }
      | null
      | undefined
    if (!target?.addEventListener) return
    const onKeyDown = (e: {key: string}) => {
      if (NAV_KEYS.has(e.key)) setNavigated(query)
    }
    target.addEventListener('keydown', onKeyDown)
    return () => target.removeEventListener?.('keydown', onKeyDown)
  }, [input, query])
  return navigated === query
}

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End'])

/** Test-only: forget every kept answer. */
export function resetRefractSearch() {
  memo = undefined
  notify()
}
