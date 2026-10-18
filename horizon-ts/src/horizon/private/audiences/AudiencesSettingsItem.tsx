import {Trans, useLingui} from '@lingui/react/macro'

import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {PersonGroup_Stroke2_Corner2_Rounded as PersonGroupIcon} from '#/components/icons/Person'
import {useIsMember} from '#/horizon/private/membership'
import {PRIVATE_POSTING} from '#/horizon/switches'

/**
 * The Settings row, **Audiences**, for members.
 */
export function AudiencesSettingsItem() {
  const {t: l} = useLingui()
  const isMember = useIsMember()
  if (!PRIVATE_POSTING || !isMember) return null
  return (
    <SettingsList.LinkItem to="/settings/audiences" label={l`Audiences`}>
      <SettingsList.ItemIcon icon={PersonGroupIcon} />
      <SettingsList.ItemText>
        <Trans>Audiences</Trans>
      </SettingsList.ItemText>
    </SettingsList.LinkItem>
  )
}
