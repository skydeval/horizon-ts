/*
 * Saved's Private tab (Bkm 3, 10.2): the reader's private bookmarks from
 * prism, rendered with the stock `Post` row as the stock list renders
 * bookmarks. While prism does not list `private.bookmarks`, or for a reader
 * without a private source, it shows its empty state and makes no request.
 *
 * While prism is busy (prism busy design 4.1, 5, 10): opened while the
 * account is not confirmed it hides another author's private posts from
 * pages fetched before it until a page fetched since holds them, with the
 * catching-up note at the top (also after 20 s of ill health), and runs its
 * stock `refetch()`. Once confirmed it lifts itself: at the top a refetch,
 * scrolled down `refreshPending`, run when back at the top. With nothing to
 * show, the skeleton waits at most 30 s, then the quiet row with Try again.
 */

import {useState} from 'react'
import {useLingui} from '@lingui/react/macro'
import {useInfiniteQuery} from '@tanstack/react-query'

import {useInitialNumToRender} from '#/lib/hooks/useInitialNumToRender'
import {cleanError} from '#/lib/strings/errors'
import {Post} from '#/view/com/post/Post'
import {EmptyState} from '#/view/com/util/EmptyState'
import {List} from '#/view/com/util/List'
import {PostFeedLoadingPlaceholder} from '#/view/com/util/LoadingPlaceholder'
import {atoms as a, useTheme} from '#/alf'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import * as Layout from '#/components/Layout'
import {ListFooter} from '#/components/Lists'
import {IS_IOS} from '#/env'
import {
  fetchPrivateBookmarksPage,
  type PrivateBookmarksPage,
  privateBookmarksQueryKey,
  type PrivateBookmarkView,
} from '#/horizon/private/api/bookmarks'
import {
  isTransientPrismError,
  keepOverData,
  PRIVATE_RETRY,
} from '#/horizon/private/api/transient'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {useListBusy} from '#/horizon/private/list-busy'
import {
  fetchStamp,
  gatePages,
  type PageAccess,
  useEmptyWaitCapped,
} from '#/horizon/private/load-gate'
import {usePrivateFeedSource} from '#/horizon/private/membership'
import {ListUnavailable} from '#/horizon/private/render/ListUnavailable'
import {CatchingUpNote} from '#/horizon/private/status/CatchingUpNote'

type ListItem =
  | {type: 'loading'; key: 'loading'}
  | {type: 'empty'; key: 'empty'}
  | {type: 'unavailable'; key: 'unavailable'}
  | {type: 'bookmark'; key: string; bookmark: PrivateBookmarkView}

/** How the load gate reads a page of saved posts: each by its post. */
const SAVED_ACCESS: PageAccess<PrivateBookmarksPage, PrivateBookmarkView> = {
  stampOf: page => page.fetchedAt,
  itemsOf: page => page.bookmarks,
  withItems: (page, bookmarks) => ({...page, bookmarks}),
  urisOf: bookmark => [bookmark.item.uri],
}

/**
 * The private list (see the file header).
 */
