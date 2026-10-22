import {useEffect} from 'react'
import {AppState} from 'react-native'

import {
  DIRECT_PREFETCH_2K,
  startDirectTokenPrefetch,
} from '#/horizon/routing/prism-direct'

/**
 * The `getPosts` token's prefetch and background refresh on posting route
 * `encode` (2K design PA-29), while the app is in the foreground. Mounted in
 * `HorizonHost`, which remounts on every account change; the prefetch
 * follows the route itself.
 */
export function DirectPrismPrefetch() {
  useEffect(
    () =>
      startDirectTokenPrefetch(DIRECT_PREFETCH_2K, {
        isForeground: () => AppState.currentState === 'active',
        subscribe: listener => {
          const subscription = AppState.addEventListener('change', listener)
          return () => subscription.remove()
        },
      }),
    [],
  )
  return null
}
