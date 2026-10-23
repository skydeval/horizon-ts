/*
 * The profile merges (6.3.1; change list item 4 for Media and Videos): a
 * member's view of a profile's Posts, Replies, Media and Videos tabs is the stock author feed merged by time with the private posts
 * of that profile the reader may view, as Following merges the private
 * timeline. Nothing is taken away from the stock tab; private posts are
 * added.
 *
 * - Public side: the stock author feed API, one page per refill. Its pinned
 *   post (`reasonPin`) sorts above everything, as stock shows it.
 * - Private side: prism's author feed, filtered by prism with the stock
 *   filter while it lists `private.paging` (P-20), else on the client: Posts
 *   keeps top-level posts and the author's own self-thread replies; Replies
 *   keeps all. A page
 *   that comes back empty with a cursor (prism pages are bounded by
 *   candidates, so this happens) or that the filter empties is followed at
 *   once, up to `MAX_PAGES_PER_LOAD` pages per call (`feed/paging.ts`).
 * - The pinned private post, which the Posts tab's wrapper shows once at the
 *   top, is excluded from the private side on every page.
 */

import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {logger} from '#/logger'
import {gridMediaOf} from '#/horizon/media-grid/grid'
import {
  isOwnItem,
  type PrivateSource,
  readReplyRefs,
  toFeedViewPosts,
} from '#/horizon/private/adapt/feed-view'
import {
  type AnswerContext,
  getPrivateAuthorFeedAnswered,
  type PrivateAuthorFeedFilter,
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
  publicKey,
  type SortKey,
  withDeadline,
} from '#/horizon/private/feed/merge-core'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {privatePagingServed} from '#/horizon/private/server-support'
import {getPendingPosts} from '#/horizon/private/store'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

/**
 * The tab a merge serves: `posts` (stock `posts_and_author_threads`),
 * `replies` (stock `posts_with_replies`), `media` (stock `posts_with_media`)
 * or `video` (stock `posts_with_video`). The media tabs are merged only while
 * prism lists `private.mediaFilters` (change list item 4, P-30), and prism
 * always filters them.
 */
export type AuthorMergeFilter = 'posts' | 'replies' | 'media' | 'video'

/**
 * The size of a private author feed page.
 */
export const AUTHOR_MERGE_PAGE_LIMIT = 30

/**
 * How long the private side may take before the page continues without it.
 */
export const AUTHOR_MERGE_DEADLINE_MS = 5_000

/**
 * The stock filter of each tab, which prism takes once it filters (P-20).
 */
const STOCK_FILTER: Record<AuthorMergeFilter, PrivateAuthorFeedFilter> = {
  posts: 'posts_and_author_threads',
  replies: 'posts_with_replies',
  media: 'posts_with_media',
  video: 'posts_with_video',
}

function isMediaFilter(filter: AuthorMergeFilter): boolean {
  return filter === 'media' || filter === 'video'
}

/**
 * Whether prism filters the tab itself: the media tabs always (they are
 * merged only with `private.mediaFilters`), the others with
 * `private.paging`.
 */
function prismFilters(filter: AuthorMergeFilter): boolean {
  return isMediaFilter(filter) || privatePagingServed()
}

/**
 * A post's own media kind on a media tab, as stock sorts it: `media` for
 * images or a gallery (a quote with them included), `video` for a video.
 * Read from the adapted embed view (a pending post's).
 */
function mediaTabOf(embed: unknown): AuthorMergeFilter | undefined {
  const media = gridMediaOf(embed)
  if (!media) return undefined
  return media.kind === 'video' ? 'video' : 'media'
}

function authorityOf(uri: string): string | undefined {
  const match = /^at:\/\/([^/]+)/.exec(uri)
  return match?.[1]
}

/**
 * Whether a private record belongs on the tab: Replies keeps every post;
 * Posts keeps a post without a reply ref, or a reply whose root and parent
 * are both the author's own (a self-thread), as the stock Posts filter
 * means.
 */
