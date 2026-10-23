/*
 * The carry (prism busy design 6.4, 6.5; item 7's 3.4 builds on it). A
 * degraded top page written from the top takes back the reader's own private
 * posts the pages it replaces showed inside its span, so an own post prism
 * left out for now stays, labelled "Syncing". Another author's post is never
 * carried (BR-5, decision 3: no copy prism did not serve on this answer),
 * except by item 7's fill whose private read got no answer (`include:
 * 'all'`), which keeps what the reader saw as BR-4 keeps data through a
 * failure.
 *
 * Every carried row is tagged with its source page's stamp
 * (`horizonFromCache: <fetchedAt>`), which the load gate reads before its
 * page's (BR11-N5): a carried row is as old as the page it came from.
 */

import {type QueryClient, type QueryKey} from '@tanstack/react-query'

import {feedSortTime} from '#/features/followingV2/home/queries/followingSnapshot'
import {
  decodeMergeCursor,
  decodeMergeStart,
  encodeMergeStart,
  isMergeCursor,
  type MergeStart,
  type MergeStartWalk,
  resumesAtBoundary,
} from '#/horizon/private/feed/cursor'
import {
  type PrivateAnswerNote,
  type PrivateDegradedFlags,
} from '#/horizon/private/feed/degraded'
import {
  compareKeys,
  feedItemKey,
  publicKey,
  type SortKey,
} from '#/horizon/private/feed/merge-core'
import {isOwnAbsent, isOwnPrivateUri, noteMiss} from '#/horizon/private/known'
import {getPendingPost} from '#/horizon/private/store'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

/** A page the carry reads rows from: its items and its completion stamp. */
export type CarrySourcePage = {
  feed: readonly FeedViewPost[]
  fetchedAt?: number
}

export type CarryOptions = {
  /** The reader (default: the published account). */
  did?: string
  /**
   * `own` (design 6.4): the reader's own private rows only. `all`: every
   * private row, for a fill whose private read got no answer (item 7 3.4).
   */
  include?: 'own' | 'all'
  /**
   * The new page is the top of the list: its span has no upper bound, so an
   * own post newer than everything it holds is carried too.
   */
  top?: boolean
  /** The new page's answer, against which its own misses are judged. */
  answer?: PrivateAnswerNote
}

/** A row's time in the list: a repost's, else the post's `indexedAt`. */
export function feedItemTime(item: FeedViewPost): SortKey {
  return publicKey(item)
}

/** The stamp a carried row keeps: its own, else its source page's. */
function carriedStamp(item: FeedViewPost, page: CarrySourcePage) {
  const own = (item.post as {horizonFromCache?: unknown}).horizonFromCache
  return typeof own === 'number' ? own : page.fetchedAt
}

/** A reply context's post view tagged with `stamp`; anything else as it is. */
function taggedRef<R>(ref: R, stamp: number): R {
  if (
    typeof ref !== 'object' ||
    ref === null ||
    typeof (ref as {uri?: unknown}).uri !== 'string' ||
    typeof (ref as {author?: unknown}).author !== 'object'
  ) {
    return ref
  }
  return {...ref, horizonFromCache: stamp}
}

/**
 * `item` tagged as carried from a page stamped `stamp`: its post and the
 * reply context it shows, so a carried own reply never makes another
 * author's parent count as fetched with the new page.
 */
function tagged(item: FeedViewPost, stamp: number | undefined): FeedViewPost {
  if (stamp === undefined) return item
  return {
    ...item,
    post: {...item.post, horizonFromCache: stamp} as FeedViewPost['post'],
    ...(item.reply
      ? {
          reply: {
            ...item.reply,
            parent: taggedRef(item.reply.parent, stamp),
            root: taggedRef(item.reply.root, stamp),
          },
        }
      : {}),
  }
}

/**
 * `page` with the private rows of `previousPages` it should carry put back in
 * order (design 6.4): inside the new page's span (from its oldest row, or
 * without a lower bound when it has no cursor, up to its newest, or without
 * an upper bound at the top), not already on it, and for `own` rows not gone
 * from the reader's PDS. Each own row carried is a miss of the new page's
 * answer, `signalled` (its page is degraded), so it is labelled "Syncing"; one
 * prism did not list in `unavailable[]` gets one PDS check, after paint.
 * Nothing is carried into a page that is not degraded: callers ask only then.
 */
export function carryOwnPrivateItems<
  T extends {feed: FeedViewPost[]; cursor?: string},
