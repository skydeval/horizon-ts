import {useLingui} from '@lingui/react/macro'

import {SettingsGear2_Stroke2_Corner0_Rounded as Gear} from '#/components/icons/SettingsGear2'
import * as Menu from '#/components/Menu'

/**
 * The post menu's entry to a private post's settings (Menu 6, 7.8), in place
 * of the stock "Edit interaction settings".
 */
export function PrivatePostSettingsMenuItem({onPress}: {onPress: () => void}) {
  const {t: l} = useLingui()
  return (
    <Menu.Item
      testID="postDropdownEditPrivatePostSettings"
      label={l`Edit who can see and interact`}
      onPress={onPress}>
      <Menu.ItemText>{l`Edit who can see and interact`}</Menu.ItemText>
      <Menu.ItemIcon icon={Gear} position="right" />
    </Menu.Item>
  )
}
