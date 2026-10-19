/*
 * Drives the appearance record's reads and writes (Phase 3 design, 6.4):
 * registers the signed-in account's PDS client with `sync.ts`, reads the
 * record at mount and on every account change, and again when the page or
 * app comes back after five minutes; deletes the copy of an account that has
 * left the session's list. Rendered by `HorizonHost` on web and by `App.tsx`
 * on native.
 */

import {useEffect} from 'react'
import {AppState} from 'react-native'

import {useMaybePdsClient, useSession} from '#/state/session'
import {IS_WEB} from '#/env'
import {deleteAccountCopy, getAppearanceState} from '#/horizon/appearance/store'
import {
  isStale,
  refresh,
  registerAppearanceClient,
  unregisterAppearanceClient,
} from '#/horizon/appearance/sync'
import {APPEARANCE_SYNC, BACKDROPS} from '#/horizon/switches'

/** The sync host. Renders nothing. */
export function AppearanceSync() {
  const {currentAccount, accounts} = useSession()
  const client = useMaybePdsClient()
  const did = currentAccount?.did

  useEffect(() => {
    if (!APPEARANCE_SYNC || !BACKDROPS || !did || !client) return
    registerAppearanceClient(did, client)
    void refresh(did)
    const onReturn = () => {
      if (isStale(did)) void refresh(did)
    }
    if (IS_WEB) {
      const onVisibility = () => {
        if (document.visibilityState === 'visible') onReturn()
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        unregisterAppearanceClient(did)
      }
    }
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') onReturn()
    })
    return () => {
      subscription.remove()
      unregisterAppearanceClient(did)
    }
  }, [did, client])

  useEffect(() => {
    if (!BACKDROPS) return
    const known = new Set<string>(accounts.map(account => account.did))
    for (const copyDid of Object.keys(getAppearanceState().device.accounts)) {
      if (!known.has(copyDid)) deleteAccountCopy(copyDid)
    }
  }, [accounts])

  return null
}
