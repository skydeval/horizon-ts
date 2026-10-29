/*
 * On web the drawer keeps its glass, so the app's outline copies
 * (`Outlined.tsx`) are not drawn.
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
