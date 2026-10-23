/*
 * Restored accounts in a member's Following (refract client design 4.5,
 * `refract-client-feeds.md` 3; RF-B7, built small). `refract.getTimeline`
 * answers the restored posts of accounts the member follows, and the
 * reposts of restored posts by the member and by accounts they follow, as
 * `feedViewPost`s in time order. Stock's timeline drops all of these, so
 * they are merged back in here.
 *
 * - **Who.** `withRefractTimeline` wraps the Following API only, outside the
 *   private merge, and only while Refract is active and prism counts the
 *   reader a member. prism answers visitors `feed: []`, so for them it makes
 *   no call and returns the API as it is.
 * - **Stock never waits (RF-2).** The items live in a per-account store in
 *   memory, pre-warmed at start and on foreground (`RefractHost`). A page
 *   takes what the store holds when the inner page answers. A fetch from the
 *   top starts a head read and never awaits it; what lands late waits for
 *   the next fetch or check.
 * - **Windows.** Each page takes the store items whose time falls in its own
 *   window, deduped by key against its rows, and inserted by time above the
 *   first row older than each (never below the Discover marker). The window
 *   runs from the page's last own row up to the bound the page above handed
 *   on (`uppers`, by cursor; the top page: no bound). A `since` page that
 *   reached the page below starts above the newest row the page it continues
 *   had (`extents`, by the stock `startCursor` inside a private marker). A
 *   window below the store's floor takes what it can and hands the rest on to
 *   the next page, and a read further down starts in the background. Stock
 *   cursors are never changed, except on an empty `since` page that only
 *   carries store items (it echoes `since`, so the check keeps running).
 * - **The peek** reports the newer of the inner peek and the store's newest
 *   item, after the head read or 500 ms, so a restored item on top doesn't
 *   make every check prepend. When public posts already differ it answers at
 *   once, as the private peek does.
 * - **Cleared** on an account switch and on `NotEnabled`.
 *
 * Time is the row's sort time (`feedSortTime`: a repost's `indexedAt`, else
 * the earlier of `createdAt` and `indexedAt`), which is prism's order too.
 * prism applies the member's mutes and blocks to these items itself.
 */

import {FALLBACK_MARKER_POST} from '#/features/followingV2/home/api/home'
import {
  type FeedAPI,
  type FeedAPIResponse,
  type FeedSource,
} from '#/features/followingV2/home/api/types'
import {feedSortTime} from '#/features/followingV2/home/queries/followingSnapshot'
import {decodeMergeStart} from '#/horizon/private/feed/cursor'
import {feedItemKey} from '#/horizon/private/feed/merge-core'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {onRefractNotEnabled, refractCall} from '#/horizon/refract/api'
import {refractActive} from '#/horizon/refract/gate'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {fromRefract} from '#/horizon/refract/marker'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {getMembership} from '#/horizon/routing/membership'
import {type app} from '#/lexicons'

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

/** Items asked per `refract.getTimeline` page. */
export const TIMELINE_PAGE_LIMIT = 50

/** How long a head read is shared. */
export const TIMELINE_HEAD_TTL_MS = 15_000

/** How long the peek waits for the head read past the inner peek. */
export const TIMELINE_PEEK_WAIT_MS = 500

/** A read further down starts when a window comes this close to the floor. */
const FETCH_AHEAD_ITEMS = 10

/** The most bounds kept per registry. */
const REGISTRY_MAX = 500

type Entry = {item: FeedViewPost; key: string; time: number}

type Store = {
  did: string
  entries: Map<string, Entry>
  /** Some answer has landed. */
  loaded: boolean
  /** prism's cursor below what the store holds; none when it holds all. */
  cursor: string | undefined
  /** The time the store covers down to: `-Infinity` once it holds all. */
  floor: number
  head?: {promise: Promise<void>; settledAt?: number}
  ahead?: Promise<void>
  /** The upper bound of a page fetched by each cursor handed back. */
  uppers: Map<string, number>
  /** The lower bound of a `since` page fetched from each start handed back. */
  extents: Map<string, number>
}

let store: Store | undefined

onRefractNotEnabled(() => {
  store = undefined
})

function storeFor(did: string): Store {
  if (store?.did !== did) {
    store = {
      did,
      entries: new Map(),
      loaded: false,
      cursor: undefined,
      floor: Infinity,
      uppers: new Map(),
      extents: new Map(),
    }
  }
  return store
}

/** Test-only: forget the store. */
export function resetRefractTimeline() {
  store = undefined
}

function rowTime(item: FeedViewPost): number {
  const time = feedSortTime(item)
  return Number.isNaN(time) ? 0 : time
}

function isMarker(item: FeedViewPost) {
  return item.post.uri === FALLBACK_MARKER_POST.post.uri
}

/** The registry key of a start: a private marker's stock `startCursor`. */
function boundaryKey(start: string): string {
  try {
    return decodeMergeStart(start)?.pub ?? start
  } catch {
    return start
  }
}