>(
  previousPages: readonly CarrySourcePage[] | undefined,
  page: T,
  {
    did = getCurrentDid(),
    include = 'own',
    top = false,
    answer,
  }: CarryOptions = {},
): T {
  if (!did || !previousPages?.length) return page
  const keys = page.feed.map(feedItemTime)
  const newest = keys.reduce<SortKey | undefined>(
    (best, key) => (!best || compareKeys(key, best) > 0 ? key : best),
    undefined,
  )
  const oldest = keys.reduce<SortKey | undefined>(
    (worst, key) => (!worst || compareKeys(key, worst) < 0 ? key : worst),
    undefined,
  )
  if (!top && !newest) return page
  const inSpan = (key: SortKey) => {
    if (page.cursor !== undefined) {
      if (!oldest || compareKeys(key, oldest) < 0) return false
    }
    if (!top && newest && compareKeys(key, newest) > 0) return false
    return true
  }

  const present = new Set(page.feed.map(feedItemKey))
  const carried: FeedViewPost[] = []
  for (const source of previousPages) {
    for (const item of source.feed) {
      const uri = item.post.uri
      if (!isPrivatePostUri(uri)) continue
      const own = isOwnPrivateUri(uri, did)
      if (include === 'own' && !own) continue
      if (own && isOwnAbsent(did, uri)) continue
      const key = feedItemKey(item)
      if (present.has(key) || !inSpan(feedItemTime(item))) continue
      present.add(key)
      carried.push(tagged(item, carriedStamp(item, source)))
    }
  }
  if (carried.length === 0) return page

  if (answer) {
    const listed = new Set(answer.unavailable)
    for (const item of carried) {
      const uri = item.post.uri
      if (!isOwnPrivateUri(uri, did)) continue
      noteMiss(answer, uri, {signalled: true, skipPdsCheck: listed.has(uri)})
    }
  }

  const feed = [...page.feed]
  for (const item of carried) {
    const key = feedItemTime(item)
    const at = feed.findIndex(
      other => compareKeys(key, feedItemTime(other)) > 0,
    )
    if (at === -1) feed.push(item)
    else feed.splice(at, 0, item)
  }
  return {...page, feed}
}

/**
 * A feed query's page as the query writes it (6.4): a degraded page fetched
 * from the top (no `pageParam`) takes back the reader's own private rows the
 * pages it replaces showed inside its span (`carry.ts`); any other page is
 * returned as it is.
 */
export function carryTopFeedPage<
  T extends {feed: FeedViewPost[]; cursor?: string} & PrivateDegradedFlags,
>(
  context: {pageParam?: unknown; queryKey: QueryKey; client?: QueryClient},
  page: T,
): T {
  if (context.pageParam !== undefined || !page.privateDegraded) return page
  const before = context.client?.getQueryData<{pages: CarrySourcePage[]}>(
    context.queryKey,
  )
  return carryOwnPrivateItems(before?.pages, page, {
    top: true,
    answer: page.privateAnswer,
  })
}

/*
 * Item 7 (3.4): the prepend's replacement of a staged page, and the boundary
 * carry of a gap fill and a settle. The fork stays cursor-blind: its hooks
 * call these.
 */

/** A page as the prepend stages it: its rows, marker, `since` and stamp. */
export type StagedSourcePage = {
  feed: FeedViewPost[]
  startCursor?: string
  since?: string
  fetchedAt: number
}

/** What {@link judgeStaged} decided about a staged page's private rows. */
export type StagedJudgement<T extends StagedSourcePage> = {
  /**
   * The staged page without the rows dropped, its marker without their keys
   * (and held after a degraded walk or none). The page itself when nothing
   * was dropped.
   */
  kept: T
  /** Rows the replacement should carry, from the staged page. */
  carry: FeedViewPost[]
  /** Whether any row was dropped. */
  dropped: boolean
  /** Keys of the rows dropped. */
  droppedKeys: string[]
  /** An own row left out by an answer was carried: the marker holds. */
  hold: boolean
  /** The staged page's stamp, for the rows it carries. */
  stamp: number
  /** The marker the staged page was fetched from. */
  since?: MergeStart
}

/**
 * Where a private row sits in prism's order: a repost's time, else its
 * record's `createdAt` (as `privateKey`), else its `indexedAt`.
 */
function rowTime(item: FeedViewPost): number {
  const reason = item.reason as {indexedAt?: unknown} | undefined
  if (typeof reason?.indexedAt === 'string') return Date.parse(reason.indexedAt)
  const created = (item.post.record as {createdAt?: unknown}).createdAt
  const parsed = typeof created === 'string' ? Date.parse(created) : NaN
  return Number.isNaN(parsed) ? Date.parse(item.post.indexedAt) : parsed
}

