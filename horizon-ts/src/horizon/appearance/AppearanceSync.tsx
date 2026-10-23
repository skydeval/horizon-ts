/*
 * Drives the appearance's reads and writes (Phase 3 design, 6.4; storage
 * choice design, section 4): registers the signed-in account's PDS and prism
 * clients with `sync.ts`, reads at mount and on every account change, and
 * again when the page or app comes back after five minutes (membership and
 * feature answers, the removal flow included, run `sync.ts`'s queue from
 * there); deletes the copy of an account that has
 * left the session's list; and applies the account's saved theme settings
 * (`ThemePrefsSync`, change list 2). Rendered by `HorizonHost` on web and
 * by `App.tsx` on native.
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
import {ThemePrefsSync} from '#/horizon/appearance/ThemePrefsSync'
import {getPrismClient} from '#/horizon/routing/prism'
import {APPEARANCE_SYNC, BACKDROPS} from '#/horizon/switches'

/** The sync host. Renders only the theme settings' host. */
export function AppearanceSync() {
  const {currentAccount, accounts} = useSession()
  const client = useMaybePdsClient()
  const did = currentAccount?.did

  useEffect(() => {
    if (!APPEARANCE_SYNC || !BACKDROPS || !did || !client) return
    // prism's client for the member table (storage choice design, section 4).
    registerAppearanceClient(did, client, getPrismClient(client))
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

  // The account's theme settings (change list 2, item 11).
  return <ThemePrefsSync />
}
