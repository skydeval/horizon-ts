/*
 * The client mute filter (activity subscriptions design 2.5, AS1-L4). prism
 * applies only the mutes it stores, and Horizon sends `muteActor` to
 * Bluesky, which keeps a bell when its subject is muted. So the private
 * list and the nav badge's private-only count drop authors the member muted
 * on Bluesky, read with `app.bsky.graph.getMutes` as the stock mutes screen
 * does.
 *
 * The list is cached under the stock root (`my-muted-accounts`), so the
 * stock mute and unmute mutations' invalidation refreshes it, as a
 * `string[]` with no `pages`, which the profile shadow's walk passes over.
 * Until it loads it counts as empty, and nothing waits for it. Mutes for
 * reposts only are not filtered. It is read only for a member with the
 * feature listed. The filters themselves are in `mute-filter.ts`.
 */

import {type Client} from '@atproto/lex'
import {useQuery} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {useActivitySubscriptionsShown} from '#/horizon/private/activity-subscriptions/hooks'
import {usePrivateFeedSource} from '#/horizon/private/membership'
import {app} from '#/lexicons'

/** Mutes per `getMutes` request. */
export const MUTES_PAGE_SIZE = 100

/** How many pages of mutes are read at most. */
export const MUTES_MAX_PAGES = 10

/** The stock mutes list's query root. */
const MUTES_ROOT = 'my-muted-accounts'

export function mutedDidsQueryKey(did: string) {
  return [MUTES_ROOT, 'dids', did]
}

/**
 * The DIDs the reader muted on Bluesky, at most 10 pages of 100. A scoped
 * mute (reposts only, or quote posts only) is left out: it does not mute the
 * author's posts.
 */
export async function fetchMutedDids(appview: Client): Promise<string[]> {
  const dids: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < MUTES_MAX_PAGES; page++) {
    const res = await appview.call(app.bsky.graph.getMutes, {
      limit: MUTES_PAGE_SIZE,
      cursor,
    })
    for (const mute of res.mutes) {
      if (mute.viewer?.mutedOnlyReposts || mute.viewer?.mutedOnlyQuoteposts) {
        continue
      }
      dids.push(mute.did)
    }
    if (!res.cursor || res.cursor === cursor) break
    cursor = res.cursor
  }
  return dids
}

/**
 * The reader's muted DIDs; empty without the feature, and until the list
 * loads.
 */
export function useMutedDids(): ReadonlySet<string> {
  const source = usePrivateFeedSource()
  const shown = useActivitySubscriptionsShown()
  const enabled = !!source && shown
  const {data} = useQuery({
    enabled,
    staleTime: STALE.MINUTES.FIVE,
    queryKey: mutedDidsQueryKey(source?.did ?? ''),
    queryFn: () => {
      if (!source) throw new Error('muted dids: no source')
      return fetchMutedDids(source.appview)
    },
  })
  return new Set(enabled ? (data ?? []) : [])
}
