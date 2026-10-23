/*
 * Private lists while prism is busy (prism busy design 4.1, 5, 6): what the
 * feeds, Search, Saved and the actor lists share.
 *
 * - {@link PrivateListBusyError}: what a list with nothing to show reads as
 *   once its wait is capped, or once the gate hides every row and no fetch is
 *   on its way, so its surface shows "Couldn't load right now" rather than an
 *   empty state.
 * - {@link useListBusy}: the load gate of a list with no "new items" control
 *   (Search, Saved, the actor lists). Scrolled down at the lift it sets
 *   `refreshPending`, which the stock `List`'s `onScrolledDownChange(false)`
 *   runs (BR11-N9, BR12-N5).
 * - {@link useBusyListQuery}: the actor lists' query (quotes, likes,
 *   reposts), gated in place.
 */

import {useState} from 'react'
import {t} from '@lingui/core/macro'
import {
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query'

import {PrivateDeadlineError} from '#/horizon/private/api/transient'
import {
  gatePages,
  type PageAccess,
  useEmptyWaitCapped,
  useLoadGate,
} from '#/horizon/private/load-gate'
import {isPrivateRead} from '#/horizon/private/uri'
import {useCurrentClients} from '#/horizon/routing/current-clients'

/** A capped wait, or a list the gate hid in full (design 5). Transient. */
export class PrivateListBusyError extends PrivateDeadlineError {
  constructor() {
    super(t`Couldn’t load right now. Private posts will show once they load.`)
    this.name = 'PrivateListBusyError'
  }
}

/** `query` read as failed with `error`, its retries going on behind it. */
export function asFailedQuery<Q extends UseInfiniteQueryResult<unknown, Error>>(
  query: Q,
  error: Error,
): Q {
  return {
    ...query,
    data: undefined,
    status: 'error',
    isError: true,
    isPending: false,
    isLoading: false,
    isLoadingError: true,
    isFetched: true,
    isFetching: false,
    error,
  }
}

/** What {@link useListBusy} gives its list. */
export type ListBusy = {
  loadSince: number | undefined
  /** Rows the gate hides. */
  hidden: number
  /** Called by every refresh of the list, before its fetch. */
  restart: () => void
  /** The stock `List`'s `onScrolledDownChange`: at the top it runs a refresh owed. */
  onScrolledDownChange: (isScrolledDown: boolean) => void
}

/**
 * The load gate of a list with no "new items" control (4.1, Recovery): the
 * gated mount runs the list's stock `refetch()`; the lift does at the top,
 * and scrolled down sets `refreshPending`, run when the list is back at the
 * top.
 */
export function useListBusy<D>({
  did,
  queryKey,
  urisOf,
  hiddenOf,
  refetch,
  trimmedOf,
}: {
  /** The reader, when the list is gated at all. */
  did: string | undefined
  queryKey: QueryKey
  urisOf: (data: D) => Iterable<string>
  hiddenOf: (data: D, loadSince: number) => number
  refetch: () => unknown
  trimmedOf?: (data: D) => boolean
}): ListBusy {
  const [box] = useState(() => ({scrolledDown: false, pending: false}))
  const gate = useLoadGate<D>(did, queryKey, urisOf, {
    hiddenOf,
    refreshFromTop: () => {
      if (box.scrolledDown) {
        box.pending = true
        return
      }
      gate.restart()
      void refetch()
    },
    isAtTop: () => !box.scrolledDown,
    onScrolledDownLift: () => {
      box.pending = true
    },
    trimmedOf,
  })
  return {
    loadSince: gate.loadSince,
    hidden: gate.hidden,
    restart: () => {
      box.pending = false
      gate.restart()
    },
    onScrolledDownChange: isScrolledDown => {
      box.scrolledDown = isScrolledDown
      if (isScrolledDown || !box.pending) return
      box.pending = false
      gate.restart()
      void refetch()
    },
  }
}

/** The actor lists' busy extras, on their query's result. */
export type BusyListExtras = {
  /** Rows the gate hides, for the catching-up note. */
  horizonHidden: number
  /** For the stock `List`: runs a refresh owed once back at the top. */
  horizonOnScrolledDownChange: (isScrolledDown: boolean) => void
  /** Called by the list's pull to refresh before its refetch. */
  horizonRestart: () => void
}

/**
 * An actor list's query (6, "Quotes, likes, reposts lists") as a gated load
 * and the wait cap show it, for a private subject. `rowUris` gives the
 * private posts a row shows whose author decides it: every row of a likes
 * or reposts list under another author's private post (BR11-N6), the
 * quoting post of a quotes list. A public subject's query is returned with
 * no gate.
 */
export function useBusyListQuery<
  P,
  I,
  Q extends UseInfiniteQueryResult<InfiniteData<P>, Error>,
>(
  query: Q,
  {
    subjectUri,
    queryKey,
    access,
  }: {
    subjectUri: string | undefined
    queryKey: QueryKey
    access: PageAccess<P, I>
  },
): Q & BusyListExtras {
  const did = useCurrentClients()?.did
  const gated = !!did && isPrivateRead(subjectUri)
  const rowsOf = (pages: readonly P[]) =>
    pages.flatMap(page => access.itemsOf(page) as I[])
  const busy = useListBusy<InfiniteData<P>>({
    did: gated ? did : undefined,
    queryKey,
    urisOf: data => rowsOf(data.pages).flatMap(row => [...access.urisOf(row)]),
    hiddenOf: (data, since) =>
      gatePages(data.pages, did ?? '', since, access).hidden,
    refetch: () => query.refetch(),
  })
  const waiting =
    gated &&
    query.data === undefined &&
    query.status === 'pending' &&
    query.fetchStatus === 'fetching'
  const capped = useEmptyWaitCapped(waiting)
  const extras: BusyListExtras = {
    horizonHidden: busy.hidden,
    horizonOnScrolledDownChange: busy.onScrolledDownChange,
    horizonRestart: busy.restart,
  }
  /*
   * Unchanged, the extras go on the result itself: spreading it would read
   * every tracked field and re-render on each.
   */
  const asIs = () => Object.assign(query, extras)
  if (!gated) return asIs()
  if (capped) {
    return {...asFailedQuery(query, new PrivateListBusyError()), ...extras}
  }
  if (!query.data || busy.loadSince === undefined) return asIs()
  const {pages, hidden} = gatePages(
    query.data.pages,
    did,
    busy.loadSince,
    access,
  )
  if (hidden === 0) return asIs()
  if (rowsOf(pages).length === 0) {
    if (!query.isFetching) {
      return {...asFailedQuery(query, new PrivateListBusyError()), ...extras}
    }
    return {
      ...query,
      data: undefined,
      status: 'pending',
      isPending: true,
      isSuccess: false,
      isLoading: true,
      ...extras,
    } as unknown as Q & BusyListExtras
  }
  const shown = {...query, data: {...query.data, pages}, ...extras}
  return shown as unknown as Q & BusyListExtras
}
