/*
 * The profile Likes tab with liked private posts (change list item 5). The
 * tab is the owner's own (stock shows it to the owner only); the public
 * AppView drops a like whose subject is a private post, since it cannot
 * hydrate it. For a member, the owner's like records are read from their own
 * repo (`com.atproto.repo.listRecords`, newest first), the private subjects
 * read through prism's `getPosts` (readable ones only; the rest stay
 * dropped), and merged with the stock items in like order.
 *
 * Like order is the like record's rkey, a TID: the stock items carry it as
 * `post.viewer.like` (the viewer is the owner), the private side as the
 * record's URI. Both sides are consumed in their own order, so nothing is
 * lost, repeated or reordered within a side.
 *
 * The merge core (`merge-core.ts`) waits for a private item before it emits
 * a public one; here most like records name public posts, so the private side
 * can be empty for many pages. Instead it keeps a floor: the oldest rkey
 * read so far. A like not read yet is older than the floor, so a stock item
 * at or above it is emitted without waiting; one below it waits for the next
 * record page. One load reads at most `MAX_PAGES_PER_LOAD` record pages
 * while nothing comes out (`paging.ts`).
 */

import {lexParse, lexStringify} from '@atproto/lex'

import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {logger} from '#/logger'
import {type PrivatePostView} from '#/horizon/lexicons/nearhorizon'
import {
  type PrivateSource,
  toFeedViewPosts,
} from '#/horizon/private/adapt/feed-view'
import {
  type AnswerContext,
  getPrivatePostsAnswered,
} from '#/horizon/private/api/reads'
import {fromBase64Url, toBase64Url} from '#/horizon/private/feed/cursor'
import {degradedFlags} from '#/horizon/private/feed/degraded'
import {withDeadline} from '#/horizon/private/feed/merge-core'
import {MAX_PAGES_PER_LOAD} from '#/horizon/private/feed/paging'
import {noteOmissions} from '#/horizon/private/known'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {type app} from '#/lexicons'

export const LIKES_CURSOR_PREFIX = 'hzl1.'

/** Like records read per page of the owner's repo. */
export const LIKE_RECORDS_PAGE_LIMIT = 100

/** How long one prism read may take before the tab continues without it. */
export const LIKES_MERGE_DEADLINE_MS = 5_000

/** A page of the owner's `app.bsky.feed.like` records, newest first. */
export type LikeRecordPage = {
  records: {uri: string; value: unknown}[]
  cursor?: string
}

/** Reads one page of the owner's like records from `cursor`. */
export type ListLikeRecords = (
  cursor: string | undefined,
) => Promise<LikeRecordPage>

/** A liked private post, with its like's rkey. */
type LikeEntry = {rkey: string; view: PrivatePostView}

/** Everything one page of the merge needs to continue. */
export type LikesMergeState = {
  pub: {
    buf: app.bsky.feed.defs.FeedViewPost[]
    cursor: string | null
    done: boolean
  }
  priv: {
    buf: LikeEntry[]
    cursor: string | null
    done: boolean
    failed: boolean
    /** The oldest like rkey read so far; null before the first page. */
    floor: string | null
  }
}

export function initialLikesMergeState(): LikesMergeState {
  return {
    pub: {buf: [], cursor: null, done: false},
    priv: {buf: [], cursor: null, done: false, failed: false, floor: null},
  }
}

export function isLikesMergeCursor(
  cursor: string | undefined,
): cursor is string {
  return !!cursor && cursor.startsWith(LIKES_CURSOR_PREFIX)
}

export function encodeLikesMergeCursor(state: LikesMergeState): string {
  return LIKES_CURSOR_PREFIX + toBase64Url(lexStringify(state))
}

export function decodeLikesMergeCursor(cursor: string): LikesMergeState {
  if (!isLikesMergeCursor(cursor)) throw new Error('Not a likes cursor')
  const state = lexParse(
    fromBase64Url(cursor.slice(LIKES_CURSOR_PREFIX.length)),
  ) as unknown as LikesMergeState
  if (
    typeof state !== 'object' ||
    state === null ||
    !Array.isArray(state.pub?.buf) ||
    !Array.isArray(state.priv?.buf)
  ) {
    throw new Error('Malformed likes cursor')
  }
  return state
}

/** The rkey of an `at://` URI, or undefined. */
export function rkeyOf(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('at://')) return undefined
  const rkey = uri.split('/')[4]
  return rkey ? rkey : undefined
}

/** A stock item's like rkey (`post.viewer.like`), or undefined. */
export function stockLikeRkey(
  item: app.bsky.feed.defs.FeedViewPost,
): string | undefined {
  return rkeyOf(item.post.viewer?.like)
}

/** A like record's subject URI, or undefined. */
function subjectUriOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const subject = (value as {subject?: unknown}).subject
  if (typeof subject !== 'object' || subject === null) return undefined
  const uri = (subject as {uri?: unknown}).uri
  return typeof uri === 'string' ? uri : undefined
}

type Slot =
  | {kind: 'public'; item: app.bsky.feed.defs.FeedViewPost}
  | {kind: 'private'; view: PrivatePostView}

/**
 * Take items off `state` (mutated) in like order while it is safe to: the
 * newer head of the two sides, a stock item alone when no unread like can be
 * newer (the floor, or the private side done), a private item alone once the
 * stock side is done. Ties and stock items without a like rkey go first.
 */
