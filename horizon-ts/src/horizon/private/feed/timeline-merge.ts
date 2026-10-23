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
 */

import {logger} from '#/logger'
import {FALLBACK_MARKER_POST} from '#/features/followingV2/home/api/home'
import {
  type FeedAPI,
  type FeedAPIResponse,
  type FeedSource,
} from '#/features/followingV2/home/api/types'
import {
  type PrivateSource,
  toFeedViewPosts,
} from '#/horizon/private/adapt/feed-view'
import {
  type AnswerContext,
  getPrivateTimelineAnswered,
} from '#/horizon/private/api/reads'
import {
  decodeMergeCursor,
  encodeMergeCursor,
  initialMergeState,
  isMergeCursor,
  type MergeState,
} from '#/horizon/private/feed/cursor'
import {degradedFlags} from '#/horizon/private/feed/degraded'
import {
  insertPending,
  mergeStep,
  withDeadline,
} from '#/horizon/private/feed/merge-core'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {withPrivateQuotes} from '#/horizon/private/quotes/resolve'
import {getPendingPosts} from '#/horizon/private/store'
import {PRIVATE_READING} from '#/horizon/switches'
import {type app} from '#/lexicons'

/**
 * The size of a private timeline page.
 */
export const PRIVATE_PAGE_LIMIT = 30

/**
 * How long the private side may take before the feed continues without it.
 */
export const PRIVATE_DEADLINE_MS = 5_000

/**
 * How many public pages one call follows when they carry no Following items.
 */
const MAX_PUBLIC_PAGES = 3

function isMarker(item: app.bsky.feed.defs.FeedViewPost) {
  return item.post.uri === FALLBACK_MARKER_POST.post.uri
}

class PrivateTimelineFeedAPI implements FeedAPI {
  constructor(
    private stock: FeedAPI,
    private source: PrivateSource,
  ) {}

  peekLatest(opts?: {source?: FeedSource}) {
    // Public posts only, until a merged peek exists.
    return this.stock.peekLatest(opts)
  }

  async fetch(params: {
    cursor: string | undefined
    since?: string
    source?: FeedSource
    limit: number
    signal?: AbortSignal
  }): Promise<FeedAPIResponse> {
    const {cursor, since, source, limit, signal} = params
    if (
      since !== undefined ||
      source === 'discover' ||
      (cursor !== undefined && !isMergeCursor(cursor))
    ) {
      return this.stock.fetch(params)
    }
    const isFirst = cursor === undefined
    const state: MergeState = isFirst
      ? initialMergeState()
      : decodeMergeCursor(cursor)

    let startCursor: string | undefined
    // The private side's answers, and whether its refill failed or was skipped (6.5).
    const answers: AnswerContext[] = []
    let incomplete = state.priv.failed
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
          priv.buf.push(...page.items.map(view => ({view})))
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
      if (isFirst) insertPending(priv.buf, getPendingPosts())
    }

    const {feed, drained} = await mergeStep(
      state,
      {refillPublic, refillPrivate},
      {
        adapt: inputs =>
          toFeedViewPosts(inputs, {
            prism: this.source.prism,
            appview: this.source.appview,
          }),
      },
    )

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
}

/**
 * The Following feed API with the member's private timeline merged in. With
 * `PRIVATE_READING` and a private source (a member whose clients are
 * current), every feed's pages, Following's or another's, also come back
 * with the private posts they quote resolved (`quotes/resolve.ts`).
 * Otherwise the stock API unchanged.
 */
export function withPrivateTimeline(
  feedDesc: string,
  source: PrivateSource | undefined,
  api: FeedAPI,
): FeedAPI {
  if (!PRIVATE_READING || !source) return api
  return withPrivateQuotes(
    feedDesc === 'following' ? new PrivateTimelineFeedAPI(api, source) : api,
  )
}

export type {MergeState}
