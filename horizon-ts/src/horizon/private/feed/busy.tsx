/*
 * Feeds while prism is busy or behind (prism busy design 6.4, 6.5, 4.1, 5):
 * the load gate on a member's feeds that carry private posts and the 30 s
 * wait cap. The views' hooks and the note in the header slot are in
 * `busy-view.tsx`, so the stock queries import no UI.
 *
 * - **Rows.** On a gated load another author's private post held in a page
 *   fetched before `loadSince` is hidden with its slice: the post, and the
 *   reply context the slice shows. A carried row is judged by its own stamp
 *   (`horizonFromCache`, `carry.ts`). Own posts are never gated.
 * - **The legacy feed** (profile tabs, the Private tab, the Likes tab): the
 *   section that renders the list runs the gate (`useProfileFeedBusy`)
 *   and hands `loadSince` and `restart` to the stock query through
 *   {@link FeedGateProvider}, so another screen's copy of the same feed keeps
 *   its own load.
 * - **Following** runs the same gate in its own view (`followingV2`).
 */

import {createContext, useContext} from 'react'
import {type UseInfiniteQueryResult} from '@tanstack/react-query'

import {isTransientPrismError} from '#/horizon/private/api/transient'
import {privateTabDid} from '#/horizon/private/feed/keys'
import {asFailedQuery, PrivateListBusyError} from '#/horizon/private/list-busy'
import {
  isGatedOut,
  type LoadGate,
  useEmptyWaitCapped,
} from '#/horizon/private/load-gate'
import {privateMediaFiltersServed} from '#/horizon/private/server-support'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {PRIVATE_READING} from '#/horizon/switches'
import {type app} from '#/lexicons'

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

/** A raw page of a feed query: its rows and its completion stamp. */
export type RawFeedPage = {feed: readonly FeedViewPost[]; fetchedAt?: number}

/** A selected page: its stamp and its slices of posts. */
export type SlicedFeedPage = {
  fetchedAt?: number
  slices: readonly {items: readonly {post: {uri: string}}[]}[]
}

function stampOf(value: unknown): number | undefined {
  const stamp = (value as {horizonFromCache?: unknown} | undefined)
    ?.horizonFromCache
  return typeof stamp === 'number' ? stamp : undefined
}

function refOf(ref: unknown): {uri: string; carried?: number} | undefined {
  if (typeof ref !== 'object' || ref === null) return undefined
  const uri = (ref as {uri?: unknown}).uri
  return typeof uri === 'string' ? {uri, carried: stampOf(ref)} : undefined
}

/**
 * Whether a gated load hides a raw row (4.1): its post or the reply context
 * the row shows is another author's private post from data older than
 * `loadSince`.
 */
export function isFeedItemGatedOut(
  did: string,
  item: FeedViewPost,
  stamp: number | undefined,
  loadSince: number | undefined,
): boolean {
  if (loadSince === undefined) return false
  const refs = [
    {uri: item.post.uri, carried: stampOf(item.post)},
    refOf(item.reply?.parent),
    refOf(item.reply?.root),
  ]
  return refs.some(
    ref =>
      !!ref &&
      isGatedOut(did, {uri: ref.uri, horizonFromCache: ref.carried}, stamp, loadSince),
  )
}

/** How many raw rows a gated load hides in `pages` (the note and the lift). */
export function hiddenInFeedPages(
  pages: readonly RawFeedPage[] | undefined,
  did: string | undefined,
  loadSince: number | undefined,
): number {
  if (!did || loadSince === undefined || !pages) return 0
  let hidden = 0
  for (const page of pages) {
    for (const item of page.feed) {
      if (isFeedItemGatedOut(did, item, page.fetchedAt, loadSince)) hidden++
    }
  }
  return hidden
}

/**
 * Selected pages with every slice a gated load hides removed (4.1, "Lists"),
 * and how many. A page with nothing removed is returned as it is; the
 * registry is never read, so a serve elsewhere inserts no row in place.
 */
export function gateSlicedPages<P extends SlicedFeedPage>(
  pages: readonly P[],
  did: string | undefined,
  loadSince: number | undefined,
): {pages: P[]; hidden: number} {
  if (!did || loadSince === undefined) return {pages: [...pages], hidden: 0}
  let hidden = 0
  const out = pages.map(page => {
    const kept = page.slices.filter(
      slice =>
        !slice.items.some(item =>
          isGatedOut(
            did,
            {uri: item.post.uri, horizonFromCache: stampOf(item.post)},
            page.fetchedAt,
            loadSince,
          ),
        ),
    )
    if (kept.length === page.slices.length) return page
    hidden += page.slices.length - kept.length
    return {...page, slices: kept}
  })
  return {pages: out, hidden}
}

