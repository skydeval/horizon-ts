import {useEffect} from 'react'

import {
  getCurrentAppviewClient,
  getCurrentClients,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {servesFeature} from '#/horizon/routing/features'
import {fetchBlockStates, fetchListShown} from './api'
import {connectBlockState, dropBlockStates} from './state'

// The AppView client's block state comes from here (see `state.ts`).
connectBlockState({
  serves: did => servesFeature('blocks.check', did),
  fetchStates: (pdsClient, others) => fetchBlockStates(pdsClient, others),
  listShown: uri => {
    const appview = getCurrentAppviewClient()
    return appview ? fetchListShown(appview, uri) : Promise.resolve(false)
  },
})

/**
 * Drops cached block state when the account changes or signs out. Renders
 * nothing. Mounted once, in `HorizonHost`.
 */
export function BlockStateSync() {
  useEffect(() => {
    let did = getCurrentClients()?.did
    return subscribeCurrentClients(() => {
      const next = getCurrentClients()?.did
      if (next === did) return
      did = next
      dropBlockStates()
    })
  }, [])
  return null
}
