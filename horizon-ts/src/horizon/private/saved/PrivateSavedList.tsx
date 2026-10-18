/*
 * Saved's Private tab (Bkm 3, 10.2): the reader's private bookmarks from
 * prism, rendered with the stock `Post` row as the stock list renders
 * bookmarks. While prism does not list `private.bookmarks`, or for a reader
 * without a private source, it shows its empty state and makes no request.
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
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {usePrivateFeedSource} from '#/horizon/private/membership'

type ListItem =
  | {type: 'loading'; key: 'loading'}
  | {type: 'empty'; key: 'empty'}
  | {type: 'bookmark'; key: string; bookmark: PrivateBookmarkView}

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
  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
    refetch,
  } = useInfiniteQuery({
    enabled,
    queryKey: privateBookmarksQueryKey(source?.did ?? ''),
    queryFn: ({pageParam}): Promise<PrivateBookmarksPage> => {
      if (!source) return Promise.resolve({bookmarks: []})
      return fetchPrivateBookmarksPage(source, pageParam)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.cursor,
  })

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
  if (isLoading) {
    items.push({type: 'loading', key: 'loading'})
  } else if (data) {
    const bookmarks = data.pages.flatMap(page => page.bookmarks)
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
