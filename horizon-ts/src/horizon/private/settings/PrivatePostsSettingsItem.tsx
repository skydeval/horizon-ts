import {plural} from '@lingui/core/macro'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {useDialogControl} from '#/components/Dialog'
import {Lock_Stroke2_Corner2_Rounded as LockIcon} from '#/components/icons/Lock'
import {useUnsent} from '#/horizon/private/outbox/hooks'
import {PrivatePostsDialog} from '#/horizon/private/settings/PrivatePostsDialog'
import {PRIVATE_POSTING} from '#/horizon/switches'

/**
 * Hook Set 2: the Account settings row "Private posts" (2K design 8.2),
 * opening its dialog. In 2K-9 the dialog holds only Unsent, so the row shows
 * only while the account has Unsent entries, on any posting route; 2K-6
 * shows it to every member.
 */
export function PrivatePostsSettingsItem() {
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const control = useDialogControl()
  const unsent = useUnsent(PRIVATE_POSTING ? did : undefined)
  if (!PRIVATE_POSTING || !did || unsent.length === 0) return null
  return (
    <>
      <SettingsList.PressableItem
        label={l`Private posts`}
        onPress={() => control.open()}>
        <SettingsList.ItemIcon icon={LockIcon} />
        <SettingsList.ItemText>
          <Trans>Private posts</Trans>
        </SettingsList.ItemText>
        <SettingsList.BadgeText>
          {plural(unsent.length, {one: '# unsent', other: '# unsent'})}
        </SettingsList.BadgeText>
        <SettingsList.Chevron />
      </SettingsList.PressableItem>
      <PrivatePostsDialog control={control} did={did} />
    </>
  )
}
