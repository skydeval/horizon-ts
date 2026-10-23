import {useCallback, useMemo, useState} from 'react'
import {msg} from '@lingui/core/macro'
import {useLingui} from '@lingui/react'

import {useInitialNumToRender} from '#/lib/hooks/useInitialNumToRender'
import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {usePostRepostedByQuery} from '#/state/queries/post-reposted-by'
import {useResolveUriQuery} from '#/state/queries/resolve-uri'
import {ProfileCardWithFollowBtn} from '#/view/com/profile/ProfileCard'
import {List} from '#/view/com/util/List'
import {ListFooter, ListMaybePlaceholder} from '#/components/Lists'
// HORIZON: the catching-up note where the load gate hid a row
import {CatchingUpNote} from '#/horizon/private/status/CatchingUpNote'
import {type app} from '#/lexicons'

function renderItem({
  item,
  index,
}: {
  item: app.bsky.actor.defs.ProfileView
  index: number
}) {
  return (
    <ProfileCardWithFollowBtn
      key={item.did}
      profile={item}
      noBorder={index === 0}
    />
  )
}

function keyExtractor(item: app.bsky.actor.defs.ProfileView) {
  return item.did
}

export function PostRepostedBy({uri}: {uri: string}) {
  const {_} = useLingui()
  const initialNumToRender = useInitialNumToRender()

  const [isPTRing, setIsPTRing] = useState(false)

  const {
    data: resolvedUri,
    error: resolveError,
    isLoading: isLoadingUri,
  } = useResolveUriQuery(uri)
  const {
    data,
    isLoading: isLoadingRepostedBy,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
    refetch,
    // HORIZON: the list's load gate while prism is busy
    horizonHidden,
    horizonOnScrolledDownChange,
    horizonRestart,
  } = usePostRepostedByQuery(resolvedUri?.uri)

  const isError = Boolean(resolveError || error)

  const repostedBy = useMemo(() => {
    if (data?.pages) {
      return data.pages.flatMap(page => page.repostedBy)
    }
    return []
  }, [data])

  const onRefresh = useCallback(async () => {
    setIsPTRing(true)
    // HORIZON: a pull is a new load for the gate
    horizonRestart()
    try {
      await refetch()
    } catch (err) {
      logger.error('Failed to refresh reposts', {message: err})
    }
    setIsPTRing(false)
  }, [refetch, setIsPTRing, horizonRestart])

  const onEndReached = useCallback(async () => {
    if (isFetchingNextPage || !hasNextPage || isError) return
    try {
      await fetchNextPage()
    } catch (err) {
      logger.error('Failed to load more reposts', {message: err})
    }
  }, [isFetchingNextPage, hasNextPage, isError, fetchNextPage])

  if (repostedBy.length < 1) {
    return (
      <ListMaybePlaceholder
        isLoading={isLoadingUri || isLoadingRepostedBy}
        isError={isError}
        emptyType="results"
        emptyTitle={_(msg`No reposts yet`)}
        emptyMessage={_(
          msg`Nobody has reposted this yet. Maybe you should be the first!`,
        )}
        errorMessage={cleanError(resolveError || error)}
        sideBorders={false}
      />
    )
  }

  // loaded
  // =
  return (
    <List
      // HORIZON: the catching-up note where the load gate hid a row
      ListHeaderComponent={<CatchingUpNote hidden={horizonHidden} />}
      // HORIZON: a refresh the lift owes runs once back at the top
      onScrolledDownChange={horizonOnScrolledDownChange}
      data={repostedBy}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      refreshing={isPTRing}
      onRefresh={onRefresh}
      onEndReached={onEndReached}
      onEndReachedThreshold={4}
      ListFooterComponent={
        <ListFooter
          isFetchingNextPage={isFetchingNextPage}
          error={cleanError(error)}
          onRetry={fetchNextPage}
        />
      }
      desktopFixedHeight
      initialNumToRender={initialNumToRender}
      windowSize={11}
      sideBorders={false}
    />
  )
}