/** `start` without `keys` in `seen`, held at `since`'s `priv` and `floor` when `hold`. */
function rewriteMarker(
  start: MergeStart,
  {
    drop = [],
    add = [],
    hold,
    since,
  }: {
    drop?: readonly string[]
    add?: readonly [string, number][]
    hold: boolean
    since?: MergeStart
  },
): MergeStart {
  const dropped = new Set(drop)
  const seen = new Map(start.seen.filter(([key]) => !dropped.has(key)))
  for (const [key, time] of add) seen.set(key, time)
  return {
    ...start,
    seen: Array.from(seen),
    ...(hold && since
      ? {priv: since.priv, floor: since.floor, held: true as const}
      : {}),
  }
}

/**
 * Judge the staged page's private rows against the replacement `page`
 * fetched from the same `since` (3.4, busy BR9-L1, BR10-L5), before either of
 * the prepend's early exits. A row the replacement has is left alone. Of the
 * rest:
 *
 * - after a walk with no answer (failed, timed out or skipped): the reader's
 *   own rows are carried, with no `noteMiss`; another author's are dropped;
 * - after an answer that covered the row's time: each goes to `noteMiss`
 *   once. The reader's own row is carried while `suspect` (the marker then
 *   holds) and dropped once `real`; another author's is dropped whatever the
 *   verdict. A row below the span the walk covered stays (the page is full);
 * - an own row still pending is carried with no `noteMiss`: prism may not
 *   have it yet.
 *
 * Nothing is judged without a walk note in `page`'s marker (a plain `since`).
 */
export function judgeStaged<T extends StagedSourcePage>(
  staged: T,
  page: {feed: readonly FeedViewPost[]; startCursor?: string},
  {did = getCurrentDid()}: {did?: string} = {},
): StagedJudgement<T> {
  const nothing: StagedJudgement<T> = {
    kept: staged,
    carry: [],
    dropped: false,
    droppedKeys: [],
    hold: false,
    stamp: staged.fetchedAt,
  }
  const walk: MergeStartWalk | undefined = decodeMergeStart(
    page.startCursor,
  )?.walk
  const since = decodeMergeStart(staged.since)
  if (!did || !walk || !since) return nothing
  const present = new Set(page.feed.map(feedItemKey))
  const listed = new Set(walk.unavailable ?? [])
  const answer = {did: walk.did, seq: walk.seq}
  const carry: FeedViewPost[] = []
  const droppedKeys: string[] = []
  let hold = false
  for (const item of staged.feed) {
    const uri = item.post.uri
    if (!isPrivatePostUri(uri)) continue
    const key = feedItemKey(item)
    if (present.has(key)) continue
    const own = key === uri && isOwnPrivateUri(uri, did)
    if (walk.outcome === 'none') {
      if (own && !isOwnAbsent(did, uri)) carry.push(item)
      else droppedKeys.push(key)
      continue
    }
    if (walk.low !== undefined && rowTime(item) < walk.low) continue
    if (own && getPendingPost(uri, did)) {
      carry.push(item)
      continue
    }
    const verdict =
      key === uri
        ? noteMiss(answer, uri, {
            signalled: !!walk.signalled || listed.has(uri),
            skipPdsCheck: own && listed.has(uri),
          })
        : 'unknown'
    if (own && verdict !== 'real') {
      carry.push(item)
      hold = true
    } else {
      droppedKeys.push(key)
    }
  }
  if (droppedKeys.length === 0) {
    return {...nothing, carry, hold, since}
  }
  const dropping = new Set(droppedKeys)
  const marker = decodeMergeStart(staged.startCursor)
  const kept: T = {
    ...staged,
    feed: staged.feed.filter(item => !dropping.has(feedItemKey(item))),
    ...(marker
      ? {
          startCursor: encodeMergeStart(
            rewriteMarker(marker, {
              drop: droppedKeys,
              hold: walk.outcome !== 'answered',
              since,
            }),
          ),
        }
      : {}),
  }
  return {
    kept,
    carry,
    dropped: true,
    droppedKeys,
    hold,
    stamp: staged.fetchedAt,
    since,
  }
}

/**
 * `page`, the replacement of a staged page, with the rows `judged` kept for
 * carrying that it lacks put back in order, tagged with the staged page's
 * stamp as `carryOwnPrivateItems` tags them (3.4). Their keys join its
 * marker's `seen` and the dropped keys leave it; an own row carried after an
 * answer holds the marker at the `since` it was fetched from.
 */
