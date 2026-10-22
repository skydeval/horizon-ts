import {useLingui} from '@lingui/react/macro'
import {useQueryClient} from '@tanstack/react-query'

import {emitSoftReset} from '#/state/events'
import {useSession} from '#/state/session'
import {useIsMember} from '#/horizon/private/membership'
import {
  type NotificationsMode,
  offersNotificationsSwitch,
  setNotificationsMode,
  useNotificationsMode,
} from '#/horizon/private/notifications/mode'
import {usePrivateUnreadCount} from '#/horizon/private/notifications/query'
import {pressNotificationsModeTab} from '#/horizon/private/notifications/refresh'
import {FolderTabs} from '#/horizon/private/tabs/FolderTabs'

/**
 * The Public | Private switch above the notification pills (Notif 2), drawn
 * as a pair of folder tabs (9.1), the Private tab carrying prism's unread
 * count (2H design 10.5). Members only; nothing renders for anyone else.
 * Pressing Private refreshes the Private list, see
 * `pressNotificationsModeTab`.
 */
export function NotificationsModeSwitch() {
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const queryClient = useQueryClient()
  const isMember = useIsMember()
  const mode = useNotificationsMode()
  const unread = usePrivateUnreadCount()
  const badge = !unread ? undefined : unread >= 30 ? '30+' : String(unread)

  if (!currentAccount || !offersNotificationsSwitch(isMember)) return null

  const onPress = (next: NotificationsMode) =>
    pressNotificationsModeTab({
      queryClient,
      did: currentAccount.did,
      current: mode,
      next,
      unread,
      select: chosen => setNotificationsMode(currentAccount.did, chosen),
      softReset: emitSoftReset,
    })

  return (
    <FolderTabs<NotificationsMode>
      testID="notificationsModeTabs"
      tabs={[
        {key: 'public', label: l`Public`},
        {key: 'private', label: l`Private`, badge},
      ]}
      selected={mode}
      onSelect={next => onPress(next)}
      onReselect={next => onPress(next)}
    />
  )
}