export function emitLikes(state: LikesMergeState): {
  slots: Slot[]
  drained: boolean
} {
  const {pub, priv} = state
  const privDone = () => priv.done || priv.failed
  const slots: Slot[] = []
  while (true) {
    const pubHead = pub.buf[0]
    const privHead = priv.buf[0]
    if (!pubHead && !pub.done) break
    if (!pubHead && !privHead) break
    let takePublic: boolean
    if (!pubHead) {
      takePublic = false
    } else {
      const key = stockLikeRkey(pubHead)
      if (privHead) {
        takePublic = key === undefined || key >= privHead.rkey
      } else if (
        privDone() ||
        key === undefined ||
        (priv.floor !== null && key >= priv.floor)
      ) {
        takePublic = true
      } else {
        break
      }
    }
    if (takePublic) {
      slots.push({kind: 'public', item: pubHead})
      pub.buf.shift()
    } else {
      slots.push({kind: 'private', view: privHead.view})
      priv.buf.shift()
    }
  }
  const drained =
    pub.done && pub.buf.length === 0 && privDone() && priv.buf.length === 0
  return {slots, drained}
}

/**
 * The owner's Likes tab with their liked private posts merged in.
 */
export class PrivateLikesMergeFeedAPI implements FeedAPI {
  constructor(
    private stock: FeedAPI,
    private source: PrivateSource,
    private listLikes: ListLikeRecords,
  ) {}

  peekLatest() {
    return this.stock.peekLatest()
  }

  async fetch(params: {
    cursor: string | undefined
    limit: number
    signal?: AbortSignal
  }): Promise<FeedAPIResponse> {
    const {cursor, limit, signal} = params
    // A stock cursor (from a cache written before the merge) stays stock.
    if (cursor !== undefined && !isLikesMergeCursor(cursor)) {
      return this.stock.fetch(params)
    }
    const state =
      cursor === undefined
        ? initialLikesMergeState()
        : decodeLikesMergeCursor(cursor)
    /*
     * The private side's answers, and whether its refill failed or was
     * skipped or an answer left out a suspect (6.4: dropped, as now, and the
     * page degraded).
     */
    const answers: AnswerContext[] = []
    let incomplete = state.priv.failed

    const refillPublic = async () => {
      const pub = state.pub
      if (pub.buf.length > 0 || pub.done) return
      const res = await this.stock.fetch({
        cursor: pub.cursor ?? undefined,
        limit,
        signal,
      })
      pub.buf.push(...res.feed)
      pub.cursor = res.cursor ?? null
      if (!res.cursor) pub.done = true
    }

    const refillPrivate = async () => {
      const priv = state.priv
      if (priv.buf.length > 0 || priv.done || priv.failed) return
      try {
        const asked = priv.cursor ?? undefined
        const page = await withDeadline(
          this.listLikes(asked),
          LIKES_MERGE_DEADLINE_MS,
        )
        const liked: {rkey: string; uri: string}[] = []
        for (const record of page.records) {
          const rkey = rkeyOf(record.uri)
          const uri = subjectUriOf(record.value)
          if (rkey && uri && isPrivatePostUri(uri)) liked.push({rkey, uri})
        }
        if (liked.length > 0) {
          const {posts: views, answer} = await withDeadline(
            getPrivatePostsAnswered(
              this.source.prism,
              liked.map(like => like.uri),
            ),
            LIKES_MERGE_DEADLINE_MS,
          )
          answers.push(answer)
          const verdicts = noteOmissions(
            answer,
            liked.map(like => like.uri),
            views.map(view => view.uri),
          )
          for (const verdict of verdicts.values()) {
            if (verdict === 'suspect') incomplete = true
          }
          const byUri = new Map(views.map(view => [view.uri as string, view]))
          const seen = new Set<string>()
          for (const like of liked) {
            const view = byUri.get(like.uri)
            if (!view || seen.has(like.uri)) continue
            seen.add(like.uri)
            priv.buf.push({rkey: like.rkey, view})
          }
        }
        const last = rkeyOf(page.records[page.records.length - 1]?.uri)
        if (last !== undefined) priv.floor = last
        const next =
          page.cursor && page.cursor !== asked ? page.cursor : undefined
        priv.cursor = next ?? null
        priv.done = !next
      } catch (error) {
        // Stock only until the tab is refreshed from the top.
        priv.failed = true
        incomplete = true
        logger.warn('liked private posts unavailable; the tab continues', {
          safeMessage: error,
        })
      }
    }

    const feed: app.bsky.feed.defs.FeedViewPost[] = []
    let drained = false
    for (let round = 0; round < MAX_PAGES_PER_LOAD; round++) {
      await Promise.all([refillPublic(), refillPrivate()])
      const emitted = emitLikes(state)
      drained = emitted.drained
      const inputs = emitted.slots.flatMap(slot =>
        slot.kind === 'private' ? [{view: slot.view}] : [],
      )
      const adapted = inputs.length
        ? await toFeedViewPosts(inputs, this.source)
        : []
      const byUri = new Map<string, app.bsky.feed.defs.FeedViewPost>(
        adapted.map(item => [item.post.uri, item]),
      )
      for (const slot of emitted.slots) {
        if (slot.kind === 'public') {
          feed.push(slot.item)
        } else {
          // An item the adapter drops (not a valid post) stays dropped.
          const item = byUri.get(slot.view.uri)
          if (item) feed.push(item)
        }
      }
      if (feed.length > 0 || drained) break
    }
    return {
      feed,
      cursor: drained ? undefined : encodeLikesMergeCursor(state),
      // A degraded page is marked so (6.4); the flag never reaches the tuners.
      ...degradedFlags(answers, incomplete),
    }
  }
}
