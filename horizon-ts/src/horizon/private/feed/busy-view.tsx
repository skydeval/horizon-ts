/*
 * The views' side of the feeds' load gate (prism busy design 6.4, 6.5, 4.1,
 * 10): Following's gate and lift, the legacy profile section's, and the
 * catching-up note in the list's header slot.
 */

import {useEffect, useState, useSyncExternalStore} from 'react'
import {type QueryKey} from '@tanstack/react-query'

import {
  type FeedGate,
  gateSlicedPages,
  hiddenInFeedPages,
  legacyFeedCarriesPrivate,
  privateUrisIn,
  type RawFeedPage,
  type SlicedFeedPage,
} from '#/horizon/private/feed/busy'
import {
  isPageDegraded,
  isTopPageDegraded,
} from '#/horizon/private/feed/degraded'
import {privateTabDid} from '#/horizon/private/feed/keys'
import {useLoadGate} from '#/horizon/private/load-gate'
import {CatchingUpNote} from '#/horizon/private/status/CatchingUpNote'
import {useCurrentClients} from '#/horizon/routing/current-clients'

/**
 * A stable header component showing the catching-up note while `hidden > 0`
 * (and, with `illHealth`, after 20 s of ill health, design 10), above
 * `Header` when one is given. Its identity changes only with `Header`, so
 * the list never remounts its header.
 */
export function useNoteHeader(
  hidden: number,
  {
    Header,
    illHealth = false,
  }: {Header?: () => React.ReactElement; illHealth?: boolean} = {},
): () => React.ReactElement {
  const [store] = useState(() => valueStore({hidden, illHealth}))
  useEffect(() => {
    store.set({hidden, illHealth})
  }, [store, hidden, illHealth])
  const [made, setMade] = useState(() => ({
    Header,
    Component: noteHeader(store, Header),
  }))
  useEffect(() => {
    if (made.Header !== Header) {
      setMade({Header, Component: noteHeader(store, Header)})
    }
  }, [made, Header, store])
  return made.Component
}

type NoteState = {hidden: number; illHealth: boolean}

