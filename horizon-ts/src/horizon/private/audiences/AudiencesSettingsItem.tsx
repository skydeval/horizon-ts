import {Trans, useLingui} from '@lingui/react/macro'

import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {PersonGroup_Stroke2_Corner2_Rounded as PersonGroupIcon} from '#/components/icons/Person'
import {useIsMember} from '#/horizon/private/membership'
import {PRIVATE_POSTING, PRIVATE_POSTING_DEFAULTS} from '#/horizon/switches'

/**
 * The Settings row, **Audiences**, for members. Not shown while
 * `PRIVATE_POSTING_DEFAULTS` is on: Audiences then lives in Interaction
 * settings, under Private posts (Phase 3, batch B).
 */
export function AudiencesSettingsItem() {
  const {t: l} = useLingui()
  const isMember = useIsMember()
  if (!PRIVATE_POSTING || PRIVATE_POSTING_DEFAULTS || !isMember) return null
  return (
    <SettingsList.LinkItem to="/settings/audiences" label={l`Audiences`}>
      <SettingsList.ItemIcon icon={PersonGroupIcon} />
      <SettingsList.ItemText>
        <Trans>Audiences</Trans>
      </SettingsList.ItemText>
    </SettingsList.LinkItem>
  )
}