export function carryStagedPrivate<
  T extends {feed: FeedViewPost[]; startCursor?: string},
>(judged: StagedJudgement<StagedSourcePage> | undefined, page: T): T {
  if (!judged || (judged.carry.length === 0 && !judged.dropped)) return page
  const present = new Set(page.feed.map(feedItemKey))
  const feed = [...page.feed]
  const added: [string, number][] = []
  for (const item of judged.carry) {
    const key = feedItemKey(item)
    if (present.has(key)) continue
    present.add(key)
    added.push([key, rowTime(item)])
    const row = tagged(
      item,
      carriedStamp(item, {feed: [], fetchedAt: judged.stamp}),
    )
    const time = feedItemTime(row)
    const at = feed.findIndex(
      other => compareKeys(time, feedItemTime(other)) > 0,
    )
    if (at === -1) feed.push(row)
    else feed.splice(at, 0, row)
  }
  const marker = decodeMergeStart(page.startCursor)
  if (!marker) return {...page, feed}
  return {
    ...page,
    feed,
    startCursor: encodeMergeStart(
      rewriteMarker(marker, {
        drop: judged.droppedKeys,
        add: added,
        hold: judged.hold,
        since: judged.since,
      }),
    ),
  }
}

/**
 * The newest public row loaded: the first public row of the first page, top
 * down, that has one (3.2, FP3-N3), for the merged peek's `isCurrent`.
 */
export function newestPublicRow(
  pages: readonly {feed: readonly FeedViewPost[]}[],
): FeedViewPost | undefined {
  for (const page of pages) {
    const row = page.feed.find(item => !isPrivatePostUri(item.post.uri))
    if (row) return row
  }
  return undefined
}

/** The leading run of `rows` sharing the first row's sort time. */
function boundaryRun(rows: readonly FeedViewPost[]): FeedViewPost[] {
  if (rows.length === 0) return []
  const boundary = feedSortTime(rows[0])
  let end = 1
  while (end < rows.length && feedSortTime(rows[end]) === boundary) end++
  return rows.slice(0, end)
}

/**
 * `upper` with the public posts at `lower`'s boundary carried in, when
 * `cursor` (the merge cursor into the gap) carries `resumesAtBoundary`
 * (3.4, FP3-N9): the public side resumed from `lower`'s `startCursor`, which
 * the AppView bounds on sort time alone, so those posts were skipped. They
 * are `lower`'s first public post and the ones after it with the same sort
 * time; with no public post in `lower`, the leading run of its cursor's
 * public buffer. They go in merge order, at the bottom when `upper` ends
 * above them. `upper` itself when there is nothing to carry.
 */
export function carryGapBoundary<T extends {feed: FeedViewPost[]}>(
  cursor: string | undefined,
  upper: T,
  lower: {feed: readonly FeedViewPost[]; cursor?: string} | undefined,
): T {
  if (!lower || !resumesAtBoundary(cursor)) return upper
  const publicRows = lower.feed.filter(item => !isPrivatePostUri(item.post.uri))
  let run: FeedViewPost[] = boundaryRun(publicRows)
  if (publicRows.length === 0) {
    if (!isMergeCursor(lower.cursor)) return upper
    try {
      run = boundaryRun(decodeMergeCursor(lower.cursor).pub.buf)
    } catch {
      return upper
    }
  }
  const present = new Set(upper.feed.map(feedItemKey))
  const carried = run.filter(item => !present.has(feedItemKey(item)))
  if (carried.length === 0) return upper
  // The run keeps the AppView's order, placed by its first post.
  const time = feedItemTime(carried[0])
  const feed = [...upper.feed]
  const at = feed.findIndex(other => compareKeys(time, feedItemTime(other)) > 0)
  feed.splice(at === -1 ? feed.length : at, 0, ...carried)
  return {...upper, feed}
}

/**
 * A gap fill's page as the fill writes it (3.4): the boundary carry, then,
 * when the page is degraded, busy's carry of the rows it replaces inside its
 * span: the reader's own after an answer, every private row when the fill's
 * private read got no answer.
 */
export function carryFillPage<
  T extends {feed: FeedViewPost[]; cursor?: string} & PrivateDegradedFlags,
>(
  cursor: string,
  page: T,
  replaced: readonly (CarrySourcePage & {cursor?: string})[],
): T {
  const next = carryGapBoundary(cursor, page, replaced[0])
  if (!next.privateDegraded) return next
  return carryOwnPrivateItems(replaced, next, {
    include: next.privateAnswer ? 'own' : 'all',
    answer: next.privateAnswer,
  })
}
