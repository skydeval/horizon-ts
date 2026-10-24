import {useEffect} from 'react'
import {AppState} from 'react-native'

import {useAppviewClient, useSession} from '#/state/session'
import {startMuteCache} from '#/horizon/mutes/cache'
import {useMembership} from '#/horizon/routing/membership'
import {THREAD_LENS} from '#/horizon/switches'
import {useLensServed} from '#/horizon/thread-lens/availability'
import {useThreadLensPreference} from '#/horizon/thread-lens/preference'

/**
 * Keeps the reader's mutes on the device (`mutes/cache.ts`) while Thread
 * Lens is active for a member, the only reader whose lens posts can skip
 * the public-view pass. Mounted in `HorizonHost`, which remounts on every
 * account change, so a mount is a sign-in or an app open.
 */
export function MuteCacheHost() {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const on = useThreadLensPreference(did)
  const served = useLensServed(did)
  const member = useMembership(did) === 'member'
  const appview = useAppviewClient()
  const active = THREAD_LENS && !!did && on && served && member
  useEffect(() => {
    if (!active || !did) return
    return startMuteCache(did, appview, {
      isForeground: () => AppState.currentState === 'active',
      subscribe: listener => {
        const subscription = AppState.addEventListener('change', listener)
        return () => subscription.remove()
      },
    })
  }, [active, did, appview])
  return null
}
