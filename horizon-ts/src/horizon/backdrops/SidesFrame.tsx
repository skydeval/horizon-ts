/*
 * The Sides phone frame in the app (skydeval, 2026-10-29: "like edges but on
 * the sides", as web's inset card). Web shows the backdrop in 8px gutters
 * beside a rounded reading card, through the card's surface. The app has no
 * layer behind its screens, so this paints the gutters over the screen: a
 * strip down each side, and the card's two rounded top corners. Rendered
 * last in `Layout.Screen`, so the bottom bar still covers the bottom, as on
 * web. Each piece paints from its known place on the screen, not a
 * measurement.
 */

import {useWindowDimensions, View} from 'react-native'

import {atoms as a, useBreakpoints, useTheme} from '#/alf'
import {useDialogContext} from '#/components/Dialog/context'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {BackdropWindow} from '#/horizon/backdrops/BackdropWindow'
import {FILL_SHAPE} from '#/horizon/backdrops/frame'
import {
  INSET_GUTTER,
  INSET_RADIUS,
  sidesStripsOn,
} from '#/horizon/backdrops/inset'
import {type BackdropDef} from '#/horizon/backdrops/types'

/** A top corner of the card: the backdrop outside its curve. */
function Corner({
  def,
  left,
  side,
}: {
  def: BackdropDef
  left: number
  side: 'left' | 'right'
}) {
  const t = useTheme()
  return (
    <View
      style={[
        a.absolute,
        a.overflow_hidden,
        {left, top: 0, width: INSET_RADIUS, height: INSET_RADIUS},
      ]}>
      <BackdropWindow
        def={def}
        overlays={[]}
        shape={FILL_SHAPE}
        at={{left, top: 0}}
      />
      <View
        style={[
          a.absolute,
          a.inset_0,
          t.atoms.bg,
          side === 'left'
            ? {borderTopLeftRadius: INSET_RADIUS}
            : {borderTopRightRadius: INSET_RADIUS},
        ]}
      />
    </View>
  )
}

/** The Sides strips and corners, or nothing when the style is off. */
export function SidesFrame() {
  const def = useActiveBackdrop()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  const {isWithinDialog} = useDialogContext()
  const {width} = useWindowDimensions()
  if (
    !def ||
    isWithinDialog ||
    !sidesStripsOn({def, frameStyle: device.frameStyle, gtMobile})
  ) {
    return null
  }
  const right = width - INSET_GUTTER
  return (
    <View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[a.absolute, a.inset_0]}>
      <BackdropWindow
        def={def}
        overlays={[]}
        shape={{left: 0, top: 0, bottom: 0, width: INSET_GUTTER}}
        at={{left: 0, top: 0}}
      />
      <BackdropWindow
        def={def}
        overlays={[]}
        shape={{left: right, top: 0, bottom: 0, width: INSET_GUTTER}}
        at={{left: right, top: 0}}
      />
      <Corner def={def} left={INSET_GUTTER} side="left" />
      <Corner def={def} left={right - INSET_RADIUS} side="right" />
    </View>
  )
}