export function keepsPrivatePost(
  filter: AuthorMergeFilter,
  actor: string,
  record: unknown,
): boolean {
  if (filter === 'replies' || prismFilters(filter)) return true
  const refs = readReplyRefs(record)
  if (!refs) return true
  return (
    authorityOf(refs.root.uri) === actor &&
    authorityOf(refs.parent.uri) === actor
  )
}

/**
 * The public sort key on a profile: the pinned post leaves first.
 */
function profilePublicKey(item: app.bsky.feed.defs.FeedViewPost): SortKey {
  if (bsky.isType(app.bsky.feed.defs.reasonPin, item.reason)) {
    return {time: Number.POSITIVE_INFINITY, uri: item.post.uri}
  }
  return publicKey(item)
}

/**
 * A profile's Posts or Replies tab with its private posts merged in.
 */
export class PrivateAuthorMergeFeedAPI implements FeedAPI {
  constructor(
    private stock: FeedAPI,
    private source: PrivateSource,
    private actor: string,
    private filter: AuthorMergeFilter,
    /**
     * The URI to keep off every page (the pinned private post), asked on the
     * first page only; the cursor carries it after that.
     */
    private excludeOnFirstPage?: () => Promise<string | undefined>,
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
    if (cursor !== undefined && !isMergeCursor(cursor)) {
      return this.stock.fetch(params)
    }
    const isFirst = cursor === undefined
    const state: MergeState = isFirst
      ? initialMergeState()
      : decodeMergeCursor(cursor)
    // The private side's answers, and whether its refill failed or was skipped (6.4).
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

    const refillPrivateSide = async () => {
      const priv = state.priv
      if (priv.buf.length > 0 || priv.done || priv.failed) return
      try {
        const res = await withDeadline(
          fetchUntilItems(
            async pageCursor => {
              const {body: page, answer} = await getPrivateAuthorFeedAnswered(
                this.source.prism,
                {
                  actor: this.actor,
                  limit: AUTHOR_MERGE_PAGE_LIMIT,
                  cursor: pageCursor,
                  ...(prismFilters(this.filter)
                    ? {filter: STOCK_FILTER[this.filter]}
                    : {}),
                },
              )
              answers.push(answer)
              return {items: page.feed, cursor: page.cursor}
            },
            priv.cursor ?? undefined,
            {
              // A repost item appears under both filters (lexicon); the
              // media filters leave reposts out, as stock.
              keep: view =>
                isOwnItem(view)
                  ? keepsPrivatePost(this.filter, this.actor, view.record)
                  : !isMediaFilter(this.filter),
            },
          ),
          AUTHOR_MERGE_DEADLINE_MS,
        )
        priv.buf.push(...res.items.map(view => ({view})))
        priv.cursor = res.cursor ?? null
        priv.done = !res.cursor
      } catch (error) {
        // Public-only until the tab is refreshed from the top.
        priv.failed = true
        incomplete = true
        logger.warn('private author feed unavailable; the tab continues', {
          safeMessage: error,
        })
      }
    }

    const refillPrivate = async () => {
      const [, excluded] = await Promise.all([
        refillPrivateSide(),
        isFirst && this.excludeOnFirstPage
          ? this.excludeOnFirstPage().catch(() => undefined)
          : Promise.resolve(undefined),
      ])
      if (excluded) state.exclude.push(excluded)
      if (isFirst && this.actor === this.source.did) {
        insertPending(
          state.priv.buf,
          getPendingPosts().filter(entry =>
            isMediaFilter(this.filter)
              ? mediaTabOf(entry.postView.embed) === this.filter
              : keepsPrivatePost(this.filter, this.actor, entry.record),
          ),
        )
      }
    }

    const {feed, drained} = await mergeStep(
      state,
      {refillPublic, refillPrivate},
      {
        adapt: inputs => toFeedViewPosts(inputs, this.source),
        publicKeyOf: profilePublicKey,
      },
    )
    return {
      feed,
      cursor: drained ? undefined : encodeMergeCursor(state),
      // A degraded page is marked so (6.4); the flag never reaches the tuners.
      ...degradedFlags(answers, incomplete),
    }
  }
}
