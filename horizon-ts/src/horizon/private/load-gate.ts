/*
 * The load gate (prism busy design 4.1, BR-7; skydeval: "when prism can't be
 * reached, horizon keeps what's on screen, but on refresh reverts to
 * 'catching up' and hides private posts"). A cached copy of another author's
 * private post proves only that the reader could see it when it was served,
 * so a load that begins while the account is not confirmed shows it only
 * once prism has served it for this load.
 *
 * One floor rule, two carriers:
 * - Surfaces (lists, threads, post 1) judge their rows by the stamp of the
 *   fetch that wrote them (`useLoadGate`, `gatePages`): a row of another
 *   author's private post held in data fetched before `loadSince` is hidden.
 * - Slots (quotes, the own-post label) sit deep in stock components and judge
 *   themselves per URI (`useSlotFloor`, `useServedSince`) against the
 *   registry's `served` and `gatedAt` (`known.ts`).
 *
 * The gate only hides: it fills and keeps nothing. Own posts are never gated
 * (they paint with "Syncing"). The surface lifts itself once the account is
 * confirmed (Recovery), outside the catch-up's rate limit.
 */

import {useEffect, useRef, useState, useSyncExternalStore} from 'react'
import {
  hashKey,
  type QueryKey,
  type QueryState,
  useQueryClient,
} from '@tanstack/react-query'

import {restartPrivateQuery} from '#/horizon/private/api/transient'
import {
  gatedAt,
  gateUris,
  isOwnPrivateUri,
  servedSince,
  subscribeRegistry,
} from '#/horizon/private/known'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {
  floorSince,
  healthEnvironment,
  isPrismConfirmed,
  usePrismConfirmed,
  usePrismHealth,
} from '#/horizon/routing/health'

/**
 * How far back a slot mounting unconfirmed counts a serve: the page that
 * rendered it, at most this long before the mount (4.1, BR15-N10). Its own
 * constant, equal to `QUOTE_DEADLINE_MS` today and tuned apart.
 */
export const SLOT_JOIN_MS = 2_000

/**
 * How long a private query with nothing cached shows its skeleton, from its
 * first fetch, before the quiet "Couldn't load right now" row with Try again
 * while its retries go on (design 5).
 */
export const EMPTY_WAIT_MS = 30_000

function now(): number {
  return healthEnvironment().now()
}

/**
 * A fetch's completion stamp (4.1): the data it writes counts as fetched now.
 * Read on health's clock, as the gate's own times are.
 */
export function fetchStamp(): number {
  return now()
}

/**
 * Whether a query that has nothing to show (`waiting`) has waited
 * {@link EMPTY_WAIT_MS} since it began to, so its surface shows the quiet row
 * instead of the skeleton (design 5). Resets once it has something.
 */
export function useEmptyWaitCapped(waiting: boolean): boolean {
  const [since, setSince] = useState<number | undefined>(undefined)
  const [capped, setCapped] = useState(false)
  useEffect(() => {
    if (!waiting) {
      setSince(undefined)
      setCapped(false)
      return
    }
    const start = since ?? now()
    if (since === undefined) setSince(start)
    const left = start + EMPTY_WAIT_MS - now()
    if (left <= 0) {
      setCapped(true)
      return
    }
    const env = healthEnvironment()
    const timer = env.setTimeout(() => setCapped(true), left)
    return () => env.clearTimeout(timer)
  }, [waiting, since])
  return waiting && capped
}

/** One row as the gate judges it: the private post it shows. */
export type GatedItem = {
  uri: string
  /** The completion stamp of the page this row was carried from (BR11-N5). */
  horizonFromCache?: number
}

/** A page as the gate judges it: its completion stamp and its rows. */
export type GatedPage = {
  fetchedAt?: number
  items: readonly GatedItem[]
}

/**
 * How {@link gatePages} reads one surface's pages: each surface's pages and
 * rows have their own shape.
 */
