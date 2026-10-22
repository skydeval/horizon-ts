import {useEffect} from 'react'
import {AppState} from 'react-native'

import {useSession} from '#/state/session'
import * as Toast from '#/components/Toast'
import {outboxNextUse, subscribeOutboxNotices} from '#/horizon/private/outbox'
import {OutboxAccountWatcher} from '#/horizon/private/outbox/OutboxAccountWatcher'
import {PRIVATE_POSTING} from '#/horizon/switches'

/**
 * The outbox's app-wide part (2K design PA-28), mounted in `HorizonHost`,
 * which remounts on every account change: the account's next use (it became
 * current, or came back to the foreground) decides its records nobody is
 * running; the outbox's toasts are shown; removed accounts lose their
 * records.
 */
export function OutboxHost() {
  const {currentAccount} = useSession()
  const did = currentAccount?.did

  useEffect(
    () =>
      subscribeOutboxNotices(notice => {
        Toast.show(notice.text, {type: notice.type})
      }),
    [],
  )

  useEffect(() => {
    if (!PRIVATE_POSTING || !did) return
    void outboxNextUse(did)
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void outboxNextUse(did)
    })
    return () => subscription.remove()
  }, [did])

  return PRIVATE_POSTING ? <OutboxAccountWatcher /> : null
}