/**
 * Every private post URI in `value`, at any depth (a feed's rows, their reply
 * context and the posts they quote), for the gated mount's stamp (4.1), so
 * quote slots and own labels under its rows follow the same load.
 */
export function privateUrisIn(value: unknown): string[] {
  const uris = new Set<string>()
  const seen = new Set<object>()
  const walk = (node: unknown, depth: number) => {
    if (depth > 24 || typeof node !== 'object' || node === null) return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    const record = node as Record<string, unknown>
    if (typeof record.uri === 'string' && isPrivatePostUri(record.uri)) {
      uris.add(record.uri)
    }
    for (const key of Object.keys(record)) {
      // A feed page's API object holds no rows.
      if (key === 'api' || key === 'tuner') continue
      walk(record[key], depth + 1)
    }
  }
  walk(value, 0)
  return Array.from(uris)
}

/**
 * Whether a legacy feed carries private posts for a member, so it is gated
 * (6.4): the Private tab, the Posts and Replies merges, the media tabs while
 * prism filters media, and the owner's own Likes tab.
 */
export function legacyFeedCarriesPrivate(
  feedDesc: string,
  did: string | undefined,
): boolean {
  if (!PRIVATE_READING || !did) return false
  if (privateTabDid(feedDesc)) return true
  const [kind, actor, filter, ...rest] = feedDesc.split('|')
  if (rest.length) return false
  if (kind === 'likes') return actor === did && filter === undefined
  if (kind !== 'author') return false
  if (filter === 'posts_and_author_threads' || filter === 'posts_with_replies') {
    return true
  }
  return (
    (filter === 'posts_with_media' || filter === 'posts_with_video') &&
    privateMediaFiltersServed()
  )
}

/** The gate a legacy feed's section hands its stock query. */
export type FeedGate = Pick<LoadGate, 'loadSince' | 'restart'>

const FeedGateContext = createContext<FeedGate | undefined>(undefined)

/** Gives the stock feed query under it the section's load gate. */
export function FeedGateProvider({
  gate,
  children,
}: {
  gate: FeedGate
  children: React.ReactNode
}) {
  return <FeedGateContext value={gate}>{children}</FeedGateContext>
}

/** The section's load gate, for the stock feed query (none outside one). */
export function useFeedGate(): FeedGate | undefined {
  return useContext(FeedGateContext)
}

type InfiniteResult<P> = UseInfiniteQueryResult<
  {pages: P[]; pageParams: unknown[]},
  Error
>

/**
 * The stock feed query's result as a gated load and the wait cap show it
 * (4.1, 5), for a member's feed that carries private posts under a section's
 * gate. Anything else is returned as it is.
 *
 * - Slices hidden by the gate are removed. When the gate hides every row and
 *   no fetch is in flight (a refresh that failed), the list reads as failed,
 *   so it shows the quiet row rather than "No posts yet".
 * - With nothing cached, the Private tab reads as failed once it has waited
 *   {@link EMPTY_WAIT_MS}, while its retries go on.
 */
export function useBusyFeedQuery<
  P extends SlicedFeedPage,
  Q extends InfiniteResult<P>,
>(query: Q, {feedDesc, gate}: {feedDesc: string; gate: FeedGate | undefined}): Q {
  const did = useCurrentClients()?.did
  const gated = !!gate && legacyFeedCarriesPrivate(feedDesc, did)
  const waiting =
    gated &&
    !!privateTabDid(feedDesc) &&
    query.data === undefined &&
    query.status === 'pending' &&
    query.fetchStatus === 'fetching'
  const capped = useEmptyWaitCapped(waiting)
  if (!gated) return query
  if (capped) return asFailedQuery(query, new PrivateListBusyError())
  if (!query.data || gate.loadSince === undefined) return query
  const {pages, hidden} = gateSlicedPages(
    query.data.pages,
    did,
    gate.loadSince,
  )
  if (hidden === 0) return query
  const shown = pages.some(page => page.slices.length > 0)
  if (!shown && !query.isFetching) {
    return asFailedQuery(query, new PrivateListBusyError())
  }
  return {...query, data: {...query.data, pages}}
}

/**
 * Whether a legacy feed's error row is the quiet row (design 5, 6.2): a
 * transient prism failure, or the gate's own, on a feed that carries private
 * posts.
 */
export function isPrivateFeedBusyError(
  feedDesc: string,
  error: unknown,
  did: string | undefined,
): boolean {
  return (
    legacyFeedCarriesPrivate(feedDesc, did) &&
    (error instanceof PrivateListBusyError || isTransientPrismError(error))
  )
}
