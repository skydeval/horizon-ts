/*
 * The activity subscriptions host (activity subscriptions design 2.3),
 * mounted in `HorizonHost` beside `AppearanceSync`. It renders nothing: for
 * the signed-in account, once its clients are published, it runs the prism
 * mirror for keys left from an earlier run (20 s after mount), on each
 * return to the foreground and on membership and feature answers, and the
 * hourly reconcile while its conditions hold (`tab.ts`).
 */

import {useEffect} from 'react'

import {useSession} from '#/state/session'
import {
  getActivityTab,
  startActivitySync,
} from '#/horizon/private/activity-subscriptions/tab'
import {
  isCurrentFor,
  useCurrentClients,
} from '#/horizon/routing/current-clients'
import {PRIVATE_ACTIVITY_SUBSCRIPTIONS} from '#/horizon/switches'

export function ActivitySubscriptionsSync() {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const record = useCurrentClients()
  const published = isCurrentFor(record, did)

  useEffect(() => {
    if (!PRIVATE_ACTIVITY_SUBSCRIPTIONS || !did || !published) return
    return startActivitySync(getActivityTab(), did)
  }, [did, published])

  return null
}