export function PrivateSavedList() {
  const t = useTheme()
  const {t: l} = useLingui()
  const source = usePrivateFeedSource()
  const served = usePrismFeature('private.bookmarks')
  const enabled = served && !!source
  const initialNumToRender = useInitialNumToRender()
  const [isPTRing, setIsPTRing] = useState(false)
  const queryKey = privateBookmarksQueryKey(source?.did ?? '')
  const {
    data: queryData,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
    refetch,
  } = useInfiniteQuery({
    enabled,
    queryKey,
    // Retried while prism is busy, never over a page it shows (busy design 5).
    queryFn: (context): Promise<PrivateBookmarksPage> => {
      if (!source) return Promise.resolve({bookmarks: []})
      return keepOverData(context, async () => ({
        ...(await fetchPrivateBookmarksPage(source, context.pageParam)),
        // The page's completion stamp, for the gate (busy design 4.1).
        fetchedAt: fetchStamp(),
      }))
    },
    ...PRIVATE_RETRY,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.cursor,
  })

  // The load gate (busy design 4.1), after the query so its fetch is joined.
  const busy = useListBusy<{pages: PrivateBookmarksPage[]}>({
    did: enabled ? source?.did : undefined,
    queryKey,
    urisOf: raw =>
      raw.pages.flatMap(page => page.bookmarks.map(b => b.item.uri)),
    hiddenOf: (raw, since) =>
      gatePages(raw.pages, source?.did ?? '', since, SAVED_ACCESS).hidden,
    refetch: () => refetch(),
  })
  const gated =
    queryData && busy.loadSince !== undefined && source
      ? gatePages(queryData.pages, source.did, busy.loadSince, SAVED_ACCESS)
      : undefined
  const data =
    queryData && gated && gated.hidden > 0
      ? {...queryData, pages: gated.pages}
      : queryData
  const capped = useEmptyWaitCapped(enabled && !queryData && isFetching)

  if (!enabled) {
    // Outside a list, so it centres itself in the column as the list would
    return (
      <Layout.Center>
        <EmptyState
          testID="privateSavedEmpty"
          icon={LockIcon}
          message={
            served
              ? l`No saved private posts yet.`
              : l`Saved private posts will show here.`
          }
          textStyle={[t.atoms.text_contrast_medium, a.font_medium]}
          style={[a.pt_3xl]}
        />
      </Layout.Center>
    )
  }

  const onRefresh = async () => {
    setIsPTRing(true)
    busy.restart()
    try {
      await refetch()
    } finally {
      setIsPTRing(false)
    }
  }

  const onEndReached = async () => {
    if (isFetchingNextPage || !hasNextPage || error) return
    try {
      await fetchNextPage()
    } catch {}
  }

  const items: ListItem[] = []
  const transient = !!error && isTransientPrismError(error)
  const bookmarks = data?.pages.flatMap(page => page.bookmarks) ?? []
  const allHidden = !!gated && gated.hidden > 0 && bookmarks.length === 0
  if (capped || (!queryData && transient) || (allHidden && !isFetching)) {
    // The quiet row while retries go on (busy design 5).
    items.push({type: 'unavailable', key: 'unavailable'})
  } else if (isLoading || allHidden) {
    items.push({type: 'loading', key: 'loading'})
  } else if (data) {
    if (bookmarks.length === 0) {
      items.push({type: 'empty', key: 'empty'})
    }
    for (const bookmark of bookmarks) {
      items.push({type: 'bookmark', key: bookmark.item.uri, bookmark})
    }
  }

  const renderItem = ({item, index}: {item: ListItem; index: number}) => {
    switch (item.type) {
      case 'loading':
        return <PostFeedLoadingPlaceholder />
      case 'unavailable':
        return <ListUnavailable queryKey={queryKey} />
      case 'empty':
        return (
          <EmptyState
            icon={LockIcon}
            message={l`No saved private posts yet.`}
            textStyle={[t.atoms.text_contrast_medium, a.font_medium]}
            style={[a.pt_3xl]}
          />
        )
      case 'bookmark':
        return <Post post={item.bookmark.item} hideTopBorder={index === 0} />
    }
  }

  const isEmpty = items.length === 1 && items[0]?.type === 'empty'

  return (
    <List
      data={items}
      renderItem={renderItem}
      keyExtractor={(item: ListItem) => item.key}
      refreshing={isPTRing}
      onRefresh={() => void onRefresh()}
      onScrolledDownChange={busy.onScrolledDownChange}
      ListHeaderComponent={<CatchingUpNote hidden={busy.hidden} illHealth />}
      onEndReached={() => void onEndReached()}
      onEndReachedThreshold={4}
      ListFooterComponent={
        <ListFooter
          isFetchingNextPage={isFetchingNextPage}
          error={cleanError(error)}
          onRetry={fetchNextPage}
          style={[isEmpty && a.border_t_0]}
        />
      }
      initialNumToRender={initialNumToRender}
      windowSize={9}
      maxToRenderPerBatch={IS_IOS ? 5 : 1}
      updateCellsBatchingPeriod={40}
      sideBorders={false}
    />
  )
}
