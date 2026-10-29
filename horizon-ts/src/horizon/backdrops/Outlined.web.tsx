/*
 * On web the drawer's outline is CSS (`DrawerHalo` in `BarShade.web.tsx`),
 * so the app's copies (`Outlined.tsx`) are not needed.
 */

import {type StyleProp, type ViewStyle} from 'react-native'

/** The children only, on web. */
export function Outlined({
  children,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  return <>{children}</>
}
