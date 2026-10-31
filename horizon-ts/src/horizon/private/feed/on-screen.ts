/*
 * Anchored Following's rows change only while it is on screen. On Android a
 * list covered by another screen (a thread opened from it) is out of the
 * window: it can't keep the reader's place when rows are added above them,
 * and the JS list waits for a scroll before it renders again. Coming back,
 * the feed shows black until it is scrolled, then jumps. These hooks hold
 * changes until the view is active, refresh a feed that went stale while it
 * was covered, and, for a change that still landed (a kryphocron post that
 * must leave at once), nudge the list so it never stays blank.
 */

import {useCallback, useEffect, useRef, useSyncExternalStore} from 'react'
import {type QueryKey, useQueryClient} from '@tanstack/react-query'

/**
 * A function whose promise resolves at once while `active`, and otherwise
 * when `active` next turns true.
 */
export function useActiveGate(active: boolean): () => Promise<void> {
  const gate = useRef({active, waiters: [] as Array<() => void>})
  useEffect(() => {
    gate.current.active = active
    if (!active) return
    const waiters = gate.current.waiters
    gate.current.waiters = []
    for (const resolve of waiters) resolve()
  }, [active])
  return useCallback(
    () =>
      gate.current.active
        ? Promise.resolve()
        : new Promise<void>(resolve => {
            gate.current.waiters.push(resolve)
          }),
    [],
  )
}

/** Whether the query at `queryKey` is invalidated (marked stale, not refetched). */
export function useQueryInvalidated(queryKey: QueryKey): boolean {
  const queryClient = useQueryClient()
  const cache = queryClient.getQueryCache()
  const subscribe = useCallback(
    (onChange: () => void) => cache.subscribe(onChange),
    [cache],
  )
  const read = () =>
    queryClient.getQueryState(queryKey)?.isInvalidated ?? false
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * Once the view is active and its query was invalidated while it was not
 * (and nothing is fetching): at the top, refresh from the top; scrolled
 * down, light the Home dot, so the reader's place stays and the new posts
 * are offered.
 */
export function useStaleFollowingRefresh({
  enabled,
  isActive,
  isInvalidated,
  isFetching,
  isScrolledDown,
  refreshToTop,
  onHasNew,
}: {
  enabled: boolean
  isActive: boolean
  isInvalidated: boolean
  isFetching: boolean
  isScrolledDown: () => boolean
  refreshToTop: () => void
  onHasNew?: (hasNew: boolean) => void
}) {
  const handled = useRef(false)
  useEffect(() => {
    if (!isInvalidated) {
      handled.current = false
      return
    }
    if (!enabled || !isActive || isFetching || handled.current) return
    handled.current = true
    if (isScrolledDown()) {
      onHasNew?.(true)
    } else {
      refreshToTop()
    }
  }, [
    enabled,
    isActive,
    isInvalidated,
    isFetching,
    isScrolledDown,
    refreshToTop,
    onHasNew,
  ])
}

/**
 * When the view turns active after its data changed while it was not, call
 * `rescroll` once, a frame later: scrolling to the current offset sends the
 * scroll event the list waits for, so it renders its rows again.
 */
export function useRescrollAfterCoveredChange({
  enabled,
  isActive,
  dataVersion,
  rescroll,
}: {
  enabled: boolean
  isActive: boolean
  dataVersion: unknown
  rescroll: () => void
}) {
  const changedWhileCovered = useRef(false)
  const lastVersion = useRef(dataVersion)
  useEffect(() => {
    if (lastVersion.current === dataVersion) return
    lastVersion.current = dataVersion
    if (!isActive) changedWhileCovered.current = true
  }, [dataVersion, isActive])
  useEffect(() => {
    if (!enabled || !isActive || !changedWhileCovered.current) return
    changedWhileCovered.current = false
    const frame = requestAnimationFrame(rescroll)
    return () => cancelAnimationFrame(frame)
  }, [enabled, isActive, rescroll])
}
