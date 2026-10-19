import {Trans, useLingui} from '@lingui/react/macro'

import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {Bubbles_Stroke2_Corner2_Rounded as BubblesIcon} from '#/components/icons/Bubble'
import {INTERACTION_SETTINGS_ROW} from '#/horizon/switches'

/**
 * The main Settings row, **Interaction settings** (Phase 3, batch B), for
 * everyone: the screen the Moderation screen's row opens too. Members find
 * their private posting defaults and Audiences there.
 */
export function InteractionSettingsItem() {
  const {t: l} = useLingui()
  if (!INTERACTION_SETTINGS_ROW) return null
  return (
    <SettingsList.LinkItem
      to="/moderation/interaction-settings"
      label={l`Interaction settings`}>
      <SettingsList.ItemIcon icon={BubblesIcon} />
      <SettingsList.ItemText>
        <Trans>Interaction settings</Trans>
      </SettingsList.ItemText>
    </SettingsList.LinkItem>
  )
}
