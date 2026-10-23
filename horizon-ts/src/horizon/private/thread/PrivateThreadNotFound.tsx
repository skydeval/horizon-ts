import {type QueryKey, useQueryClient} from '@tanstack/react-query'

import {ThreadItemAnchorSkeleton} from '#/screens/PostThread/components/ThreadItemAnchor'
import {ThreadItemPostSkeleton} from '#/screens/PostThread/components/ThreadItemPost'
import {ThreadItemPostTombstone} from '#/screens/PostThread/components/ThreadItemPostTombstone'
import {restartPrivateQuery} from '#/horizon/private/api/transient'
import {isOwnAbsent} from '#/horizon/private/known'
import {StandIn} from '#/horizon/private/render/StandIn'
import {isUnavailableValue} from '#/horizon/private/thread/fetch'
import {useCurrentClients} from '#/horizon/routing/current-clients'

/**
 * A private thread item with no post to show (prism busy design 6.1, 6.2):
 * the reader's own post the PDS says is gone shows the stock tombstone; the
 * quiet item shows the thread skeleton while its load's fetch runs, then
 * "Couldn't load right now" with Try again (the thread query restarts); any
 * other is the audience stand-in.
 */
export function PrivateThreadNotFound({
  item,
  queryKey,
}: {
  item: {uri: string; depth: number; value: unknown}
  queryKey: QueryKey
}) {
  const qc = useQueryClient()
  const did = useCurrentClients()?.did
  if (did && isOwnAbsent(did, item.uri)) {
    return <ThreadItemPostTombstone type="not-found" />
  }
  if (isUnavailableValue(item.value)) {
    if (item.value.horizonPending) {
      return item.depth === 0 ? (
        <ThreadItemAnchorSkeleton />
      ) : (
        <ThreadItemPostSkeleton index={0} />
      )
    }
    return (
      <StandIn
        variant="thread"
        look="unavailable"
        onRetry={() => void restartPrivateQuery(qc, queryKey)}
      />
    )
  }
  return <StandIn variant="thread" />
}