/** Record `value` under `key`, widening: `pick` chooses on a repeat. */
function remember(
  map: Map<string, number>,
  key: string,
  value: number,
  pick: (a: number, b: number) => number,
) {
  const known = map.get(key)
  map.delete(key)
  map.set(key, known === undefined ? value : pick(known, value))
  for (const old of map.keys()) {
    if (map.size <= REGISTRY_MAX) break
    map.delete(old)
  }
}

/** The time in prism's local cursor (`L:<time>::<uri>`). */
function cursorTime(cursor: string): number | undefined {
  if (!cursor.startsWith('L:')) return undefined
  const time = Date.parse(cursor.slice(2).split('::')[0] ?? '')
  return Number.isNaN(time) ? undefined : time
}

type Page = {feed: FeedViewPost[]; cursor: string | undefined}

function floorOf(page: Page): number {
  if (!page.cursor) return -Infinity
  const time = cursorTime(page.cursor)
  if (time !== undefined) return time
  return page.feed.length ? Math.min(...page.feed.map(rowTime)) : Infinity
}

function toEntry(item: FeedViewPost): Entry | undefined {
  if (typeof item?.post?.uri !== 'string') return undefined
  return {item, key: feedItemKey(item), time: rowTime(item)}
}

async function readPage(cursor: string | undefined): Promise<Page> {
  const {body} = await refractCall<{feed?: unknown; cursor?: unknown}>(
    REFRACT_METHODS.getTimeline,
    {limit: TIMELINE_PAGE_LIMIT, cursor},
    {foreground: false, screen: true},
  )
  return {
    feed: Array.isArray(body.feed) ? (body.feed as FeedViewPost[]) : [],
    cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
  }
}

/**
 * Merge a page from the top. A head that reaches what the store holds joins
 * it, and drops what it no longer lists in its span (an unrepost). One that
 * doesn't reach replaces it.
 */
function mergeHead(s: Store, page: Page) {
  const floor = floorOf(page)
  const entries = page.feed.flatMap(item => toEntry(item) ?? [])
  let newest = -Infinity
  for (const entry of s.entries.values()) newest = Math.max(newest, entry.time)
  if (!s.loaded || (floor > newest && s.entries.size > 0)) {
    s.entries = new Map(entries.map(entry => [entry.key, entry]))
    s.cursor = page.cursor
    s.floor = floor
  } else {
    const listed = new Set(entries.map(entry => entry.key))
    for (const [key, entry] of s.entries) {
      if (entry.time >= floor && !listed.has(key)) s.entries.delete(key)
    }
    for (const entry of entries) s.entries.set(entry.key, entry)
    if (floor <= s.floor) {
      s.floor = floor
      s.cursor = page.cursor
    }
  }
  s.loaded = true
}

function readHead(s: Store): Promise<void> {
  const memo = s.head
  if (
    memo &&
    (memo.settledAt === undefined ||
      Date.now() - memo.settledAt < TIMELINE_HEAD_TTL_MS)
  ) {
    return memo.promise
  }
  const entry: {promise: Promise<void>; settledAt?: number} = {
    promise: readPage(undefined).then(page => {
      if (store === s) mergeHead(s, page)
    }),
  }
  entry.promise.then(
    () => {
      entry.settledAt = Date.now()
    },
    () => {
      if (s.head === entry) s.head = undefined
    },
  )
  s.head = entry
  return entry.promise
}

/** Read the next page below the floor, in the background. */
function fetchAhead(s: Store) {
  const cursor = s.cursor
  if (s.ahead || !s.loaded || !cursor) return
  s.ahead = readPage(cursor)
    .then(page => {
      if (store !== s || s.cursor !== cursor) return
      for (const item of page.feed) {
        const entry = toEntry(item)
        if (entry) s.entries.set(entry.key, entry)
      }
      s.cursor = page.cursor
      s.floor = floorOf(page)
    })
    .catch(() => {})
    .finally(() => {
      if (store === s) s.ahead = undefined
    })
}

/** The store items in `(lower, upper]`, newest first. */
function windowOf(s: Store, lower: number, upper: number): Entry[] {
  return Array.from(s.entries.values())
    .filter(entry => entry.time > lower && entry.time <= upper)
    .sort((a, b) => b.time - a.time)
}

/** `items` put into `feed` by time, never below the Discover marker. */
function insertByTime(feed: FeedViewPost[], items: Entry[]): FeedViewPost[] {
  const out = [...feed]
  for (const entry of items) {
    let marker = out.findIndex(isMarker)
    if (marker === -1) marker = out.length
    let at = out.findIndex(
      (row, index) => index < marker && rowTime(row) < entry.time,
    )
    if (at === -1) at = marker
    out.splice(at, 0, entry.item)
  }
  return out
}

type FetchParams = Parameters<FeedAPI['fetch']>[0]

