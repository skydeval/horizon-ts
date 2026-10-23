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
    const at = feed.findIndex(other => compareKeys(key, feedItemTime(other)) > 0)
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
