/*
 * The posting account's private routes (Phase 5 design 8.5, P5R7-N2). The
 * composer's blockers take them as an argument (PA-26).
 *
 * For the current account they are its own routes, unchanged. For another
 * account chosen in the "Posting as" control, Private is offered only on
 * repo route `locus` (known from the stored account's PDS URL, no probe):
 * there its routes are passed as they are. On any other repo route,
 * whatever its posting route (`encode` included), the composer is handed
 * posting route `none` with reason `other-account` ("Switch to @other to
 * post privately."): the outbox's background job only runs for the current
 * account, and nothing probes another account's membership.
 */

import {useSyncExternalStore} from 'react'

import {useCanPostPrivately} from '#/horizon/private/membership'
import {
  currentRoutes,
  getWriteRoute,
  noPostingRoutes,
  type PostingRouteReason,
  type PrivateWriteRoute,
  subscribeWriteRoutes,
  type WriteRoutes,
} from '#/horizon/routing/write-route'
import {
  getPostingState,
  isPostingAsOther,
  subscribePosting,
} from './compose-store'

/**
 * The routes the composer hands its blockers for posting account `did`,
 * given the current account's `own` routes.
 */
export function postingRoutesFor(
  did: string | undefined,
  currentDid: string | undefined,
  own: WriteRoutes,
): WriteRoutes {
  if (!did || did === currentDid) return own
  const routes = getWriteRoute(did)
  return routes.repoRoute === 'locus'
    ? routes
    : noPostingRoutes(routes.repoRoute, 'other-account')
}

function getPostingRoutes(): WriteRoutes {
  const s = getPostingState()
  const own = currentRoutes()
  if (!isPostingAsOther(s)) return own
  return postingRoutesFor(s.did, s.currentDid, own)
}

function subscribe(listener: () => void) {
  const stopRoutes = subscribeWriteRoutes(listener)
  const stopPosting = subscribePosting(listener)
  return () => {
    stopRoutes()
    stopPosting()
  }
}

/**
 * The posting account's routes, kept current: the current account's own
 * routes until another account is chosen.
 */
export function usePostingRoutes(): WriteRoutes {
  return useSyncExternalStore(subscribe, getPostingRoutes)
}

function getPostingHandle(): string | undefined {
  const s = getPostingState()
  return s.active ? s.handle : undefined
}

/** The posting account's handle, for the notes that name it. */
export function usePostingHandle(): string | undefined {
  return useSyncExternalStore(subscribePosting, getPostingHandle)
}

/**
 * {@link useCanPostPrivately} for the posting account: the current
 * account's answer, or for another account, Private offered on `locus` only
 * and the `other-account` note shown otherwise. `handle` is the posting
 * account's.
 */
export function usePostingCanPostPrivately(): {
  offered: boolean
  route: PrivateWriteRoute
  reason: PostingRouteReason | undefined
  showsRouteNote: boolean
  routes: WriteRoutes
  handle: string | undefined
} {
  // Every hook runs unconditionally (rules of hooks).
  const own = useCanPostPrivately()
  const routes = usePostingRoutes()
  const handle = usePostingHandle()
  const other = useSyncExternalStore(subscribePosting, () =>
    isPostingAsOther(getPostingState()),
  )
  if (!other) return {...own, handle}
  return {
    offered: routes.postingRoute === 'locus',
    route: routes.postingRoute,
    reason: routes.reason,
    showsRouteNote: routes.postingRoute === 'none',
    routes,
    handle,
  }
}
