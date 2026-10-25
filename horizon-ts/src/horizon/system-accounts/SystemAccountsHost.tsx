/*
 * The system accounts' app-wide pieces in `HorizonHost` (system accounts
 * design 4.6, 5.5): the announcer's live regions, mounted empty before any
 * text is written, and the current account's list read in the background on
 * app open and on every account change (the host remounts per account).
 */

import {useEffect} from 'react'

import {
  getCurrentClients,
  useCurrentClients,
} from '#/horizon/routing/current-clients'
import {SYSTEM_ACCOUNTS} from '#/horizon/switches'
import {SystemAccountsAnnouncer} from './Announcer'
import {readList} from './sync'

export function SystemAccountsHost() {
  const did = useCurrentClients()?.did
  useEffect(() => {
    if (!SYSTEM_ACCOUNTS || !did) return
    const clients = getCurrentClients()
    if (clients?.did === did) void readList(did, clients.pdsClient)
  }, [did])
  return <SystemAccountsAnnouncer />
}
