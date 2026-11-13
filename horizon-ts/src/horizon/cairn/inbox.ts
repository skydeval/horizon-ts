/*
 * The cairn moderation inbox: the user's reports to the operator's cairn
 * instance, from its primary labeler, which gathers every labeler of the
 * instance (kryphocron ones included). Same `tools.ozone.inbox.*` methods as
 * Bluesky's, proxied to the primary. Nothing is asked without a primary.
 */

import {type DidString} from '@atproto/syntax'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {createQueryKey} from '#/state/queries/util'
import {useAppviewClient, useSession} from '#/state/session'
import {useCairnPrimaryLabeler} from '#/horizon/cairn/primary-labeler'
import {tools} from '#/lexicons'

const QUERY_KEY_ROOT = 'moderation-inbox'

type ReportsFilter = NonNullable<
  tools.ozone.inbox.listReports.$Params['filter']
>

export type InboxReport =
  tools.ozone.inbox.listReports.$OutputBody['reports'][number]

function service(did: string) {
  return `${did as DidString}#atproto_labeler` as const
}

/** The user's reports to the cairn instance, while it has a primary. */
export function useCairnInboxReportsQuery(filter: ReportsFilter) {
  const client = useAppviewClient()
  const {currentAccount, hasSession} = useSession()
  const did = currentAccount?.did
  const primary = useCairnPrimaryLabeler()

  return useInfiniteQuery({
    queryKey: createQueryKey(QUERY_KEY_ROOT, {
      did,
      endpoint: 'cairnReports',
      primary,
      filter,
    }),
    queryFn: async ({pageParam}) =>
      await client.call(
        tools.ozone.inbox.listReports,
        {filter, limit: 100, cursor: pageParam},
        {service: service(primary ?? '')},
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.cursor,
    staleTime: STALE.MINUTES.ONE,
    enabled: hasSession && !!did && !!primary,
  })
}

/** Unread report count at the cairn instance (0 without a primary). */
export function useCairnInboxUnreadReportsQuery() {
  const client = useAppviewClient()
  const {currentAccount, hasSession} = useSession()
  const did = currentAccount?.did
  const primary = useCairnPrimaryLabeler()

  return useQuery({
    queryKey: createQueryKey(QUERY_KEY_ROOT, {
      did,
      endpoint: 'cairnUnreadCount',
      primary,
    }),
    queryFn: async () =>
      await client.call(
        tools.ozone.inbox.getUnreadCount,
        {},
        {service: service(primary ?? '')},
      ),
    staleTime: STALE.SECONDS.THIRTY,
    enabled: hasSession && !!did && !!primary,
    select: data => data.unreadCounts.reports ?? 0,
  })
}

/** Mark the user's cairn reports as read. */
export function useMarkCairnReportsSeenMutation() {
  const client = useAppviewClient()
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const primary = useCairnPrimaryLabeler()

  return useMutation({
    mutationFn: async () => {
      if (!primary) return
      await client.call(
        tools.ozone.inbox.updateSeen,
        {sections: ['reports']},
        {service: service(primary)},
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: createQueryKey(QUERY_KEY_ROOT, {did: currentAccount?.did}),
      })
    },
  })
}
