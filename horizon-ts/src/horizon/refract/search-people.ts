/*
 * Restored accounts on the Search screen's People tab (`search.ts` has the
 * rules). With prism's `refract.search` listed, `refract.searchActors` is
 * paged alongside stock's `searchActors`: restored page N follows stock page
 * N, so a later stock page lands after rows already shown. Without it, the
 * exact-handle `fill` path offers one account. Either way an exact handle
 * goes first (or after the list, once it was scrolled), stock's DIDs are
 * never repeated, and stock's pages never wait.
 */

import {useSyncExternalStore} from 'react'
import {type InfiniteData, useInfiniteQuery} from '@tanstack/react-query'

import {
  exactActorQuery,
  prefixQuery,
  refractSearchActive,
  refractSearchSnapshot,
  type RestoredPlacement,
  searchRestoredActors,
  subscribeRefractSearch,
  useRestoredActorMatches,
  useRestoredPlacement,
} from '#/horizon/refract/search'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type ProfileView = app.bsky.actor.defs.ProfileViewDetailed
type Page = {actors: ProfileView[]; cursor?: string}

/** The People query's root; never persisted (no `persistedVersion`). */
export const REFRACT_PEOPLE_ROOT = 'refract-actor-search'

/**
 * Merge restored pages into stock's: restored page N after stock page N,
 * `exact` first (`'top'`) or after everything (`'end'`), every DID once,
 * stock's first.
 */
export function mergePeoplePages<T extends {did: string}>(
  stockPages: readonly (readonly T[])[],
  restoredPages: readonly (readonly ProfileView[])[],
  {
    exact,
    placement,
  }: {exact: ProfileView | undefined; placement: RestoredPlacement},
): T[] {
  const stockDids = new Set<string>()
  for (const page of stockPages)
    for (const item of page) stockDids.add(item.did)
  const seen = new Set<string>()
  const out: T[] = []
  const add = (item: T) => {
    if (seen.has(item.did)) return
    seen.add(item.did)
    out.push(item)
  }
  const head = exact && !stockDids.has(exact.did) ? exact : undefined
  if (head) seen.add(head.did)
  const pages = Math.max(stockPages.length, restoredPages.length)
  for (let i = 0; i < pages; i++) {
    for (const item of stockPages[i] ?? []) add(item)
    for (const profile of restoredPages[i] ?? []) {
      if (!stockDids.has(profile.did)) add(profile as unknown as T)
    }
  }
  if (!head) return out
  const item = head as unknown as T
  return placement === 'top' ? [item, ...out] : [...out, item]
}

/**
 * The People tab's restored accounts merged into stock's pages, and the
 * restored pager. `scrolled`: the list was scrolled, so a late exact match
 * goes after the list.
 */
export function useRestoredPeople<T extends {did: string}>({
  query,
  active,
  stockPages,
  scrolled,
}: {
  query: string
  active: boolean
  stockPages: readonly (readonly T[])[]
  scrolled: boolean
}): {
  profiles: T[]
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
} {
  const store = useSyncExternalStore(
    subscribeRefractSearch,
    refractSearchSnapshot,
  )
  const q = active ? prefixQuery(query) : undefined
  const searching = !!q && isSearching(store)
  // Without prism's search (or for a DID), the exact-handle `fill` path.
  const fallback = useRestoredActorMatches(active ? query : '', {
    prefix: false,
  })
  const pager = useInfiniteQuery<
    Page,
    Error,
    InfiniteData<Page>,
    readonly unknown[],
    string | undefined
  >({
    queryKey: [REFRACT_PEOPLE_ROOT, getCurrentDid(), q],
    queryFn: ({pageParam}) =>
      searchRestoredActors(q ?? '', {cursor: pageParam}),
    initialPageParam: undefined,
    getNextPageParam: page => page.cursor,
    enabled: searching,
    staleTime: 5 * 60_000,
  })
  const restoredPages = searching
    ? (pager.data?.pages.map(page => page.actors) ?? [])
    : []
  const exactHandle = exactActorQuery(query)
  const exact =
    fallback.actors.find(actor => actor.did === fallback.exactDid) ??
    restoredPages
      .flat()
      .find(actor => actor.handle.toLowerCase() === exactHandle)
  const placement = useRestoredPlacement(query, !!exact, scrolled)
  const profiles = mergePeoplePages(stockPages, restoredPages, {
    exact,
    placement,
  })
  return {
    profiles,
    hasNextPage: searching && !!pager.hasNextPage,
    isFetchingNextPage: pager.isFetchingNextPage,
    fetchNextPage: () => {
      if (searching && pager.hasNextPage && !pager.isFetchingNextPage) {
        void pager.fetchNextPage()
      }
    },
  }
}

function isSearching(_store: string): boolean {
  return refractSearchActive()
}
