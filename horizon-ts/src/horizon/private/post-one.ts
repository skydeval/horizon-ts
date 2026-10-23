/*
 * Post 1 while prism is busy (prism busy design 6, "Post 1: as the anchor";
 * 4.1, 5): the post query of a private post is gated like the thread's
 * anchor, and its wait is capped. The stock `usePostQuery` passes its result
 * through here (a `// HORIZON:` hook).
 *
 * - **Gated load.** Another author's private post held in data fetched before
 *   the load began (`horizonFetchedAt`, set by `fetchPrivatePost`; a
 *   `precachePost` copy has none) reads as not loaded until the load's own
 *   fetch writes it. A gated mount fetches from the top, and the surface lifts
 *   itself once the account is confirmed (`useLoadGate`).
 * - **The wait cap.** With nothing cached, the query reads as failed once it
 *   has waited {@link EMPTY_WAIT_MS} while its retries go on, so its consumer
 *   shows its own error state rather than loading for minutes.
 */

import {type QueryKey, type UseQueryResult} from '@tanstack/react-query'

import {PrivateDeadlineError} from '#/horizon/private/api/transient'
import {isHeld} from '#/horizon/private/known'
import {
  isGatedOut,
  useEmptyWaitCapped,
  useLoadGate,
} from '#/horizon/private/load-gate'
import {isPrivateRead} from '#/horizon/private/uri'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

function stampOf(post: PostView): number | undefined {
  const stamp = (post as {horizonFetchedAt?: unknown}).horizonFetchedAt
  return typeof stamp === 'number' ? stamp : undefined
}

/** Whether a gated load hides `post` (4.1). */
export function isPostGatedOut(
  did: string | undefined,
  post: PostView,
  loadSince: number | undefined,
): boolean {
  if (!did) return false
  return isGatedOut(did, {uri: post.uri}, stampOf(post), loadSince)
}

/**
 * The post query's result as a gated load and the wait cap show it. A public
 * post's is returned as it is.
 */
export function useBusyPostQuery<Q extends UseQueryResult<PostView>>(
  uri: string | undefined,
  queryKey: QueryKey,
  query: Q,
): Q {
  const did = useCurrentClients()?.did
  const isPrivate = !!uri && isPrivateRead(uri)
  const gate = useLoadGate<PostView>(
    isPrivate ? did : undefined,
    queryKey,
    post => [post.uri],
    {
      hiddenOf: (post, since) => (isPostGatedOut(did, post, since) ? 1 : 0),
      trimmedOf: () => !!did && isHeld(did, queryKey),
    },
  )
  const waiting =
    isPrivate &&
    query.data === undefined &&
    query.status === 'pending' &&
    query.fetchStatus === 'fetching'
  const capped = useEmptyWaitCapped(waiting)
  if (!isPrivate) return query
  const hidden =
    query.data !== undefined && isPostGatedOut(did, query.data, gate.loadSince)
  if (capped) {
    return {
      ...query,
      status: 'error',
      isError: true,
      isPending: false,
      isLoading: false,
      isLoadingError: true,
      error: query.failureReason ?? new PrivateDeadlineError(),
    }
  }
  if (!hidden) return query
  return {
    ...query,
    data: undefined,
    status: 'pending',
    isPending: true,
    isSuccess: false,
    isLoading: query.isFetching,
  }
}
