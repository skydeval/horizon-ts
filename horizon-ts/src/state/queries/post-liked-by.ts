import {type AtUriString} from '@atproto/syntax'
import {
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  useInfiniteQuery,
} from '@tanstack/react-query'

import {useAppviewClient} from '#/state/session'
// HORIZON: a private post's likes are listed by prism
import {fetchPrivateLikesPage} from '#/horizon/private/api/interactions'
// HORIZON: a private post's likes are retried while prism is busy
import {
  keepOverData,
  privateRetryFor,
} from '#/horizon/private/api/transient'
// HORIZON: a private post's likes are listed by prism
import {isPrivateRead} from '#/horizon/private/uri'
import {app} from '#/lexicons'

const PAGE_SIZE = 30
type RQPageParam = string | undefined

// TODO refactor invalidate on mutate?
const RQKEY_ROOT = 'liked-by'
export const RQKEY = (resolvedUri: string) => [RQKEY_ROOT, resolvedUri]

export function useLikedByQuery(resolvedUri: string | undefined) {
  const client = useAppviewClient()
  return useInfiniteQuery<
    app.bsky.feed.getLikes.$OutputBody,
    Error,
    InfiniteData<app.bsky.feed.getLikes.$OutputBody>,
    QueryKey,
    RQPageParam
  >({
    queryKey: RQKEY(resolvedUri || ''),
    async queryFn(context) {
      const {pageParam} = context
      // HORIZON: a private post's likes are listed by prism
      if (isPrivateRead(resolvedUri))
        return keepOverData(context, () =>
          fetchPrivateLikesPage(resolvedUri!, pageParam, PAGE_SIZE),
        )
      return await client.call(app.bsky.feed.getLikes, {
        // the enabled flag prevents this from running until resolvedUri is set
        uri: (resolvedUri || '') as AtUriString,
        limit: PAGE_SIZE,
        cursor: pageParam,
      })
    },
    // HORIZON: a private post's likes are retried while prism is busy
    ...privateRetryFor(isPrivateRead(resolvedUri)),
    initialPageParam: undefined,
    getNextPageParam: lastPage => lastPage.cursor,
    enabled: !!resolvedUri,
  })
}

export function* findAllProfilesInQueryData(
  queryClient: QueryClient,
  did: string,
): Generator<app.bsky.actor.defs.ProfileView, void> {
  const queryDatas = queryClient.getQueriesData<
    InfiniteData<app.bsky.feed.getLikes.$OutputBody>
  >({
    queryKey: [RQKEY_ROOT],
  })
  for (const [_queryKey, queryData] of queryDatas) {
    if (!queryData?.pages) {
      continue
    }
    for (const page of queryData?.pages) {
      for (const like of page.likes) {
        if (like.actor.did === did) {
          yield like.actor
        }
      }
    }
  }
}
