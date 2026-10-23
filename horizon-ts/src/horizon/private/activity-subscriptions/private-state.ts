/*
 * prism's state of the private pair (activity subscriptions design 2.2): the
 * account's whole list of private subscriptions, read to its end into one
 * query, the per-subject selector with the overlay of pending presses, the
 * cache write the saver uses, and the prefetch.
 *
 * The list is not persisted: the private toggles are enabled only once this
 * run's member-gated read has loaded, which stands in for a membership
 * confirmed in this run.
 */

import {useEffect, useSyncExternalStore} from 'react'
import {type Client} from '@atproto/lex'
import {type QueryClient, useQuery, useQueryClient} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {listPrismSubscriptions} from '#/horizon/private/activity-subscriptions/api'
import {
  type Flags,
  isOn,
  OFF,
  sameFlags,
} from '#/horizon/private/activity-subscriptions/common'
import {useActivitySubscriptionsShown} from '#/horizon/private/activity-subscriptions/hooks'
import {getActivitySavers} from '#/horizon/private/activity-subscriptions/saver'
import {usePrivateFeedSource} from '#/horizon/private/membership'

/** Each subject with a flag on; an absent subject is off. */
export type PrivateFlagsMap = Record<string, Flags>

/** prism's page size, and the most pages read (a cap of at most 3000). */
export const PRISM_PAGE_LIMIT = 100
export const PRISM_MAX_PAGES = 30

export const PRIVATE_ACTIVITY_SUBSCRIPTIONS_ROOT =
  'private-activity-subscriptions'

export function privateActivitySubscriptionsKey(did: string) {
  return [PRIVATE_ACTIVITY_SUBSCRIPTIONS_ROOT, did]
}

/**
 * prism's list to its end (pages of 100, at most 30), as a map from subject
 * to flags. Throws if any page fails. `shared` goes to every page
 * (`listPrismSubscriptions`): the query keeps the default, and prism's truth
 * read passes `false`, so it never takes a throttled lead's body.
 */
export async function readAllPrismSubscriptions(
  prism: Client,
  {shared = true}: {shared?: boolean} = {},
): Promise<PrivateFlagsMap> {
  const map: PrivateFlagsMap = {}
  let cursor: string | undefined
  for (let page = 0; page < PRISM_MAX_PAGES; page++) {
    const res = await listPrismSubscriptions(
      prism,
      {limit: PRISM_PAGE_LIMIT, cursor},
      {shared},
    )
    for (const row of res.rows) {
      if (isOn(row.flags)) map[row.subject] = row.flags
    }
    if (!res.cursor) break
    cursor = res.cursor
  }
  return map
}

/** The account's prism source while the private pair applies, else none. */
function useSource() {
  const source = usePrivateFeedSource()
  const shown = useActivitySubscriptionsShown()
  return shown ? source : undefined
}

function listOptions(did: string, prism: Client | undefined) {
  return {
    queryKey: privateActivitySubscriptionsKey(did),
    queryFn: () =>
      prism
        ? readAllPrismSubscriptions(prism)
        : Promise.reject(new Error('No prism client')),
    staleTime: STALE.MINUTES.FIVE,
  }
}

/**
 * The account's private subscriptions: one query per account, enabled for a
 * member while the feature is shown. The app's `retry: false` holds, so a
 * failed read is read again only when a new observer mounts.
 */
export function usePrivateActivitySubscriptions() {
  const source = useSource()
  const did = source?.did ?? ''
  const prism = source?.prism
  return useQuery({...listOptions(did, prism), enabled: !!prism})
}

/**
 * The subject's private flags and whether prism's list has loaded:
 * - off whenever the query is disabled (a disabled query keeps its cached
 *   data, so a demoted member would otherwise keep a lit icon);
 * - the saver's pending press while the subject's prism saver is not idle
 *   (the overlay), so no fetch that lands can undo it;
 * - otherwise the list's flags, off when absent.
 *
 * The saver's state is read with `useSyncExternalStore`, so the saver going
 * idle re-renders the caller on its own.
 */
export function usePrivateFlags(subject: string): {
  flags: Flags
  loaded: boolean
} {
  const source = useSource()
  const did = source?.did
  const {data} = usePrivateActivitySubscriptions()
  const saver = getActivitySavers().prism
  const pending = useSyncExternalStore(saver.subscribe, () =>
    did ? saver.pending(did, subject) : undefined,
  )
  if (!source) return {flags: OFF, loaded: false}
  const loaded = data !== undefined
  if (pending) return {flags: pending, loaded}
  return {flags: data?.[subject] ?? OFF, loaded}
}

/**
 * Whether either private toggle is on for the subject (the bell icon, hook
 * Btn 1). Off while prism's list is disabled or not loaded.
 */
export function usePrivateBellOn(subject: string): boolean {
  return isOn(usePrivateFlags(subject).flags)
}

/** The subject's flags in the list's cache, with no overlay (off when absent). */
export function readCachedPrivateFlags(
  queryClient: QueryClient | undefined,
  did: string,
  subject: string,
): Flags {
  const data = queryClient?.getQueryData<PrivateFlagsMap>(
    privateActivitySubscriptionsKey(did),
  )
  return data?.[subject] ?? OFF
}

/**
 * Write the subject's flags into the list's cache: the press, an accepted
 * put's returned flags, a truth read's, or a revert. A list not loaded is
 * left unloaded, and an unchanged value is not written.
 */
export function setPrivateFlags(
  queryClient: QueryClient | undefined,
  did: string,
  subject: string,
  flags: Flags,
) {
  if (!queryClient) return
  const key = privateActivitySubscriptionsKey(did)
  const old = queryClient.getQueryData<PrivateFlagsMap>(key)
  if (!old || sameFlags(old[subject] ?? OFF, flags)) return
  const next = {...old}
  if (isOn(flags)) next[subject] = flags
  else delete next[subject]
  queryClient.setQueryData<PrivateFlagsMap>(key, next)
}

/**
 * Prefetch the list once the account is a member with the feature shown
 * (2.2, the pre-warm), so neither the icon nor the dialog waits on it.
 */
export function usePrivateActivityPrefetch() {
  const source = useSource()
  const queryClient = useQueryClient()
  const did = source?.did
  const prism = source?.prism
  useEffect(() => {
    if (!did || !prism) return
    void queryClient.prefetchQuery(listOptions(did, prism))
  }, [did, prism, queryClient])
}
