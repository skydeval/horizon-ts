/*
 * The Following merge (6.3): a member's Following is the public AppView's
 * timeline merged by time with prism's private timeline.
 *
 * A two-stream merge on `feed/merge-core.ts`, stateless like every Following
 * v2 feed API: each call decodes the whole merge state from its cursor
 * (`feed/cursor.ts`) and runs one merge step. What is Following's own lives
 * here: the pass-through rules, the Discover fallback marker and its tail, up
 * to three public pages per refill, the private deadline, `startCursor`, and
 * the Discover response.
 *
 * New private posts arrive the way new public ones do (item 7): the first
 * page's `startCursor` is a private marker (`hz1s.`, 3.1), the peek reads
 * prism's head too (3.2), and a `since` fetch from a marker merges the private
 * posts newer than it (3.3).
 */

import {logger} from '#/logger'
import {FALLBACK_MARKER_POST} from '#/features/followingV2/home/api/home'
import {
  type FeedAPI,
  type FeedAPIResponse,
  type FeedSource,
} from '#/features/followingV2/home/api/types'
import {
  type AdaptInput,
  pendingAsInput,
  type PrivateSource,
  toFeedViewPosts,
} from '#/horizon/private/adapt/feed-view'
import {
  type AnswerContext,
  getPrivateTimelineAnswered,
  mergeAnswers,
} from '#/horizon/private/api/reads'
import {
  decodeMergeCursor,
  decodeMergeStart,
  encodeMergeCursor,
  encodeMergeStart,
  initialMergeState,
  isMergeCursor,
  isMergeStart,
  type MergeStart,
  type MergeStartWalk,
  type MergeState,
  PRIVATE_LOOKBACK_MS,
} from '#/horizon/private/feed/cursor'
import {degradedFlags} from '#/horizon/private/feed/degraded'
import {
  compareKeys,
  feedItemKey,
  insertPending,
  itemKey,
  mergeStep,
  privateKey,
  publicKey,
  type SortKey,
  withDeadline,
} from '#/horizon/private/feed/merge-core'
import {
  fetchUntilBoundary,
  fetchUntilItems,
} from '#/horizon/private/feed/paging'
import {isOwnPrivateUri, noteMiss} from '#/horizon/private/known'
import {withPrivateQuotes} from '#/horizon/private/quotes/resolve'
import {getPendingPost, getPendingPosts} from '#/horizon/private/store'
import {getPrismHealth, healthEnvironment} from '#/horizon/routing/health'
import {PRIVATE_READING} from '#/horizon/switches'
import {type app} from '#/lexicons'

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

/**
 * The size of a private timeline page.
 */
export const PRIVATE_PAGE_LIMIT = 30

/**
 * How long the private side may take before the feed continues without it.
 */
export const PRIVATE_DEADLINE_MS = 5_000

/** The size of the private head a check reads (3.2). */
export const PRIVATE_HEAD_LIMIT = 10

/** How many pages of 30 a `since` walk reads below the head (3.3). */
export const PRIVATE_SINCE_MAX_PAGES = 4

/** How long a head read is shared (3.2's coalescing). */
export const PRIVATE_HEAD_TTL_MS = 15_000

/**
 * A first page with no private key starts its marker this far before its
 * fetch (3.1, Q-2).
 */
export const PRIVATE_START_MARGIN_MS = 5 * 60_000

/**
 * How many public pages one call follows when they carry no Following items.
 */
const MAX_PUBLIC_PAGES = 3

function isMarker(item: FeedViewPost) {
  return item.post.uri === FALLBACK_MARKER_POST.post.uri
}

function now() {
  return healthEnvironment().now()
}

function newestKey(keys: Iterable<SortKey>): SortKey | undefined {
  let best: SortKey | undefined
  for (const key of keys) {
    if (!best || compareKeys(key, best) > 0) best = key
  }
  return best
}

