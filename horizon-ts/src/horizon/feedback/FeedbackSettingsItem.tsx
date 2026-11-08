import {Trans, useLingui} from '@lingui/react/macro'

import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {Bubbles_Stroke2_Corner2_Rounded as BubblesIcon} from '#/components/icons/Bubble'
import {useFeedbackAdminQuery} from '#/horizon/feedback/queries'

/** The Settings row, **Feedback**, for the accounts that may read reports. */
export function FeedbackSettingsItem() {
  const {t: l} = useLingui()
  const {data: isAdmin} = useFeedbackAdminQuery()
  if (!isAdmin) return null
  return (
    <SettingsList.LinkItem to="/settings/feedback" label={l`Feedback`}>
      <SettingsList.ItemIcon icon={BubblesIcon} />
      <SettingsList.ItemText>
        <Trans>Feedback</Trans>
      </SettingsList.ItemText>
    </SettingsList.LinkItem>
  )
}
