import {useLayoutEffect} from 'react'
import {useQueryClient} from '@tanstack/react-query'

import {
  useAppviewClient,
  useMaybeChatClient,
  useMaybePdsClient,
  useSession,
} from '#/state/session'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {getPrismClient} from '#/horizon/routing/prism'

/**
 * Publishes the signed-in account's clients for code outside React (see
 * `current-clients.ts`). Mounted first in `HorizonHost`; clears the record
 * when it unmounts or the account signs out. The record is published again
 * whenever a client changes, so a same-account bundle replacement reaches
 * the outbox's next call (2K design PA-28 step 7).
 */
export function CurrentClientsPublisher() {
  const {currentAccount} = useSession()
  const pdsClient = useMaybePdsClient()
  const chatClient = useMaybeChatClient()
  const appviewClient = useAppviewClient()
  const queryClient = useQueryClient()
  const did = currentAccount?.did
  const handle = currentAccount?.handle
  const pdsUrl = currentAccount?.pdsUrl ?? currentAccount?.service

  useLayoutEffect(() => {
    if (!did || !handle || !pdsClient) {
      clearCurrentClients()
      return
    }
    const record: CurrentClients = {
      did,
      handle,
      pdsUrl,
      pdsClient,
      prismClient: getPrismClient(pdsClient),
      appviewClient,
      chatClient: chatClient ?? undefined,
      queryClient,
    }
    publishCurrentClients(record)
    return () => clearCurrentClients(record)
  }, [did, handle, pdsUrl, pdsClient, appviewClient, chatClient, queryClient])

  return null
}