function capKey(key: SortKey, at: number): SortKey {
  return key.time > at ? {time: at, uri: key.uri} : key
}

function keyed(input: AdaptInput): [string, number] {
  return [itemKey(input), privateKey(input).time]
}

/*
 * The private head (3.2): one read of prism's newest private items per
 * account, shared while in flight and for PRIVATE_HEAD_TTL_MS after, and the
 * adapted views of its items (`views`), so a check adapts a head item once.
 * Cleared on an account change and by every fetch from the top.
 */

type HeadView = {cid: string; pending: boolean; view: FeedViewPost | 'dropped'}

type Head = {
  items: AdaptInput[]
  cursor: string | undefined
  answers: AnswerContext[]
}

type HeadState = {
  did: string
  memo?: {promise: Promise<Head>; settledAt?: number}
  /** The keys of the current head: the only keys `views` holds. */
  keys: Set<string>
  views: Map<string, HeadView>
}

let headState: HeadState | undefined

function headFor(did: string): HeadState {
  if (headState?.did !== did) {
    headState = {did, keys: new Set(), views: new Map()}
  }
  return headState
}

/** Forget the head read and its views, as a fetch from the top does. */
function clearHead(did: string) {
  headState = {did, keys: new Set(), views: new Map()}
}

/** Forget every head (tests). */
export function resetPrivateHead() {
  headState = undefined
}

/**
 * The private head: `getTimeline` with {@link PRIVATE_HEAD_LIMIT}, a short or
 * empty first page with a cursor followed once. Shared per account while in
 * flight and for {@link PRIVATE_HEAD_TTL_MS} after it lands; a failure is not
 * kept. A read that reaches prism evicts every cached view whose key is not
 * in it (FP3-N6a).
 */
export function readPrivateHead(source: PrivateSource): Promise<Head> {
  const state = headFor(source.did)
  const memo = state.memo
  if (
    memo &&
    (memo.settledAt === undefined ||
      now() - memo.settledAt < PRIVATE_HEAD_TTL_MS)
  ) {
    return memo.promise
  }
  const answers: AnswerContext[] = []
  const read = async (cursor: string | undefined) => {
    const {body, answer} = await getPrivateTimelineAnswered(source.prism, {
      limit: PRIVATE_HEAD_LIMIT,
      cursor,
    })
    answers.push(answer)
    return {items: body.feed.map(view => ({view})), cursor: body.cursor}
  }
  const entry: {promise: Promise<Head>; settledAt?: number} = {
    promise: (async () => {
      const first = await read(undefined)
      let items: AdaptInput[] = first.items
      let cursor = first.cursor
      if (items.length < PRIVATE_HEAD_LIMIT && cursor) {
        const second = await read(cursor)
        items = [...items, ...second.items]
        cursor = second.cursor !== cursor ? second.cursor : undefined
      }
      return {items, cursor, answers}
    })(),
  }
  entry.promise.then(
    head => {
      if (state.memo !== entry) return
      entry.settledAt = now()
      if (headState !== state) return
      state.keys = new Set(head.items.map(itemKey))
      for (const key of Array.from(state.views.keys())) {
        if (!state.keys.has(key)) state.views.delete(key)
      }
    },
    () => {
      if (state.memo === entry) state.memo = undefined
    },
  )
  state.memo = entry
  return entry.promise
}

/**
 * Adapt `inputs` (3.2's view cache): a head item whose cached view has the
 * same `cid` and `pending` is reused (a `dropped` one only by the peek, so a
 * fetch asks again), the rest are adapted in one `toFeedViewPosts` call, or
 * with `wholeBatch` every input is, when any needs it. Only head keys are
 * written. Returns the views by `itemKey`.
 */
