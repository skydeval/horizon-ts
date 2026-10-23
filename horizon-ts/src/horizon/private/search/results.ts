/*
 * Private search results for the stock search's post tabs (2H design 11,
 * H-2 as resolved; Search 1-4).
 *
 * One private search per query, shared by Top and Latest (prism answers
 * both in latest order), keyed `['horizon-private-search', did, q]`. Each
 * load asks prism up to {@link SEARCH_PAGES_PER_LOAD} pages while they come
 * back empty with a cursor (a page costs 5 tokens of prism's `private` rate
 * bucket, so a load stays within its shipped burst of 20); there is no
 * automatic continuation past a load that found nothing: the reader presses
 * "Search older posts". Once some are found, the list's end loads more, when
 * no private result is still waiting to be merged (`merge.ts`).
 *
 * Nothing is asked for a non-member, while `PRIVATE_SEARCH_SWITCH` is off,
 * while prism does not list `private.search`, or for a search with no word
 * and no author. The posts are moderated as the stock search moderates, but
 * not when an author is given (as `search-posts-v2.ts`).
 *
 * While prism is busy (prism busy design 4.1, 5): each load carries its
 * completion stamp; a search opened while the account is not confirmed
 * leaves out another author's private results from loads made before it
 * until a load since holds them (the catching-up note heads the list), and
 * runs its stock `refetch()` at mount. Once confirmed it lifts itself: at the
 * top it refetches, scrolled down it sets `refreshPending`, run when the list
 * is back at the top. With nothing loaded the "searching" line waits at most
 * 30 s, then "Couldn't load private posts right now" with Try again.
 */

import {moderatePost} from '@bsky/sdk/moderation'
import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query'

import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {useResolveDidQuery} from '#/state/queries/resolve-uri'
import {useSession} from '#/state/session'
import {type SearchFilters} from '#/screens/Search/searchParams'
import {
  keepOverData,
  PRIVATE_RETRY,
  restartPrivateQuery,
} from '#/horizon/private/api/transient'
import {PRIVATE_SEARCH_ROOT} from '#/horizon/private/cache-finders'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {useListBusy} from '#/horizon/private/list-busy'
import {
  fetchStamp,
  gatePages,
  type PageAccess,
  useEmptyWaitCapped,
} from '#/horizon/private/load-gate'
import {usePrivateFeedSource} from '#/horizon/private/membership'
import {
  fetchPrivateSearchLoad,
  type PrivateSearchPage,
} from '#/horizon/private/search/fetch'
import {mergeSearchResults} from '#/horizon/private/search/merge'
import {
  buildPrivateSearchQuery,
  privateSearchQ,
} from '#/horizon/private/search/query'
import {PRIVATE_SEARCH_SWITCH} from '#/horizon/switches'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** How the load gate reads a search page: each result by its own post. */
const SEARCH_ACCESS: PageAccess<PrivateSearchPage, PostView> = {
  stampOf: page => page.fetchedAt,
  itemsOf: page => page.posts,
  withItems: (page, posts) => ({...page, posts}),
  urisOf: post => [post.uri],
}

/**
 * What the private part of a search shows beside the results.
 */
export type PrivateSearchState = {
  /** The private part is offered at all. */
  active: boolean
  /** The terms left something out (filters and operators prism lacks). */
  ignoredSomething: boolean
  /** The author's handle could not be resolved: nothing is asked. */
  unresolvedHandle: string | undefined
  /** prism's `q`, when there is something to search. */
  q: string | undefined
  isLoading: boolean
  isFetchingNextPage: boolean
  error: Error | null
  /** Private results loaded so far. */
  found: number
  hasNextPage: boolean
  fetchNextPage: () => void
  refetch: () => void
  /** Results the load gate hides, for the catching-up note (4.1). */
  hidden: number
  /** The wait for a first load passed 30 s: the quiet line (design 5). */
  capped: boolean
  /** Try again on the quiet line: the search restarts at once. */
  restart: () => void
}

/**
 * The private results of a search merged with the public `publicPosts` for
 * `sort`, and the private part's state. Without a private part the posts
 * are `publicPosts` unchanged.
 */
