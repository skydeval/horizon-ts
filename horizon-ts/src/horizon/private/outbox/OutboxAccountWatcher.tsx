import {useEffect} from 'react'
import {AppState} from 'react-native'

import {useSession} from '#/state/session'
import {
  clearDid as clearActivitySubscriptionsDid,
  listDids as activitySubscriptionsDids,
} from '#/horizon/private/activity-subscriptions/dirty-store'
import {forgetRemovedAccount} from '#/horizon/private/outbox'
import {outboxRecordDids} from '#/horizon/private/outbox/record'

/**
 * An account removed from the device takes its outbox with it (2K design
 * PA-28 step 7, K8-N3): its records (each under its run lock; one another
 * tab still holds is tried again at the next run), its in-memory entries,
 * `horizon-outbox-drafts:<did>` and both draft tables. It also takes its
 * activity subscriptions' dirty keys and `reconciled:<did>` record
 * (activity subscriptions design 2.2). Runs at launch, on every change of
 * the accounts and on return to the foreground. `accounts` starts from
 * persisted state, so an empty list at boot never reads as every account
 * removed.
 */
export function OutboxAccountWatcher() {
  const {accounts} = useSession()
  const known = accounts.map(account => account.did).join(' ')

  useEffect(() => {
    const run = () => {
      const kept = new Set(known.split(' ').filter(did => !!did))
      for (const did of outboxRecordDids()) {
        if (!kept.has(did)) void forgetRemovedAccount(did)
      }
      for (const did of activitySubscriptionsDids()) {
        if (!kept.has(did)) clearActivitySubscriptionsDid(did)
      }
    }
    run()
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') run()
    })
    return () => subscription.remove()
  }, [known])

  return null
}
