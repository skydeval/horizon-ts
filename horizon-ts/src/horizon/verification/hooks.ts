/*
 * The badge catalogue (kept across restarts, so badges draw at once on
 * launch) and the badges one account holds (batched by `heldBadgesLoader`).
 */

import {useQuery} from '@tanstack/react-query'

import {GCTIME, STALE} from '#/state/queries'
import {usePreferencesQuery} from '#/state/queries/preferences'
import {createQueryKey} from '#/state/queries/util'
import {fetchBadgeCatalog, heldBadgesLoader} from './api'
import {badgesToShow, type ShownBadge} from './badges'

const badgeCatalogKey = createQueryKey(
  'horizon-badge-catalog',
  {},
  {persistedVersion: 1},
)

export function useBadgeCatalogQuery() {
  return useQuery({
    queryKey: badgeCatalogKey,
    gcTime: GCTIME.INFINITY,
    staleTime: STALE.HOURS.ONE,
    queryFn: () => fetchBadgeCatalog(),
  })
}

export function useHeldBadgesQuery(did: string | undefined) {
  return useQuery({
    queryKey: ['horizon-held-badges', did],
    enabled: !!did,
    staleTime: STALE.MINUTES.ONE,
    initialData: did ? heldBadgesLoader.peek(did) : undefined,
    queryFn: () => heldBadgesLoader.load(did!),
  })
}

/**
 * The badges to draw for `did`, in the catalogue's order; none while either
 * read is pending, or when the reader hides verification badges.
 */
export function useShownBadges(did: string | undefined): ShownBadge[] {
  const {data: catalog} = useBadgeCatalogQuery()
  const {data: held} = useHeldBadgesQuery(did)
  const {data: preferences} = usePreferencesQuery()
  if (preferences?.verificationPrefs?.hideBadges) return []
  return badgesToShow(held, catalog)
}