/** `res` with the store items its window holds (the file's "Windows"). */
function place(
  s: Store,
  {cursor, since}: FetchParams,
  res: FeedAPIResponse,
): FeedAPIResponse {
  const markerAt = res.feed.findIndex(isMarker)
  const own = markerAt === -1 ? res.feed : res.feed.slice(0, markerAt)
  const times = own.map(rowTime)
  const ownFirst = times.length ? Math.max(...times) : undefined
  const ownLast = times.length ? Math.min(...times) : undefined
  const ended = !res.cursor || markerAt !== -1
  const covered = !s.loaded ? Infinity : s.cursor ? s.floor : -Infinity

  let lower: number | undefined
  let upper: number
  let handsOn = true
  if (since !== undefined) {
    // The page below is loaded already, so a `since` page hands nothing on.
    handsOn = false
    upper = Infinity
    const exhausted = res.cursor === undefined || res.cursor === since
    lower = exhausted ? (s.extents.get(boundaryKey(since)) ?? ownLast) : ownLast
  } else {
    upper =
      cursor === undefined
        ? Infinity
        : (s.uppers.get(cursor) ?? ownFirst ?? -Infinity)
    lower = ended ? -Infinity : ownLast
  }

  let taken: Entry[] = []
  let handed = lower ?? upper
  if (lower !== undefined) {
    const present = new Set(res.feed.map(feedItemKey))
    taken = windowOf(s, lower, upper).filter(entry => !present.has(entry.key))
    if (handsOn && covered > lower) handed = Math.min(covered, upper)
    const nearFloor =
      covered > lower || windowOf(s, s.floor, lower).length < FETCH_AHEAD_ITEMS
    if (s.cursor && nearFloor) fetchAhead(s)
  }

  let out: FeedAPIResponse = res
  if (taken.length > 0) {
    if (since !== undefined && own.length === 0 && markerAt === -1) {
      // An empty `since` page carries the items, so it is written (3.3).
      out = {
        ...res,
        feed: taken.map(entry => entry.item),
        cursor: res.cursor ?? since,
        startCursor: res.startCursor ?? since,
      }
    } else {
      out = {...res, feed: insertByTime(res.feed, taken)}
    }
  }

  if (out.cursor && out.cursor !== since && !ended) {
    remember(s.uppers, out.cursor, handed, Math.max)
  }
  if (out.startCursor) {
    const rows = out.feed.filter(row => !isMarker(row)).map(rowTime)
    const extent = rows.length ? Math.max(...rows) : lower
    if (extent !== undefined && Number.isFinite(extent)) {
      remember(s.extents, boundaryKey(out.startCursor), extent, Math.min)
    }
  }
  return out
}

function settleWithin(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.catch(() => {}),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

class RefractTimelineFeedAPI implements FeedAPI {
  constructor(
    private readonly inner: FeedAPI,
    private readonly did: string,
  ) {}

  async peekLatest(opts?: {
    source?: FeedSource
    isCurrent?: (item: FeedViewPost) => boolean
  }) {
    if (opts?.source === 'discover') return this.inner.peekLatest(opts)
    const s = storeFor(this.did)
    const head = readHead(s)
    head.catch(() => {})
    const pub = await this.inner.peekLatest(opts)
    if (
      pub &&
      opts?.isCurrent &&
      !opts.isCurrent(pub) &&
      !fromRefract(pub.post) &&
      !isPrivatePostUri(pub.post.uri)
    ) {
      // Public posts already differ, so the check fetches anyway.
      return pub
    }
    await settleWithin(head, TIMELINE_PEEK_WAIT_MS)
    if (store !== s) return pub
    let newest: Entry | undefined
    for (const entry of s.entries.values()) {
      if (!newest || entry.time > newest.time) newest = entry
    }
    if (!newest) return pub
    return !pub || newest.time > rowTime(pub) ? newest.item : pub
  }

  async fetch(params: FetchParams): Promise<FeedAPIResponse> {
    if (params.source === 'discover') return this.inner.fetch(params)
    const s = storeFor(this.did)
    if (params.cursor === undefined && params.since === undefined) {
      // Used if it lands before the inner page; never awaited.
      readHead(s).catch(() => {})
    }
    const res = await this.inner.fetch(params)
    if (store !== s) return res
    return place(s, params, res)
  }
}

/** Whether the signed-in reader's Following gets restored items. */
export function refractTimelineActive(
  did: string | undefined = getCurrentDid(),
): boolean {
  return !!did && refractActive(did) && getMembership(did) === 'member'
}

/**
 * Start a head read for the signed-in member (start and foreground), so the
 * first Following page finds the store warm. Never throws.
 */
export function prewarmRefractTimeline() {
  const did = getCurrentDid()
  if (!did || !refractTimelineActive(did)) return
  readHead(storeFor(did)).catch(() => {})
}

/**
 * The Following API with restored items merged in, for a member while
 * Refract is active; any other feed, or any other reader, as it is.
 */
export function withRefractTimeline(feedDesc: string, api: FeedAPI): FeedAPI {
  if (feedDesc !== 'following') return api
  const did = getCurrentDid()
  if (!did || !refractTimelineActive(did)) return api
  return new RefractTimelineFeedAPI(api, did)
}
