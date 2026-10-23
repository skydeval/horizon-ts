/*
 * The thread screen's Thread Lens hook (Phase 4 design 4.3, 7.4, 11.3, 11.6;
 * hook TH-6) and the anchor key part (TH-7).
 *
 * - **The params reset in render** (4.3; R2-L2, R3-L3). The lens mode
 *   changes from outside the screen (the menu, Settings, membership, a
 *   refusal, the feature list), so the stock `prepareForParamsUpdate` runs
 *   in the same render as the new data kind, as `usePostShadow` detects a
 *   change: the held kind is state, compared on every render. Placeholder
 *   data compares nothing; the first answer sets the kind with no reset;
 *   any later kind that differs resets. The key part (TH-7) is the kind, so
 *   the anchor's keyed `View` remounts and its `onLayout` ends the deferral.
 * - **The focus refetch** (11.6; R2-L3, R2-L4). The screen keeps its own
 *   pending flag, set by an `invalidate` of its lens key (the feature list's
 *   split invalidation marks lens entries stale without refetching) and by
 *   the app coming back online (lens queries set `refetchOnReconnect:
 *   false`); a fetch of the key started outside a 429 wait clears it. When
 *   set, the focused screen refetches at once, any other when it gains
 *   focus, never during the account's wait.
 * - **The automatic 429 retry** (11.3). A note with `autoRetry: 'pending'`
 *   schedules one refetch at its `retryAt`, run then on a focused screen
 *   outside a wait, else when the screen next gains focus.
 * - **A fallback's re-read** (TL-36). A fallback read for another `sort` or
 *   `below` is refetched once per pair on a focused screen not fetching;
 *   a fallback whose anchor becomes lens-only is refetched once the same way
 *   (7.4; v7: R5-N2). Both run during a 429 wait (they make no prism call).
 *
 * Every render-time read goes through a subscription (TL-34): the account's
 * wait, focus, the registry; the pending flag is state set from a query
 * cache subscription in an effect.
 */

import {useContext, useEffect, useState, useSyncExternalStore} from 'react'
import {NavigationContext} from '@react-navigation/native'
import {hashKey, onlineManager, useQueryClient} from '@tanstack/react-query'

import {useSession} from '#/state/session'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {THREAD_LENS} from '#/horizon/switches'
import {type LensState, type LensStateKind} from '#/horizon/thread-lens/adapt'
import {isLensWaiting, useLensWaiting} from '#/horizon/thread-lens/api'
import {useIsLensOnlyAnchor} from '#/horizon/thread-lens/availability'
import {useLensGapMark} from '#/horizon/thread-lens/mark'
import {LENS_ROOT} from '#/horizon/thread-lens/snapshot'

/** What the hook reads of the stock thread answer. */
type ThreadLike = {
  context: {postThreadQueryKey: readonly unknown[]}
  state: {lens: LensState; isFetching: boolean}
  actions: {refetch: () => unknown}
}

/** Whether the screen is focused, kept current; `true` outside a navigator. */
function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext)
  return useSyncExternalStore(
    callback => {
      if (!navigation) return () => {}
      const offFocus = navigation.addListener('focus', callback)
      const offBlur = navigation.addListener('blur', callback)
      return () => {
        offFocus()
        offBlur()
      }
    },
    () => navigation?.isFocused() ?? true,
  )
}

/** The screen hook (TH-6). */
export function useThreadLensScreen({
  prepareForParamsUpdate,
  thread,
  anchor,
}: {
  prepareForParamsUpdate: () => void
  thread: ThreadLike
  anchor: string | undefined
}) {
  const qc = useQueryClient()
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  // Every store read runs on every render (rules of hooks).
  const routeMarked = useLensGapMark()
  const marked =
    THREAD_LENS && !!did && !!anchor && !isPrivatePostUri(anchor) && routeMarked
  const lensOnly = useIsLensOnlyAnchor(did, anchor, marked)
  const waiting = useLensWaiting(did)
  const focused = useScreenFocused()

  const lens = thread.state.lens
  const fetching = thread.state.isFetching
  const refetch = thread.actions.refetch
  const key = thread.context.postThreadQueryKey
  const isLensKey = THREAD_LENS && key[0] === LENS_ROOT
  const queryHash = hashKey(key)

  // The params reset, in render (4.3).
  const [heldKind, setHeldKind] = useState<LensStateKind | undefined>()
  if (THREAD_LENS && lens.kind !== 'placeholder' && heldKind !== lens.kind) {
    setHeldKind(lens.kind)
    if (heldKind !== undefined) prepareForParamsUpdate()
  }

  // The screen's own pending refetch (11.6), for its current key only.
  const [pendingFor, setPendingFor] = useState<string | undefined>()
  const pending = isLensKey && pendingFor === queryHash
  useEffect(() => {
    if (!isLensKey) return
    return qc.getQueryCache().subscribe(event => {
      if (event.type !== 'updated' || event.query.queryHash !== queryHash) {
        return
      }
      if (event.action.type === 'invalidate') {
        setPendingFor(queryHash)
      } else if (event.action.type === 'fetch' && !isLensWaiting(did)) {
        setPendingFor(held => (held === queryHash ? undefined : held))
      }
    })
  }, [qc, isLensKey, queryHash, did])
  useEffect(() => {
    if (!isLensKey) return
    return onlineManager.subscribe(online => {
      if (online) setPendingFor(queryHash)
    })
  }, [isLensKey, queryHash])
  useEffect(() => {
    if (!pending || !focused || waiting || fetching) return
    void refetch()
  }, [pending, focused, waiting, fetching, refetch])

  // The one automatic retry of a 429 or a `Reindexing` (11.3).
  const note = lens.note
  const dueAt =
    isLensKey && note?.autoRetry === 'pending' && note.retryAt
      ? note.retryAt
      : 0
  const [reached, setReached] = useState(0)
  const [fired, setFired] = useState(0)
  useEffect(() => {
    if (!dueAt || reached === dueAt) return
    const timer = setTimeout(
      () => setReached(dueAt),
      Math.max(0, dueAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [dueAt, reached])
  useEffect(() => {
    if (!dueAt || reached !== dueAt || fired === dueAt) return
    if (!focused || waiting || fetching) return
    setFired(dueAt)
    void refetch()
  }, [dueAt, reached, fired, focused, waiting, fetching, refetch])

  // A fallback's re-read (TL-36), and one whose anchor became lens-only.
  const [rereadFor, setRereadFor] = useState<LensState | undefined>()
  const [lensOnlyFor, setLensOnlyFor] = useState<LensState | undefined>()
  useEffect(() => {
    if (!isLensKey || lens.kind !== 'fallback' || !focused || fetching) return
    if (lens.fallbackStale && rereadFor !== lens) {
      setRereadFor(lens)
      void refetch()
    } else if (lensOnly && lensOnlyFor !== lens) {
      setLensOnlyFor(lens)
      void refetch()
    }
  }, [
    isLensKey,
    lens,
    focused,
    fetching,
    lensOnly,
    rereadFor,
    lensOnlyFor,
    refetch,
  ])
}

/**
 * The lens part of the anchor's load-bearing key (TH-7): the data kind, so
 * a reset remounts the keyed `View` in the same render. Empty with the
 * switch off.
 */
export function threadLensKeyPart(thread: {state: {lens: LensState}}): string {
  return THREAD_LENS ? thread.state.lens.kind : ''
}
