/*
 * The cairn labelers the signed-in account moderates for, with its
 * permissions on each.
 *
 * Only cairn's own labelers are asked: the instance's primary, and any
 * labeler the account subscribes to whose labeler service is hosted by the
 * operator's cairn (its address, or a subdomain of it). Other labelers are
 * never asked, so they don't learn the account looked.
 */

import {type DidString} from '@atproto/syntax'
import {interpretLabelValueDefinitions} from '@bsky/sdk/moderation'
import {useQuery} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {usePreferencesQuery} from '#/state/queries/preferences'
import {useAppviewClient, usePdsClient, useSession} from '#/state/session'
import {cairnUrl, useCairnPrimaryLabeler} from '#/horizon/cairn/primary-labeler'
import {app} from '#/lexicons'
import {getMyPermissions} from './api'
import {isCairnHosted, labelerEndpoint} from './hosts'
import {type TeamLabeler} from './permissions'

export {PERMISSIONS, SYSTEM_LABEL_VALUES, type TeamLabeler} from './permissions'

/** The labelers this account moderates for (`[]` for everyone else). */
export function useTeamLabelersQuery() {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const pdsClient = usePdsClient()
  const appviewClient = useAppviewClient()
  const primary = useCairnPrimaryLabeler()
  const {data: prefs} = usePreferencesQuery()
  const subscribed = (prefs?.moderationPrefs.labelers ?? []).map(
    entry => entry.did as string,
  )
  const candidates = Array.from(
    new Set([...(primary ? [primary] : []), ...subscribed]),
  ).sort()

  return useQuery({
    queryKey: ['horizon-moderate-team', did, candidates],
    enabled: !!did && !!cairnUrl() && candidates.length > 0,
    staleTime: STALE.MINUTES.FIVE,
    queryFn: async (): Promise<TeamLabeler[]> => {
      const asked = await Promise.all(
        candidates.map(async labeler => {
          if (labeler !== primary) {
            const endpoint = await labelerEndpoint(labeler)
            if (!isCairnHosted(endpoint)) return undefined
          }
          try {
            const answer = await getMyPermissions(pdsClient, labeler)
            return answer.member && answer.permissions.length > 0
              ? {labeler, permissions: answer.permissions}
              : undefined
          } catch {
            return undefined
          }
        }),
      )
      const members = asked.filter(each => each !== undefined)
      if (members.length === 0) return []
      const {views} = await appviewClient.call(app.bsky.labeler.getServices, {
        dids: members.map(each => each.labeler as DidString),
        detailed: true,
      })
      return members.map(({labeler, permissions}) => {
        const view = (
          views as app.bsky.labeler.defs.LabelerViewDetailed[]
        ).find(each => each?.creator?.did === labeler)
        return {
          did: labeler,
          name:
            view?.creator.displayName ||
            (view ? `@${view.creator.handle}` : labeler),
          permissions: new Set(permissions),
          defs: view ? interpretLabelValueDefinitions(view) : [],
          reasonTypes: (view?.reasonTypes ?? []).map(String),
        }
      })
    },
  })
}