export type PageAccess<P, I> = {
  /** The page's completion stamp (`fetchedAt`, a notification page's own). */
  stampOf: (page: P) => number | undefined
  itemsOf: (page: P) => readonly I[]
  /** The page with only `items` (never called when nothing was removed). */
  withItems: (page: P, items: I[]) => P
  /** The private posts a row shows whose author decides it (4.1). */
  urisOf: (item: I) => Iterable<string>
  /** A carried row's own stamp, read before its page's (BR12-N4). */
  carriedStampOf?: (item: I) => number | undefined
}

const DEFAULT_ACCESS: PageAccess<GatedPage, GatedItem> = {
  stampOf: page => page.fetchedAt,
  itemsOf: page => page.items,
  withItems: (page, items) => ({...page, items}),
  urisOf: item => [item.uri],
  carriedStampOf: item => item.horizonFromCache,
}

/**
 * Whether a gated load hides this row (4.1, BR10-L4): it shows another
 * author's private post, and the data holding it was fetched before
 * `loadSince` (a carried row by its own stamp; no stamp counts as old).
 * Never for the reader's own posts, and never without `loadSince`.
 */
export function isGatedOut(
  did: string,
  item: GatedItem,
  stamp: number | undefined,
  loadSince?: number,
): boolean {
  if (loadSince === undefined) return false
  if (!isPrivatePostUri(item.uri) || isOwnPrivateUri(item.uri, did)) {
    return false
  }
  const at = item.horizonFromCache ?? stamp
  return at === undefined || at < loadSince
}

/**
 * Every page with the rows a gated load hides removed, and how many (4.1,
 * "Lists"). A page with nothing removed is returned as it is. Never reads the
 * registry, so a serve elsewhere never inserts a row in place.
 */
export function gatePages<P = GatedPage, I = GatedItem>(
  pages: readonly P[],
  did: string,
  loadSince?: number,
  access: PageAccess<P, I> = DEFAULT_ACCESS as unknown as PageAccess<P, I>,
): {pages: P[]; hidden: number} {
  if (loadSince === undefined) return {pages: [...pages], hidden: 0}
  let hidden = 0
  const out = pages.map(page => {
    const stamp = access.stampOf(page)
    const items = access.itemsOf(page)
    const kept = items.filter(item => {
      const carried = access.carriedStampOf?.(item)
      for (const uri of access.urisOf(item)) {
        if (isGatedOut(did, {uri, horizonFromCache: carried}, stamp, loadSince)) {
          return false
        }
      }
      return true
    })
    if (kept.length === items.length) return page
    hidden += items.length - kept.length
    return access.withItems(page, kept)
  })
  return {pages: out, hidden}
}

/** The surface's own recovery, beyond refetching its query (4.1). */
export type LoadGateOptions<D> = {
  /** The rows the gate hides in `data` for `loadSince` (`gatePages`). */
  hiddenOf?: (data: D, loadSince: number) => number
  /**
   * The surface's fetch from the top: the gated mount's and the lift's at the
   * top (a list drops later pages and refetches the first). Default: the
   * query's own refetch.
   */
  refreshFromTop?: () => unknown
  /** Whether the reader is at the top; scrolled down the lift lights the affordance. */
  isAtTop?: () => boolean
  /** Scrolled down at the lift: light "Load new posts", or `refreshPending`. */
  onScrolledDownLift?: () => void
  /** Trimmed beyond hidden rows and errors (a degraded topmost page). */
  trimmedOf?: (data: D) => boolean
}

export type LoadGate = {
  /** Set when this load began unconfirmed; fixed for the load. */
  loadSince: number | undefined
  /** Called by every refresh of the surface, before its fetch starts. */
  restart: () => void
  /** Rows the gate removed on this surface. */
  hidden: number
  /** The surface lifts itself when the account is confirmed (Recovery). */
  trimmed: boolean
}

function useQueryStateOf<D>(queryKey: QueryKey): QueryState<D> | undefined {
  const qc = useQueryClient()
  const hash = hashKey(queryKey)
  return useSyncExternalStore(
    listener =>
      qc.getQueryCache().subscribe(event => {
        if (event.query.queryHash === hash) listener()
      }),
    () => qc.getQueryState<D>(queryKey),
  )
}

