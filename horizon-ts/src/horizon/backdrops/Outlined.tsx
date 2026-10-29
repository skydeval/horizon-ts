/*
 * A soft outline round text in the app (the drawer over its bare window,
 * skydeval 2026-10-29). Android draws one text shadow, blurred and sized in
 * raw pixels, which cannot part white text from a flag's white band. So the
 * outline is eight copies of the children, a point out every way, faint and
 * slightly blurred in the outline's colour (`OutlineCopyContext`, which
 * Typography's `Text` takes, nested text included), behind the children
 * themselves; where they overlap they build a shadow that fades out. The
 * copies are hidden from touch and screen readers. Outside an outline
 * scope (`BarHaloScope` with `outline`), the children only.
 */

import {type StyleProp, View, type ViewStyle} from 'react-native'

import {
  ICON_OUTLINE_OFFSETS,
  OutlineCopyContext,
  useBarHalo,
} from '#/horizon/backdrops/bar-halo-context'

export function Outlined({
  children,
  style,
}: {
  children: React.ReactNode
  /** The wrapper's layout, while outlined (a row's `flex_shrink`). */
  style?: StyleProp<ViewStyle>
}) {
  const halo = useBarHalo()
  if (!halo?.outline) return <>{children}</>
  return (
    <View style={style}>
      {ICON_OUTLINE_OFFSETS.map(([left, top]) => (
        <View
          key={`${left},${top}`}
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            top,
            left,
            right: -left,
            bottom: -top,
          }}>
          <OutlineCopyContext.Provider value={halo.halo}>
            {children}
          </OutlineCopyContext.Provider>
        </View>
      ))}
      {children}
    </View>
  )
}