function valueStore(initial: NoteState) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: NoteState) => {
      if (next.hidden === value.hidden && next.illHealth === value.illHealth) {
        return
      }
      value = next
      listeners.forEach(listener => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function noteHeader(
  store: ReturnType<typeof valueStore>,
  Header: (() => React.ReactElement) | undefined,
) {
  return function NoteHeader() {
    const {hidden, illHealth} = useSyncExternalStore(store.subscribe, store.get)
    return (
      <>
        {Header ? <Header /> : null}
        <CatchingUpNote hidden={hidden} illHealth={illHealth} />
      </>
    )
  }
}

/**
 * Following's load gate (6.5), run by its view on both platforms: rows
 * hidden on a gated load, the gated mount's refresh from the top, the lift
 * (at the top `refreshToTop`; scrolled down the "new posts" affordance and a
 * `refreshPending` that resting at the top runs), and the note in the
 * header slot. A degraded topmost page with no `since` lifts too. Only a
 * member's Following is gated.
 */
export function useFollowingBusy<P extends SlicedFeedPage>({
  enabled,
  queryKey,
  data,
  isScrolledDown,
  refreshToTop,
  onHasNew,
  Header,
}: {
  /** A member's Following (its key carries the private source). */
  enabled: boolean
  queryKey: QueryKey
  /** The selected data the view renders. */
  data: {pages: P[]; pageParams: unknown[]} | undefined
  isScrolledDown: () => boolean
  refreshToTop: () => unknown
  onHasNew: ((has: boolean) => void) | undefined
  Header: (() => React.ReactElement) | undefined
}): {
  data: {pages: P[]; pageParams: unknown[]} | undefined
  hidden: number
  restart: () => void
  /** Run by resting at the top: a lift scrolled down left a refresh owed. */
  onRestAtTop: () => void
  /** Called by every refresh from the top: nothing is owed any more. */
  clearPending: () => void
  /**
   * Called when a check removed the staged page and nothing is newer (item 7
   * 3.4): the Home dot goes out, unless a lift scrolled down still owes a
   * refresh.
   */
  onStagedWithdrawn: () => void
  /** The header slot: the note above `Header`, or `Header` itself when ungated. */
  Header: (() => React.ReactElement) | undefined
} {
  const did = useCurrentClients()?.did
  const pending = useRefValue(false)
  const gate = useLoadGate<{pages: (RawFeedPage & {since?: string})[]}>(
    enabled ? did : undefined,
    queryKey,
    raw => privateUrisIn(raw.pages),
    {
      hiddenOf: (raw, since) => hiddenInFeedPages(raw.pages, did, since),
      refreshFromTop: () => {
        if (isScrolledDown()) {
          pending.current = true
          onHasNew?.(true)
        } else {
          void refreshToTop()
        }
      },
      isAtTop: () => !isScrolledDown(),
      onScrolledDownLift: () => {
        pending.current = true
        onHasNew?.(true)
      },
      // The topmost page by position with no `since` (item 7's section 9).
      trimmedOf: raw => isTopPageDegraded(raw.pages),
    },
  )
  const gated =
    data && enabled
      ? gateSlicedPages(data.pages, did, gate.loadSince)
      : {pages: data?.pages ?? [], hidden: 0}
  const NoteHeader = useNoteHeader(gate.hidden, {Header})
  return {
    data: data && gated.hidden > 0 ? {...data, pages: gated.pages} : data,
    hidden: gate.hidden,
    restart: gate.restart,
    onRestAtTop: () => {
      if (!pending.current) return
      pending.current = false
      void refreshToTop()
    },
    clearPending: () => {
      pending.current = false
    },
    onStagedWithdrawn: () => {
      if (!pending.current) onHasNew?.(false)
    },
    Header: enabled ? NoteHeader : Header,
  }
}

/** A mutable box kept across renders (a ref read and written in handlers only). */
function useRefValue<T>(initial: T): {current: T} {
  const [box] = useState(() => ({current: initial}))
  return box
}

/**
 * The load gate of a legacy profile feed (6.4), run by the section that
 * renders it: the gated mount's top fetch, the lift (at the top a refresh
 * from the top, scrolled down "Load new posts" lit), and the note in the
 * list's header. `refreshFromTop` drops later pages and refetches the first
 * (`truncateAndInvalidate`).
 */
export function useProfileFeedBusy({
  feedDesc,
  queryKey,
  isScrolledDown,
  refreshFromTop,
  onScrolledDownLift,
}: {
  feedDesc: string
  queryKey: QueryKey
  isScrolledDown: () => boolean
  refreshFromTop: () => void
  onScrolledDownLift: () => void
}): {
  gate: FeedGate
  hidden: number
  /** The list's header slot: the note, or nothing for an ungated feed. */
  Header: (() => React.ReactElement) | undefined
} {
  const did = useCurrentClients()?.did
  const carries = legacyFeedCarriesPrivate(feedDesc, did)
  const gate = useLoadGate<{pages: RawFeedPage[]}>(
    carries ? did : undefined,
    queryKey,
    data => privateUrisIn(data.pages),
    {
      hiddenOf: (data, since) => hiddenInFeedPages(data.pages, did, since),
      refreshFromTop: () => {
        if (isScrolledDown()) onScrolledDownLift()
        else refreshFromTop()
      },
      isAtTop: () => !isScrolledDown(),
      onScrolledDownLift,
      // A degraded top page lifts too (6.4).
      trimmedOf: data => isPageDegraded(data.pages[0]),
    },
  )
  const Header = useNoteHeader(gate.hidden, {
    // The Private tab shows the note after 20 s of ill health too (10).
    illHealth: carries && !!privateTabDid(feedDesc),
  })
  return {
    gate: {loadSince: gate.loadSince, restart: gate.restart},
    hidden: gate.hidden,
    Header: carries ? Header : undefined,
  }
}
