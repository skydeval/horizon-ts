import {useQuery} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {useMaybePdsClient, useSession} from '#/state/session'
import {audiencesQueryKey, listAudiences} from '#/horizon/private/api/audiences'

/**
 * The current account's audience records.
 */
export function useAudiencesQuery({enabled = true}: {enabled?: boolean} = {}) {
  const {currentAccount} = useSession()
  const pdsClient = useMaybePdsClient()
  const did = currentAccount?.did ?? ''
  return useQuery({
    queryKey: audiencesQueryKey(did),
    queryFn: () => (pdsClient ? listAudiences(pdsClient, did) : []),
    staleTime: STALE.MINUTES.FIVE,
    enabled: enabled && !!pdsClient && !!did,
  })
}
