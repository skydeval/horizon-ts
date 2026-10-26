import {useEffect} from 'react'
import {AppState} from 'react-native'

import {useSession} from '#/state/session'
import {
  type DirectPrefetchOptions,
  DirectPrismRateLimitedError,
  getDirectPrismClient,
  getDirectPrismToken,
  startDirectTokenPrefetch,
} from '#/horizon/routing/prism-direct'
import {THREAD_LENS} from '#/horizon/switches'
import {useLensServed} from '#/horizon/thread-lens/availability'
import {
  installLensDirect,
  LENS_GET_THREAD_LXM,
} from '#/horizon/thread-lens/direct'
import {preconnectPrism} from '#/horizon/thread-lens/preconnect'
import {useThreadLensPreference} from '#/horizon/thread-lens/preference'

// The lens's direct transport (`direct.ts`), installed as this module loads.
installLensDirect({
  token: (pdsClient, lxm) => getDirectPrismToken(pdsClient, lxm),
  client: getDirectPrismClient,
  limitedUntil: error =>
    error instanceof DirectPrismRateLimitedError ? error.retryAt : undefined,
})

/**
 * The lens's direct token: `getThread`'s only, on every posting route (the
 * lens serves non-members too). `resolve` (Retry) mints on first use.
 */
export const LENS_DIRECT_PREFETCH: DirectPrefetchOptions = {
  methods: [LENS_GET_THREAD_LXM],
  routes: 'any',
}

/**
 * The `getThread` token's prefetch and background refresh while the lens is
 * active for the current account and the app is in the foreground (speed
 * pass, 2026-10-23), so a thread's first direct call (`direct.ts`) does not
 * wait for `getServiceAuth`. Mounted in `HorizonHost`, which remounts on
 * every account change.
 */
export function ThreadLensTokenPrefetch() {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const on = useThreadLensPreference(did)
  const served = useLensServed(did)
  const active = THREAD_LENS && !!did && on && served
  useEffect(() => {
    if (!active) return
    const unhint = preconnectPrism()
    const stop = startDirectTokenPrefetch(LENS_DIRECT_PREFETCH, {
      isForeground: () => AppState.currentState === 'active',
      subscribe: listener => {
        const subscription = AppState.addEventListener('change', listener)
        return () => subscription.remove()
      },
    })
    return () => {
      stop()
      unhint()
    }
  }, [active])
  return null
}
