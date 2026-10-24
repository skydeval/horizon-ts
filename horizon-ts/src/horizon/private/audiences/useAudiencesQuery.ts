import {type Client} from '@atproto/lex'
import {useQuery} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {useMaybePdsClient, useSession} from '#/state/session'
import {audiencesQueryKey, listAudiences} from '#/horizon/private/api/audiences'

/**
 * The current account's audience records, or with `account` (the composer's
 * posting account when it is not the current one, Phase 5 PA-14) that
 * account's, read with its own client.
 */
export function useAudiencesQuery({
  enabled = true,
  account,
}: {
  enabled?: boolean
  account?: {did: string; pdsClient: Client}
} = {}) {
  const {currentAccount} = useSession()
  const currentClient = useMaybePdsClient()
  const pdsClient = account ? account.pdsClient : currentClient
  const did = account ? account.did : (currentAccount?.did ?? '')
  return useQuery({
    queryKey: audiencesQueryKey(did),
    queryFn: () => (pdsClient ? listAudiences(pdsClient, did) : []),
    staleTime: STALE.MINUTES.FIVE,
    enabled: enabled && !!pdsClient && !!did,
  })
}
