/*
 * The thread while prism is busy or behind (prism busy design 6.1, 4.1, 5):
 * the load gate on the thread's items and its further replies, the reader's
 * own posts the PDS says are gone, the 30 s wait cap and the quiet row, and
 * which errors reach `ThreadError`.
 *
 * The stock thread query (`usePostThread`) runs this beside its own state;
 * every edit there is a `// HORIZON:` hook. The gate only hides: another
 * author's private post held in data fetched before the load began renders as
 * the quiet item (the anchor and parents, the skeleton while the load's fetch
 * runs) or is left out with its replies (a reply, a branch item).
 */

import {useMemo, useSyncExternalStore} from 'react'
import {
  type QueryKey,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'

import {getThreadPlaceholder} from '#/state/queries/usePostThread/queryCache'
import * as views from '#/state/queries/usePostThread/views'
import {isTransientPrismError} from '#/horizon/private/api/transient'
import {isHeld, isOwnAbsent, subscribeRegistry} from '#/horizon/private/known'
import {useEmptyWaitCapped, useLoadGate} from '#/horizon/private/load-gate'
import {unavailableItem} from '#/horizon/private/thread/fetch'
import {
  gateThreadItems,
  postOf,
  type Stamped,
  threadPrivateUris,
} from '#/horizon/private/thread/gate'
import {isPrivateRead} from '#/horizon/private/uri'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

export {
  gateOtherReplies,
  gateThreadItems,
  type Stamped,
  threadStamp,
} from '#/horizon/private/thread/gate'

type ApiItem = app.bsky.unspecced.getPostThreadV2.ThreadItem

/** The thread query's data as the busy handling reads it. */
type ThreadData = {thread: ApiItem[]} & Stamped

/** A key of the reader's own posts in `uris` the PDS says are gone. */
function absentKey(did: string | undefined, uris: readonly string[]): string {
  if (!did) return ''
  return uris.filter(uri => isOwnAbsent(did, uri)).join(' ')
}

/** What {@link useThreadBusy} gives the stock thread. */
export type ThreadBusy = {
  /** The main thread's items, gated. */
  thread: ApiItem[]
  /** Whether the stock skeletons show (the placeholder and before the cap). */
  isLoading: boolean
  /** The error `ThreadError` shows: never a transient one over something to show. */
  error: unknown
  /** Items the gate hid, for the catching-up note. */
  hidden: number
  /** Append the quiet row below the placeholder anchor (6.1). */
  quietRow: boolean
  /** The load's `loadSince`, for the further replies' gate. */
  loadSince: number | undefined
}

/**
 * The thread's busy handling (6.1, 4.1, 5) for `query` at `queryKey`.
 * `placeholder` is the stock placeholder of the anchor from another screen's
 * cache (no stamp: it counts as fetched before any `loadSince`).
 */
export function useThreadBusy({
  anchor,
  queryKey,
  query,
}: {
  anchor: string | undefined
  queryKey: QueryKey
  query: UseQueryResult<ThreadData>
}): ThreadBusy {
  const qc = useQueryClient()
  const did = useCurrentClients()?.did
  const isPrivate = !!anchor && isPrivateRead(anchor)
  const gate = useLoadGate<ThreadData>(
    did,
    queryKey,
    data => threadPrivateUris(data.thread ?? []),
    {
      hiddenOf: (data, since) =>
        gateThreadItems(data.thread ?? [], did, data.horizonFetchedAt, since)
          .hidden,
      trimmedOf: () => !!did && isHeld(did, queryKey),
    },
  )
  const data = query.isPlaceholderData ? undefined : query.data
  // Re-render when the PDS says one of the reader's own posts here is gone.
  const absent = useSyncExternalStore(subscribeRegistry, () =>
    absentKey(did, threadPrivateUris(query.data?.thread ?? [])),
  )

  const waiting =
    isPrivate &&
    !data &&
    query.status === 'pending' &&
    query.fetchStatus === 'fetching'
  const capped = useEmptyWaitCapped(waiting)

  return useMemo(
    () =>
      busyOf({
        anchor,
        did,
        isPrivate,
        query,
        data,
        capped,
        loadSince: gate.loadSince,
        placeholder: () =>
          anchor ? getThreadPlaceholder(qc, anchor) : undefined,
      }),
    // `absent` re-gates when the PDS says an own post here is gone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      anchor,
      did,
      isPrivate,
      query.data,
      query.isPlaceholderData,
      query.isFetching,
      query.status,
      query.error,
      data,
      capped,
      gate.loadSince,
      qc,
      absent,
    ],
  )
}

function busyOf({
  anchor,
  did,
  isPrivate,
  query,
  data,
  capped,
  loadSince,
  placeholder,
}: {
  anchor: string | undefined
  did: string | undefined
  isPrivate: boolean
  query: UseQueryResult<ThreadData>
  data: ThreadData | undefined
  capped: boolean
  loadSince: number | undefined
  placeholder: () => ApiItem | void
}): ThreadBusy {
  const gate = {loadSince}
  const transient = !!query.error && isTransientPrismError(query.error)

  if (data) {
    const gated = gateThreadItems(
      data.thread ?? [],
      did,
      data.horizonFetchedAt,
      gate.loadSince,
      {pending: query.isFetching},
    )
    return {
      thread: gated.items,
      isLoading: false,
      // A transient failure over data keeps it (BR-4).
      error: transient ? undefined : query.error,
      hidden: gated.hidden,
      quietRow: false,
      loadSince: gate.loadSince,
    }
  }

  const failed = isPrivate && query.status === 'error' && transient
  if (capped || failed) {
    // Past the wait, or after the tries: the quiet row, with Try again.
    const found = placeholder()
    const shown = found
      ? gateThreadItems([found], did, undefined, gate.loadSince).items
      : []
    const paints = shown.length > 0 && !!postOf(shown[0])
    return {
      thread: shown.length > 0 ? shown : anchor ? [unavailableItem(anchor, 0)] : [],
      isLoading: false,
      error: undefined,
      hidden: found && !paints ? 1 : 0,
      quietRow: paints,
      loadSince: gate.loadSince,
    }
  }

  const gated = gateThreadItems(
    query.data?.thread ?? [],
    did,
    undefined,
    gate.loadSince,
    {pending: true},
  )
  return {
    thread: gated.items,
    isLoading: query.isPlaceholderData,
    error: query.error,
    hidden: gated.hidden,
    quietRow: false,
    loadSince: gate.loadSince,
  }
}


/**
 * The built thread with the quiet row below the placeholder anchor (6.1:
 * "the placeholder anchor and one quiet row with Retry").
 */
export function withQuietRow<T extends {type: string; key: string}>(
  items: T[],
  anchor: string | undefined,
  quietRow: boolean,
): T[] {
  if (!quietRow || !anchor) return items
  const row = {
    ...views.threadPostNotFound(unavailableItem(anchor, 1)),
    key: `${anchor}#horizon-unavailable`,
  } as unknown as T
  return [...items, row]
}