/**
 * The load gate of one surface's query (4.1). Call it after the surface's
 * own query hook, so a top fetch the query starts on mount is joined.
 *
 * - **Captured, not live.** At mount it reads `isPrismConfirmed(did)` once:
 *   unconfirmed, `loadSince` is the mount time and the mount stamps its
 *   data's URIs (`gateUris`), so slots under its rows follow the same load;
 *   confirmed, it paints from cache. A later change of health changes
 *   nothing on screen.
 * - **`restart()`** captures again now: unconfirmed, a new `loadSince` and a
 *   new stamp; confirmed, the previous `loadSince` stays until the refresh
 *   writes its first page (BR10-N2).
 * - **A gated mount fetches from the top**, whatever its `staleTime`, unless
 *   a fetch is already in flight (joined).
 * - **The lift** (BR12-L3): a trimmed surface (rows hidden, in error, no data
 *   between retries, or `trimmedOf`) recovers once the account turns
 *   confirmed, or, trimmed by a method-specific failure, at the next private
 *   2xx: a query with no data restarts; scrolled down it lights its
 *   affordance; else it refreshes from the top. It skips while its own top
 *   fetch is in flight (BR11-N7).
 */
export function useLoadGate<D = unknown>(
  did: string | undefined,
  queryKey: QueryKey,
  urisOf: (data: D) => Iterable<string>,
  options: LoadGateOptions<D> = {},
): LoadGate {
  const qc = useQueryClient()
  const state = useQueryStateOf<D>(queryKey)
  const data = state?.data
  const [loadSince, setLoadSince] = useState<number | undefined>(() =>
    did && !isPrismConfirmed(did) ? now() : undefined,
  )
  /** A confirmed restart's start: `loadSince` clears once a page lands after it. */
  const [clearAfter, setClearAfter] = useState<number | undefined>(undefined)

  const refreshFromTop = () => {
    if (options.refreshFromTop) {
      void options.refreshFromTop()
    } else {
      void qc.refetchQueries({queryKey, exact: true})
    }
  }

  // The gated mount: stamp its data's URIs and fetch from the top.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    if (!did || loadSince === undefined) return
    const current = qc.getQueryState<D>(queryKey)
    if (current?.data === undefined) return
    gateUris(did, urisOf(current.data), loadSince)
    if (current.fetchStatus !== 'fetching') refreshFromTop()
  })

  // A confirmed restart ends the gated load once its first page is written.
  const dataUpdatedAt = state?.dataUpdatedAt ?? 0
  useEffect(() => {
    if (clearAfter !== undefined && dataUpdatedAt >= clearAfter) {
      setLoadSince(undefined)
      setClearAfter(undefined)
    }
  }, [clearAfter, dataUpdatedAt])

  const restart = () => {
    if (!did) return
    const at = now()
    if (isPrismConfirmed(did)) {
      setClearAfter(at)
      return
    }
    setClearAfter(undefined)
    setLoadSince(at)
    const current = qc.getQueryData<D>(queryKey)
    if (current !== undefined) gateUris(did, urisOf(current), at)
  }

  const hidden =
    loadSince !== undefined && data !== undefined && options.hiddenOf
      ? options.hiddenOf(data, loadSince)
      : 0
  const noDataBetweenRetries =
    data === undefined &&
    state?.fetchStatus === 'fetching' &&
    (state?.fetchFailureCount ?? 0) > 0
  const trimmed =
    hidden > 0 ||
    state?.status === 'error' ||
    noDataBetweenRetries ||
    (data !== undefined && !!options.trimmedOf?.(data))

  // The lift: on the transition to confirmed, or to a private 2xx.
  const confirmed = usePrismConfirmed(did)
  const failures = usePrismHealth(did).failures
  const previous = useRef({confirmed, failures})
  useEffect(() => {
    const before = previous.current
    previous.current = {confirmed, failures}
    const turnedConfirmed = !before.confirmed && confirmed
    const answered = before.failures > 0 && failures === 0
    // No account: an ungated surface (a public feed) never lifts.
    if (!did || !trimmed || !(turnedConfirmed || answered)) return
    const current = qc.getQueryState<D>(queryKey)
    if (current?.data === undefined) {
      void restartPrivateQuery(qc, queryKey)
      return
    }
    // Its own top fetch in flight brings the rows back (BR11-N7).
    if (current.fetchStatus === 'fetching') return
    if (options.isAtTop && !options.isAtTop()) {
      options.onScrolledDownLift?.()
      return
    }
    refreshFromTop()
  })

  return {loadSince, restart, hidden, trimmed}
}

