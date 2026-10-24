import {useCallback, useMemo} from 'react'
import {moderateProfile, type ModerationOpts} from '@bsky/sdk/moderation'
import {keepPreviousData, useQuery} from '@tanstack/react-query'

import {isJustAMute, moduiContainsHideableOffense} from '#/lib/moderation'
import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {STALE} from '#/state/queries'
import {DEFAULT_LOGGED_OUT_PREFERENCES} from '#/state/queries/preferences'
import {useAppviewClient} from '#/state/session'
import {
  type AutocompleteApi,
  type AutocompleteItem,
  type AutocompleteItemType,
  type AutocompleteProfile,
} from '#/components/Autocomplete/types'
// HORIZON: restored (Refract) accounts in the search box
import {
  useRestoredActorMatches,
  useRestoredPlacement,
  withRestoredActors,
} from '#/horizon/refract/search'
import {app} from '#/lexicons'
import {useEmojiSearch} from './useEmojiSearch'

const DEFAULT_MOD_OPTS = {
  userDid: undefined,
  prefs: DEFAULT_LOGGED_OUT_PREFERENCES.moderationPrefs,
}

export function useAutocomplete({
  type,
  query: q,
  limit,
  showSearchFallback = false,
  restored = false,
  navigated = false,
}: {
  type: AutocompleteItemType
  query: string
  limit?: number
  showSearchFallback?: boolean
  /**
   * HORIZON: offer a restored (Refract) account the query names exactly,
   * first; the search box only.
   */
  restored?: boolean
  /**
   * HORIZON: the reader moved through the list with the keyboard, so a late
   * restored entry goes after the list instead of first.
   */
  navigated?: boolean
}): AutocompleteApi {
  const client = useAppviewClient()
  const moderationOpts = useModerationOpts()
  const emojiSearch = useEmojiSearch()

  const query = useQuery({
    staleTime: STALE.MINUTES.ONE,
    queryKey: [
      'autocomplete',
      {
        type,
        query: q,
      },
    ],
    async queryFn() {
      if (type === 'profile') {
        // TODO return recents
        if (!q) return []

        // Going from "foo" to "foo." should not clear matches.
        q = q.toLowerCase().trim().replace(/\.$/, '')

        const data = await client.call(app.bsky.actor.searchActorsTypeahead, {
          q,
          limit: limit || 8,
        })

        return (data?.actors || []).map(profile => ({
          key: profile.did,
          type: 'profile' as const,
          value: '@' + profile.handle,
          profile,
        }))
      } else if (type === 'emoji') {
        return emojiSearch(q, limit || 8)
      }

      return []
    },
    select: useCallback(
      (items: AutocompleteItem[]) => {
        const seen = new Set<string>()
        let results: AutocompleteItem[] = []

        for (const item of items) {
          if (seen.has(item.key)) continue
          seen.add(item.key)

          if (item.type === 'profile') {
            const moderated = moderateProfileItem({
              query: q,
              item,
              moderationOpts: moderationOpts || DEFAULT_MOD_OPTS,
            })
            if (moderated) results.push(moderated)
          } else {
            results.push(item)
          }
        }

        return results
      },
      [q, moderationOpts],
    ),
    placeholderData: keepPreviousData,
  })

  // HORIZON: restored (Refract) accounts, merged when they arrive
  const restoredMatches = useRestoredActorMatches(
    type === 'profile' && restored ? q : '',
  )
  const restoredItems = restoredMatches.actors.filter(profile =>
    moderateProfileItem({
      query: q.toLowerCase().trim().replace(/^@/, ''),
      item: profileItem(profile),
      moderationOpts: moderationOpts || DEFAULT_MOD_OPTS,
    }),
  )
  const restoredAt = useRestoredPlacement(
    q,
    restoredItems.some(profile => profile.did === restoredMatches.exactDid),
    navigated,
  )

  const items = useMemo(() => {
    if (!query.data && restoredItems.length === 0) {
      return []
    }

    let results = [...(query.data ?? [])]

    if (showSearchFallback && q) {
      results.unshift({
        key: `search-${q}`,
        type: 'search' as const,
        value: q,
      })
    }

    // HORIZON: restored (Refract) accounts, never delaying stock's
    results = withRestoredActors(results, restoredItems, {
      placement: restoredAt,
      didOf: item => (item.type === 'profile' ? item.profile.did : undefined),
      toItem: profileItem,
      exact: restoredMatches.exactDid,
      leading: showSearchFallback && q ? 1 : 0,
    })

    return results
  }, [
    query.data,
    showSearchFallback,
    q,
    restoredItems,
    restoredAt,
    restoredMatches.exactDid,
  ])

  return {
    query: q,
    items,
    isFetching: query.isFetching,
  }
}

function profileItem(profile: AutocompleteProfile['profile']) {
  return {
    key: profile.did,
    type: 'profile' as const,
    value: '@' + profile.handle,
    profile,
  }
}

function moderateProfileItem({
  query,
  item,
  moderationOpts,
}: {
  query: string
  item: AutocompleteProfile
  moderationOpts: ModerationOpts
}) {
  const modui = moderateProfile(item.profile, moderationOpts).ui('profileList')
  const isExactMatch = query && item.profile.handle.toLowerCase() === query

  if (
    (isExactMatch && !moduiContainsHideableOffense(modui)) ||
    !modui.filter ||
    isJustAMute(modui)
  ) {
    return item
  }

  return null
}