export function usePrivateSearchResults({
  query,
  filters,
  sort,
  active,
  publicPosts,
  publicHasNextPage,
}: {
  query: string
  filters: SearchFilters | undefined
  sort: 'top' | 'latest' | undefined
  active: boolean
  publicPosts: PostView[]
  publicHasNextPage: boolean
}): {
  posts: PostView[]
  /** Called with the list's end: loads more private results when due. */
  onEndReached: () => void
  /** The stock `List`'s `onScrolledDownChange`: runs a refresh the lift owes. */
  onScrolledDownChange: (isScrolledDown: boolean) => void
  state: PrivateSearchState
} {
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const source = usePrivateFeedSource()
  const served = usePrismFeature('private.search')
  const moderationOpts = useModerationOpts()
  const offered = PRIVATE_SEARCH_SWITCH && served && !!source
  const terms = buildPrivateSearchQuery({
    query,
    filters,
    viewerDid: currentAccount?.did,
  })
  const handle =
    offered && terms.author && 'handle' in terms.author
      ? terms.author.handle
      : undefined
  const resolved = useResolveDidQuery(handle)
  const authorDid =
    terms.author && 'did' in terms.author ? terms.author.did : resolved.data
  const unresolvedHandle = handle && resolved.isError ? handle : undefined
  const q =
    handle && !resolved.data ? undefined : privateSearchQ(terms, authorDid)
  const hasAuthor = !!terms.author

  const search = useInfiniteQuery<
    PrivateSearchPage,
    Error,
    InfiniteData<PrivateSearchPage>,
    (string | undefined)[],
    string | undefined
  >({
    enabled: offered && active && !!q,
    queryKey: [PRIVATE_SEARCH_ROOT, source?.did, q],
    // Retried while prism is busy, never over a page it shows (busy design 5).
    queryFn: context => {
      if (!source || !q) return Promise.resolve({posts: []})
      return keepOverData(context, async () => ({
        ...(await fetchPrivateSearchLoad(source, q, context.pageParam)),
        // The load's completion stamp, for the gate (busy design 4.1).
        fetchedAt: fetchStamp(),
      }))
    },
    ...PRIVATE_RETRY,
    initialPageParam: undefined,
    getNextPageParam: lastPage => lastPage.cursor,
    select(data) {
      if (hasAuthor || !moderationOpts) return data
      return {
        ...data,
        pages: data.pages.map(page => ({
          ...page,
          posts: page.posts.filter(
            post =>
              !moderatePost(post, moderationOpts).ui('contentList').filter,
          ),
        })),
      }
    },
  })

  const shown = offered && !!q
  const queryKey = [PRIVATE_SEARCH_ROOT, source?.did, q]
  const busy = useListBusy<InfiniteData<PrivateSearchPage>>({
    did: shown ? source?.did : undefined,
    queryKey,
    urisOf: data => data.pages.flatMap(page => page.posts.map(p => p.uri)),
    hiddenOf: (data, since) =>
      gatePages(data.pages, source?.did ?? '', since, SEARCH_ACCESS).hidden,
    refetch: () => search.refetch(),
  })
  const gatedPages =
    search.data && busy.loadSince !== undefined && source
      ? gatePages(search.data.pages, source.did, busy.loadSince, SEARCH_ACCESS)
          .pages
      : search.data?.pages
  const capped = useEmptyWaitCapped(
    shown && !search.data && search.isFetching,
  )
  const privatePosts = shown
    ? (gatedPages?.flatMap(page => page.posts) ?? [])
    : []
  const merged = mergeSearchResults(publicPosts, privatePosts, {
    sort,
    publicHasMore: publicHasNextPage,
  })

  const onEndReached = () => {
    if (
      !shown ||
      merged.held > 0 ||
      privatePosts.length === 0 ||
      !search.hasNextPage ||
      search.isFetching ||
      search.error
    ) {
      return
    }
    void search.fetchNextPage()
  }

  return {
    posts: merged.posts,
    onEndReached,
    onScrolledDownChange: busy.onScrolledDownChange,
    state: {
      active: offered,
      ignoredSomething: terms.ignoredSomething,
      unresolvedHandle,
      q: shown ? q : undefined,
      isLoading: shown && search.isLoading,
      isFetchingNextPage: search.isFetchingNextPage,
      error: search.error,
      found: privatePosts.length,
      hasNextPage: shown && search.hasNextPage,
      fetchNextPage: () => void search.fetchNextPage(),
      refetch: () => {
        busy.restart()
        void search.refetch()
      },
      hidden: shown ? busy.hidden : 0,
      capped: shown && capped,
      restart: () => {
        busy.restart()
        void restartPrivateQuery(queryClient, queryKey)
      },
    },
  }
}