/** One mounted slot's current floor. */
type SlotHandle = {floor: number | undefined}

/** The slots mounted now, by URI (for the lift's quote read). */
const mountedSlots = new Map<string, Set<SlotHandle>>()

/** The URIs of every mounted slot (4.1: the lift reads those not answered since their floor). */
export function mountedSlotUris(): string[] {
  return Array.from(mountedSlots.keys())
}

/**
 * Every mounted gated slot with its highest floor (4.1, Recovery): the lift
 * reads those not answered since it in one batch.
 */
export function mountedGatedSlots(): {uri: string; floor: number}[] {
  const out: {uri: string; floor: number}[] = []
  mountedSlots.forEach((handles, uri) => {
    let floor: number | undefined
    handles.forEach(handle => {
      if (handle.floor !== undefined) {
        floor = floor === undefined ? handle.floor : Math.max(floor, handle.floor)
      }
    })
    if (floor !== undefined) out.push({uri, floor})
  })
  return out
}

function maxDefined(...values: (number | undefined)[]): number | undefined {
  let out: number | undefined
  for (const value of values) {
    if (value !== undefined) out = out === undefined ? value : Math.max(out, value)
  }
  return out
}

/**
 * A slot's floor (4.1): `max(floorSince, gatedAt(uri), mountTime -
 * SLOT_JOIN_MS)` if the account was unconfirmed at mount, raised live by
 * `gatedAt(uri)` (a new load carrying the URI, on any screen), and never
 * falling, also once the account is confirmed and the registry drops its
 * floors. `undefined`: no gate, the slot paints from cache.
 */
export function useSlotFloor(uri: string): number | undefined {
  const did = useCurrentClients()?.did
  const [base] = useState(() => {
    if (!did || isPrismConfirmed(did)) return undefined
    return Math.max(
      floorSince(did) ?? 0,
      gatedAt(did, uri) ?? 0,
      now() - SLOT_JOIN_MS,
    )
  })
  const live = useSyncExternalStore(subscribeRegistry, () =>
    did ? gatedAt(did, uri) : undefined,
  )
  const [highest, setHighest] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (live !== undefined && (highest === undefined || live > highest)) {
      setHighest(live)
    }
  }, [live, highest])
  const floor = maxDefined(base, highest, live)
  const [handle] = useState<SlotHandle>(() => ({floor}))
  useEffect(() => {
    handle.floor = floor
  }, [handle, floor])
  useEffect(() => {
    let handles = mountedSlots.get(uri)
    if (!handles) {
      handles = new Set()
      mountedSlots.set(uri, handles)
    }
    handles.add(handle)
    return () => {
      const current = mountedSlots.get(uri)
      current?.delete(handle)
      if (current?.size === 0) mountedSlots.delete(uri)
    }
  }, [uri, handle])
  return floor
}

/**
 * Whether a quote slot may show content (4.1, BR10-L3): a 2xx that arrived
 * at or after `floor` served it. No floor, no gate.
 */
export function useServedSince(uri: string, floor?: number): boolean {
  const did = useCurrentClients()?.did
  return useSyncExternalStore(subscribeRegistry, () =>
    floor === undefined || !did ? true : servedSince(did, uri, floor),
  )
}
