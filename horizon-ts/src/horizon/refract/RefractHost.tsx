// Registers the write fallbacks for the stock write path (write-hooks.ts).
import '#/horizon/refract/writes'

import {useEffect, useSyncExternalStore} from 'react'
import {AppState} from 'react-native'
import {type NsidString} from '@atproto/syntax'

import {watchVisitorForm} from '#/horizon/refract/fill'
import {REFRACT_REPLIES_ROOT} from '#/horizon/refract/finders'
import {
  refractActive,
  restoredVisitorForm,
  subscribeRefractGate,
} from '#/horizon/refract/gate'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {
  notedRestoredDids,
  onRestoredNoted,
  stampOf,
} from '#/horizon/refract/marker'
import {onOwnRelationsLoaded} from '#/horizon/refract/relations'
import {
  markAllEntriesStale,
  markVisitorEntriesStale,
} from '#/horizon/refract/store'
import {
  prewarmRefractTimeline,
  refractTimelineActive,
} from '#/horizon/refract/timeline'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {
  getDirectPrismToken,
  startDirectTokenPrefetch,
} from '#/horizon/routing/prism-direct'

/**
 * The tokens prefetched while Refract is active (7.1): `fill` and
 * `getReplies` only, for the current account, on every posting route.
 */
export const REFRACT_PREFETCH = {
  methods: [REFRACT_METHODS.fill, REFRACT_METHODS.getReplies] as NsidString[],
  routes: 'any' as const,
}

/** Minted the first time a marker is noted this session (7.1). */
export const REFRACT_LAZY_METHODS = [
  REFRACT_METHODS.getAuthorFeed,
  REFRACT_METHODS.getPostThread,
] as NsidString[]

/** Refresh the queries holding views of noted DIDs and visitor stamps. */
function refreshRestoredQueries() {
  const qc = getCurrentClients()?.queryClient
  if (!qc) return
  for (const did of notedRestoredDids()) {
    void qc.invalidateQueries({queryKey: ['profile', did]})
    void qc.invalidateQueries({
      predicate: query =>
        query.queryKey[0] === 'post-feed' &&
        typeof query.queryKey[1] === 'string' &&
        query.queryKey[1].startsWith(`author|${did}|`),
    })
  }
  void qc.invalidateQueries({
    predicate: query => {
      if (query.queryKey[0] !== 'post-thread-v2') return false
      const data = query.state.data as {thread?: {value?: {post?: unknown}}[]}
      return !!data?.thread?.some(item => stampOf(item.value?.post))
    },
  })
  void qc.invalidateQueries({queryKey: [REFRACT_REPLIES_ROOT]})
}

/**
 * Refract's app-wide pieces (refract client design 7.1, 9.2, 10): the narrow
 * token prefetch while Refract is active, the lazy mints on the first
 * marker, the refresh of visitor-stamped views when visitor form ends, and
 * the refresh after the reader's blocks or mutes finish loading. Mounted in
 * `HorizonHost`, which remounts on every account change.
 */
export function RefractHost() {
  const active = useSyncExternalStore(subscribeRefractGate, () =>
    refractActive(),
  )

  useEffect(() => {
    if (!active) return
    return startDirectTokenPrefetch(REFRACT_PREFETCH, {
      isForeground: () => AppState.currentState === 'active',
      subscribe: listener => {
        const subscription = AppState.addEventListener('change', listener)
        return () => subscription.remove()
      },
    })
  }, [active])

  useEffect(() => {
    if (!active) return
    let minted = false
    return onRestoredNoted(() => {
      if (minted) return
      minted = true
      const clients = getCurrentClients()
      if (!clients) return
      for (const lxm of REFRACT_LAZY_METHODS) {
        void getDirectPrismToken(clients.pdsClient, lxm).catch(() => {})
      }
    })
  }, [active])

  // Following's restored items, warm before the feed asks (RF-B7).
  const timeline = useSyncExternalStore(subscribeRefractGate, () =>
    refractTimelineActive(),
  )
  useEffect(() => {
    if (!timeline) return
    prewarmRefractTimeline()
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') prewarmRefractTimeline()
    })
    return () => subscription.remove()
  }, [timeline])

  useEffect(() => {
    watchVisitorForm(restoredVisitorForm, () => {
      markVisitorEntriesStale()
      refreshRestoredQueries()
    })
    return onOwnRelationsLoaded(() => {
      markAllEntriesStale()
      refreshRestoredQueries()
    })
  }, [])

  return null
}
