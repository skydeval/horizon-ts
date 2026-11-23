import {useEffect} from 'react'
import {AppState} from 'react-native'

import {type PrivateFeedSource} from '#/horizon/private/membership'
import {prefetchPrivateTop} from './prefetch'

/**
 * Following's first kryphocron page, read ahead (`prefetch.ts`): as soon as
 * the account is a member, and each time the app comes back to the front.
 * Mounted in `HorizonHost`, which remounts on every account change. Renders
 * nothing.
 */
export function PrivateTimelinePrefetch({
  source,
}: {
  source: PrivateFeedSource | undefined
}) {
  const did = source?.did
  const prism = source?.prism
  const appview = source?.appview
  useEffect(() => {
    if (!did || !prism || !appview) return
    const read = () => prefetchPrivateTop({did, prism, appview})
    read()
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') read()
    })
    return () => subscription.remove()
  }, [did, prism, appview])
  return null
}