async function adaptWithHead(
  source: PrivateSource,
  inputs: AdaptInput[],
  {wholeBatch = false, forPeek = false} = {},
): Promise<Map<string, FeedViewPost>> {
  const state = headFor(source.did)
  const views = new Map<string, FeedViewPost>()
  const need: AdaptInput[] = []
  for (const input of inputs) {
    const key = itemKey(input)
    const entry = state.views.get(key)
    if (
      entry &&
      entry.cid === input.view.cid &&
      entry.pending === !!input.isPending &&
      (entry.view !== 'dropped' || forPeek)
    ) {
      if (entry.view !== 'dropped') views.set(key, entry.view)
    } else {
      need.push(input)
    }
  }
  if (need.length === 0) return views
  const batch = wholeBatch ? inputs : need
  const adapted = await toFeedViewPosts(batch, {
    prism: source.prism,
    appview: source.appview,
  })
  const byKey = new Map(adapted.map(item => [feedItemKey(item), item]))
  for (const input of batch) {
    const key = itemKey(input)
    const view = byKey.get(key)
    if (view) views.set(key, view)
    if (headState === state && state.keys.has(key)) {
      state.views.set(key, {
        cid: input.view.cid,
        pending: !!input.isPending,
        view: view ?? 'dropped',
      })
    }
  }
  return views
}

async function adaptInOrder(source: PrivateSource, inputs: AdaptInput[]) {
  const views = await adaptWithHead(source, inputs)
  return inputs.flatMap(input => {
    const view = views.get(itemKey(input))
    return view ? [view] : []
  })
}

/*
 * The first page's marker (3.1): every private input fetched, pending posts
 * included, emitted or not, is in `seen`; `priv` is the newest, capped at the
 * fetch time; `floor` is ten minutes below it, raised to the oldest key read
 * when the read stopped with a cursor. With no private key read, `priv` is
 * the newer of the newest pending post and five minutes before the fetch.
 */
function firstMarker({
  pub,
  inputs,
  read,
  readCursor,
  failed,
  fetchedAt,
}: {
  pub: string
  inputs: AdaptInput[]
  read: AdaptInput[]
  readCursor: string | undefined
  failed: boolean
  fetchedAt: number
}): MergeStart {
  let priv: SortKey
  if (failed || read.length === 0) {
    const pending = newestKey(
      inputs.filter(input => input.isPending).map(privateKey),
    )
    const margin = {time: fetchedAt - PRIVATE_START_MARGIN_MS, uri: ''}
    const capped = pending && capKey(pending, fetchedAt)
    priv = capped && compareKeys(capped, margin) > 0 ? capped : margin
  } else {
    priv = capKey(newestKey(inputs.map(privateKey))!, fetchedAt)
  }
  let floor = priv.time - PRIVATE_LOOKBACK_MS
  if (!failed && readCursor && read.length > 0) {
    const oldest = read.reduce(
      (low, input) => Math.min(low, privateKey(input).time),
      Infinity,
    )
    floor = Math.max(floor, oldest)
  }
  return {pub, priv, floor, seen: inputs.map(keyed)}
}

type Walk = {
  items: AdaptInput[]
  cursor: string | undefined
  /** It covered everything above `floor` (or the whole list). */
  reached: boolean
  answers: AnswerContext[]
}

/**
 * A feed API with merge cursors kept out (3.1's stock boundary): a fetch with
 * an `hz1.` or `hz1s.` cursor or `since` is rejected with no request, so one
 * never reaches the AppView.
 */
