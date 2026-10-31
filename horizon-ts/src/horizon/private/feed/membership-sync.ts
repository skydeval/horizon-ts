/*
 * Keeps the feeds that can carry private posts in step with membership,
 * without changing their query keys (see `keys.ts`). When the signed-in
 * account stops being a private member, its private posts leave the cached
 * pages at once (a post prism no longer confirms is never shown) and the
 * pages are fetched again; when it becomes a member, they are fetched again
 * to bring the private posts in. Rows of public posts keep their place, so
 * the list never blanks and a video playing in it keeps playing.
 */

import {type InfiniteData, type QueryClient} from '@tanstack/react-query'

import {RQKEY_ROOT} from '#/state/queries/post-feed'
import {privateKeyDid} from '#/horizon/private/feed/keys'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {subscribePrismFeatures} from '#/horizon/routing/features'
import {
  isPrivateMember,
  subscribeMembership,
} from '#/horizon/routing/membership'
import {type app} from '#/lexicons'

type Page = {feed: app.bsky.feed.defs.FeedViewPost[]}

function uriOf(post: unknown): string | undefined {
  if (typeof post !== 'object' || post === null) return undefined
  const uri = (post as {uri?: unknown}).uri
  return typeof uri === 'string' ? uri : undefined
}

/** Whether a feed item shows a private post: itself, or its reply context. */
export function showsPrivatePost(item: app.bsky.feed.defs.FeedViewPost) {
  return (
    isPrivatePostUri(item.post.uri) ||
    isPrivatePostUri(uriOf(item.reply?.parent)) ||
    isPrivatePostUri(uriOf(item.reply?.root))
  )
}

function isAccountFeed(queryKey: readonly unknown[], did: string) {
  return queryKey[0] === RQKEY_ROOT && privateKeyDid(queryKey) === did
}

/** Drop every private post from `did`'s cached feeds. */
export function removePrivatePosts(queryClient: QueryClient, did: string) {
  const queries = queryClient.getQueriesData<InfiniteData<Page>>({
    predicate: query => isAccountFeed(query.queryKey, did),
  })
  for (const [queryKey, data] of queries) {
    if (!data?.pages) continue
    if (!data.pages.some(page => page.feed?.some(showsPrivatePost))) continue
    queryClient.setQueryData<InfiniteData<Page>>(queryKey, {
      ...data,
      pages: data.pages.map(page =>
        page.feed
          ? {...page, feed: page.feed.filter(item => !showsPrivatePost(item))}
          : page,
      ),
    })
  }
}

/**
 * Follow membership for the signed-in account; returns the stop function.
 * The first reading only records where things stand.
 */
export function startFeedMembershipSync(queryClient: QueryClient) {
  const last = new Map<string, boolean>()
  const check = () => {
    const did = getCurrentDid()
    if (!did) return
    const member = isPrivateMember(did)
    const before = last.get(did)
    last.set(did, member)
    if (before === undefined || before === member) return
    if (!member) removePrivatePosts(queryClient, did)
    /*
     * A tick later, so the feeds have re-rendered with the new private
     * source before they fetch. Either way the pages come fresh from prism,
     * which serves only what the account may read now.
     */
    clearTimeout(refetchTimer)
    refetchTimer = setTimeout(() => {
      void queryClient.invalidateQueries({
        predicate: query => isAccountFeed(query.queryKey, did),
      })
    }, 0)
  }
  let refetchTimer: ReturnType<typeof setTimeout> | undefined
  check()
  const stopMembership = subscribeMembership(check)
  const stopFeatures = subscribePrismFeatures(check)
  return () => {
    clearTimeout(refetchTimer)
    stopMembership()
    stopFeatures()
  }
}
