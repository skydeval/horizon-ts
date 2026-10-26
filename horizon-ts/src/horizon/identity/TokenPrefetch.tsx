import {useEffect} from 'react'
import {AppState} from 'react-native'

import {useSession} from '#/state/session'
import {GET_RECORDS_LXM, LIST_MEMBERS_LXM} from '#/horizon/identity/reads'
import {
  type DirectPrefetchOptions,
  startDirectTokenPrefetch,
} from '#/horizon/routing/prism-direct'
import {
  IDENTITY_PRISM_READS,
  PLURAL_DISPLAY,
  PRONOUNS,
} from '#/horizon/switches'

/**
 * S-2's direct tokens: `getRecords` and `listMembers`, on every posting
 * route (identity reads serve every signed-in reader, member or not).
 */
export const IDENTITY_DIRECT_PREFETCH: DirectPrefetchOptions = {
  methods: [GET_RECORDS_LXM, LIST_MEMBERS_LXM],
  routes: 'any',
}

/**
 * The S-2 tokens' prefetch and background refresh while pronouns or plural
 * display is on and the app is in the foreground (Phase 5 design 4.4,
 * P5R4-L3), so once its mint has answered a page's identity call has no
 * minting hop; at a cold start the first call joins the mint in flight
 * (P5R5-N7). Mounted in `HorizonHost`, which remounts on every account
 * change, beside `ThreadLensTokenPrefetch`, which it copies.
 */
export function IdentityTokenPrefetch() {
  const {currentAccount} = useSession()
  const active =
    IDENTITY_PRISM_READS &&
    (PRONOUNS || PLURAL_DISPLAY) &&
    !!currentAccount?.did
  useEffect(() => {
    if (!active) return
    return startDirectTokenPrefetch(IDENTITY_DIRECT_PREFETCH, {
      isForeground: () => AppState.currentState === 'active',
      subscribe: listener => {
        const subscription = AppState.addEventListener('change', listener)
        return () => subscription.remove()
      },
    })
  }, [active])
  return null
}