export function rejectMergeCursors(api: FeedAPI): FeedAPI {
  const isOurs = (value: string | undefined) =>
    isMergeCursor(value) || isMergeStart(value)
  return new Proxy(api, {
    get(target, prop) {
      if (prop === 'fetch') {
        return (params: Parameters<FeedAPI['fetch']>[0]) =>
          isOurs(params.cursor) || isOurs(params.since)
            ? Promise.reject(
                new Error('A merge cursor never goes to the stock feed'),
              )
            : target.fetch(params)
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

class PrivateTimelineFeedAPI implements FeedAPI {
  private stock: FeedAPI

  constructor(
    stock: FeedAPI,
    private source: PrivateSource,
  ) {
    this.stock = rejectMergeCursors(stock)
  }

  /*
   * The merged peek (3.2): the newest of the stock peek, the private head's
   * newest item the adapter keeps, and the newest pending post. With
   * `isCurrent` false for the stock peek, public posts already differ and it
   * is returned at once. A private failure or the deadline gives the newer of
   * the other two.
   */
  async peekLatest(opts?: {
    source?: FeedSource
    isCurrent?: (item: FeedViewPost) => boolean
  }) {
    if (opts?.source === 'discover') return this.stock.peekLatest(opts)
    const stockPeek = this.stock.peekLatest({source: opts?.source})
    const privatePeek = this.peekPrivate()
    const pub = await stockPeek
    if (pub && opts?.isCurrent && !opts.isCurrent(pub)) return pub
    const candidates: {item: FeedViewPost; key: SortKey}[] = []
    if (pub) candidates.push({item: pub, key: publicKey(pub)})
    const priv = await privatePeek
    if (priv) candidates.push(priv)
    const pending = getPendingPosts()
      .map(entry => ({
        item: entry.feedItem,
        key: privateKey(pendingAsInput(entry)),
      }))
      .reduce<{item: FeedViewPost; key: SortKey} | undefined>(
        (best, next) =>
          !best || compareKeys(next.key, best.key) > 0 ? next : best,
        undefined,
      )
    if (pending) candidates.push(pending)
    // Public first on a tie, as the merge orders them.
    let best: {item: FeedViewPost; key: SortKey} | undefined
    for (const candidate of candidates) {
      if (!best || compareKeys(candidate.key, best.key) > 0) best = candidate
    }
    return best?.item
  }

  private async peekPrivate() {
    try {
      return await withDeadline(
        (async () => {
          const head = await readPrivateHead(this.source)
          const views = await adaptWithHead(this.source, head.items, {
            wholeBatch: true,
            forPeek: true,
          })
          const ordered = [...head.items].sort((a, b) =>
            compareKeys(privateKey(b), privateKey(a)),
          )
          for (const input of ordered) {
            const view = views.get(itemKey(input))
            if (view) return {item: view, key: privateKey(input)}
          }
          return undefined
        })(),
        PRIVATE_DEADLINE_MS,
      )
    } catch (error) {
      logger.warn('private head unavailable; the peek reads public posts', {
        safeMessage: error,
      })
      return undefined
    }
  }

  async fetch(params: {
    cursor: string | undefined
    since?: string
    source?: FeedSource
    limit: number
    signal?: AbortSignal
  }): Promise<FeedAPIResponse> {
    const {since, source, limit, signal} = params
    // A startCursor misused as a cursor reads as its stock one (3.1, a guard).
    const cursor = isMergeStart(params.cursor)
      ? decodeMergeStart(params.cursor)?.pub
      : params.cursor
    if (since !== undefined && source !== 'discover') {
      const start = decodeMergeStart(since)
      if (start) return this.fetchSince(start, since, {limit, signal})
    }
    if (
      since !== undefined ||
      source === 'discover' ||
      (cursor !== undefined && !isMergeCursor(cursor))
    ) {
      return this.stock.fetch({...params, cursor})
    }
    const isFirst = cursor === undefined
    const state: MergeState = isFirst
      ? initialMergeState()
      : decodeMergeCursor(cursor)
    const fetchedAt = now()
    // Any fetch from the top clears the head and its views (FP3-N6d).
    if (isFirst) clearHead(this.source.did)

    let startCursor: string | undefined
    // The private side's answers, and whether its refill failed or was skipped (6.5).
    const answers: AnswerContext[] = []
    let incomplete = state.priv.failed
    // What the first page read, for its marker (3.1).
    let read: AdaptInput[] = []
    let readCursor: string | undefined
    let inputs: AdaptInput[] = []
    const refillPublic = async () => {
      const pub = state.pub
      if (pub.buf.length > 0 || pub.done) return
      for (let page = 0; page < MAX_PUBLIC_PAGES; page++) {
        const res = await this.stock.fetch({
          cursor: pub.cursor ?? undefined,
          limit,
          signal,
        })
        if (isFirst && page === 0) startCursor = res.startCursor
        const marker = res.feed.findIndex(isMarker)
        if (marker !== -1) {
          pub.buf.push(...res.feed.slice(0, marker))
          state.tail = {feed: res.feed.slice(marker), cursor: res.cursor}
          pub.done = true
          return
        }
        pub.buf.push(...res.feed)
        pub.cursor = res.cursor ?? null
        if (!res.cursor) {
          pub.done = true
          return
        }
        if (pub.buf.length > 0) return
      }
    }
    const refillPrivate = async () => {
      const priv = state.priv
      if (priv.buf.length === 0 && !priv.done && !priv.failed) {
        try {
          // A short or empty page with a cursor is followed (feed/paging.ts).
          const page = await withDeadline(
            fetchUntilItems(async pageCursor => {
              const {body: res, answer} = await getPrivateTimelineAnswered(
                this.source.prism,
                {limit: PRIVATE_PAGE_LIMIT, cursor: pageCursor},
              )
              answers.push(answer)
              return {items: res.feed, cursor: res.cursor}
            }, priv.cursor ?? undefined),
            PRIVATE_DEADLINE_MS,
          )
          read = page.items.map(view => ({view}))
          readCursor = page.cursor
          priv.buf.push(...read)
          priv.cursor = page.cursor ?? null
          priv.done = !page.cursor
        } catch (error) {
          /*
           * The feed continues public-only until it is refreshed from the
           * top; buffered private items are still emitted.
           */
          priv.failed = true
          incomplete = true
          logger.warn('private timeline unavailable; Following continues', {
            safeMessage: error,
          })
        }
      }
      if (isFirst) {
        insertPending(priv.buf, getPendingPosts())
        inputs = [...priv.buf]
        // The first page's adapt writes the views of what heads it (3.2).
        headFor(this.source.did).keys = new Set(
          read.slice(0, PRIVATE_HEAD_LIMIT).map(itemKey),
        )
      }
    }

    const {feed, drained} = await mergeStep(
      state,
      {refillPublic, refillPrivate},
      {adapt: batch => adaptInOrder(this.source, batch)},
    )

    if (isFirst && startCursor !== undefined) {
      startCursor = encodeMergeStart(
        firstMarker({
          pub: startCursor,
          inputs,
          read,
          readCursor,
          failed: state.priv.failed,
          fetchedAt,
        }),
      )
    }

    // A degraded page is marked so (6.5); the flag never reaches the tuners.
    const flags = degradedFlags(answers, incomplete)
    if (drained) {
      if (state.tail) {
        return {
          feed: [...feed, ...state.tail.feed],
          cursor: state.tail.cursor,
          startCursor,
          source: 'discover',
          ...flags,
        }
      }
      return {feed, cursor: undefined, startCursor, ...flags}
    }
    return {feed, cursor: encodeMergeCursor(state), startCursor, ...flags}
  }

  /** The private walk of a `since` fetch (3.3 step 1). */
  private async walk(isAboveFloor: (input: AdaptInput) => boolean) {
    const head = await readPrivateHead(this.source)
    const answers = [...head.answers]
    const items = [...head.items]
    let cursor = head.cursor
    let reached = !cursor || !head.items.every(isAboveFloor)
    if (!reached) {
      const rest = await fetchUntilBoundary(
        async pageCursor => {
          const {body, answer} = await getPrivateTimelineAnswered(
            this.source.prism,
            {limit: PRIVATE_PAGE_LIMIT, cursor: pageCursor},
          )
          answers.push(answer)
          return {
            items: body.feed.map(view => ({view})),
            cursor: body.cursor,
          }
        },
        isAboveFloor,
        PRIVATE_SINCE_MAX_PAGES,
        cursor,
      )
      items.push(...rest.items)
      cursor = rest.cursor
      reached = rest.reached
    }
    return {items, cursor, reached, answers} satisfies Walk
  }

  /**
   * A `since` fetch from a private marker (3.3): the public posts newer than
   * the marker's stock `startCursor` merged with the private posts it offers.
   * The cursor echoes `since` when both sides are exhausted, else it is a
   * merge cursor into the gap. The `startCursor` is the next marker; a since
   * answer never carries `privateDegraded` (S1).
   */
  private async fetchSince(
    start: MergeStart,
    since: string,
    {limit, signal}: {limit: number; signal?: AbortSignal},
  ): Promise<FeedAPIResponse> {
    const fetchedAt = now()
    const did = this.source.did
    const isAboveFloor = (input: AdaptInput) =>
      privateKey(input).time > start.floor
    // While health's `retryAt` is ahead, no private call (3.5).
    const skip = getPrismHealth(did).retryAt > fetchedAt
    const walking: Promise<Walk | undefined> = skip
      ? Promise.resolve(undefined)
      : withDeadline(this.walk(isAboveFloor), PRIVATE_DEADLINE_MS).catch(
          (error: unknown) => {
            logger.warn('private timeline unavailable; new posts are public', {
              safeMessage: error,
            })
            return undefined
          },
        )
    const [res, walk] = await Promise.all([
      this.stock.fetch({cursor: undefined, since: start.pub, limit, signal}),
      walking,
    ])

    const answer = walk?.answers.length ? mergeAnswers(walk.answers) : undefined
    const seen = new Map(start.seen)
    const fetched = walk?.items ?? []
    const fetchedKeys = new Set(fetched.map(itemKey))
    const low = walk?.reached
      ? undefined
      : fetched.reduce<number | undefined>(
          (min, input) => Math.min(min ?? Infinity, privateKey(input).time),
          undefined,
        )

    // 3. Misses: seen keys inside the span the walk covered that it left out.
    const real = new Set<string>()
    let suspect = false
    if (walk && answer) {
      const listed = new Set<string>(answer.unavailable.map(item => item.uri))
      for (const [key, time] of start.seen) {
        if (fetchedKeys.has(key) || key.includes('|')) continue
        if (low !== undefined && time < low) continue
        // prism may not have indexed a post still pending.
        if (getPendingPost(key, did)) continue
        const inList = listed.has(key)
        const verdict = noteMiss(answer, key, {
          signalled: answer.degraded || inList,
          retryAfterMs: answer.retryAfterMs,
          skipPdsCheck: inList && isOwnPrivateUri(key, did),
        })
        if (verdict === 'suspect') suspect = true
        else if (verdict === 'real') real.add(key)
      }
    }
    // 4. Degraded.
    const degraded = !walk || !!answer?.degraded || suspect

    // 2. Candidates: what the marker offers, and pending posts above `floor`.
    const offered = (key: string, time: number) =>
      time > start.floor && !seen.has(key)
    const candidates = fetched.filter(input => {
      const [key, time] = keyed(input)
      return offered(key, time)
    })
    insertPending(
      candidates,
      getPendingPosts().filter(entry => {
        const [key, time] = keyed(pendingAsInput(entry))
        return offered(key, time)
      }),
    )
    const candidateKeys = new Set(candidates.map(itemKey))

    // 5. Merge: one step with no-op refills.
    const state = initialMergeState()
    const pubExhausted = res.cursor === undefined || res.cursor === start.pub
    state.pub.buf = [...res.feed]
    state.pub.done = pubExhausted
    state.pub.cursor = pubExhausted ? null : (res.cursor ?? null)
    state.priv.buf = [...candidates]
    state.priv.failed = !walk
    state.priv.done = !walk || walk.reached
    const noRefill = async () => {}
    const {feed, drained} = await mergeStep(
      state,
      {refillPublic: noRefill, refillPrivate: noRefill},
      {adapt: batch => adaptInOrder(this.source, batch)},
    )
    const left = new Set(state.priv.buf.map(itemKey))
    const emitted = candidates.filter(input => !left.has(itemKey(input)))

    // 6. The cursor: the echo, or a merge cursor into the gap.
    let cursor: string
    if (drained) {
      cursor = since
    } else {
      if (state.pub.done) {
        // It reached its boundary: it continues from `pub` (FP3-N9).
        state.pub.done = false
        state.pub.cursor = start.pub
        state.resumesAtBoundary = true
      }
      const emittedKeys = new Set(emitted.map(itemKey))
      const rest = [
        ...state.priv.buf,
        ...fetched.filter(input => {
          const key = itemKey(input)
          return !candidateKeys.has(key) && !emittedKeys.has(key)
        }),
      ].sort((a, b) => compareKeys(privateKey(b), privateKey(a)))
      state.priv.buf = rest
      state.priv.cursor = walk?.cursor ?? null
      state.priv.done = !!walk && !walk.cursor
      // A degraded walk's fill below is public-only (busy 6.4).
      state.priv.failed = degraded
      cursor = encodeMergeCursor(state)
    }

    // 7. The next marker.
    const walkNote: MergeStartWalk = {
      outcome: !walk ? 'none' : degraded ? 'degraded' : 'answered',
      did: answer?.did || did,
      seq: answer?.seq ?? 0,
      ...(low !== undefined ? {low} : {}),
      ...(answer?.unavailable.length
        ? {unavailable: answer.unavailable.map(item => item.uri)}
        : {}),
      ...(answer?.degraded ? {signalled: true as const} : {}),
    }
    const kept = start.seen.filter(([key]) => !real.has(key))
    const pub = res.startCursor ?? start.pub
    let next: MergeStart
    if (!degraded) {
      const all = [...fetched, ...candidates.filter(input => input.isPending)]
      const newest = newestKey(all.map(privateKey))
      const capped = newest && capKey(newest, fetchedAt)
      const priv =
        capped && compareKeys(capped, start.priv) > 0 ? capped : start.priv
      next = {
        pub,
        priv,
        floor: Math.max(start.floor, priv.time - PRIVATE_LOOKBACK_MS),
        seen: dedupeSeen([...kept, ...all.map(keyed)]),
        walk: walkNote,
      }
    } else {
      next = {
        pub,
        priv: start.priv,
        floor: start.floor,
        seen: dedupeSeen([...kept, ...emitted.map(keyed)]),
        held: true,
        walk: walkNote,
      }
    }
    return {feed, cursor, startCursor: encodeMergeStart(next)}
  }
}

function dedupeSeen(seen: [string, number][]): [string, number][] {
  const byKey = new Map<string, number>()
  for (const [key, time] of seen) byKey.set(key, time)
  return Array.from(byKey)
}

/**
 * The Following feed API with the member's private timeline merged in. With
 * `PRIVATE_READING` and a private source (a member whose clients are
 * current), every feed's pages, Following's or another's, also come back
 * with the private posts they quote resolved (`quotes/resolve.ts`).
 * Otherwise the stock API, with merge cursors kept from it.
 */
export function withPrivateTimeline(
  feedDesc: string,
  source: PrivateSource | undefined,
  api: FeedAPI,
): FeedAPI {
  if (!PRIVATE_READING || !source) return rejectMergeCursors(api)
  return withPrivateQuotes(
    feedDesc === 'following'
      ? new PrivateTimelineFeedAPI(api, source)
      : rejectMergeCursors(api),
  )
}

export type {MergeState}
