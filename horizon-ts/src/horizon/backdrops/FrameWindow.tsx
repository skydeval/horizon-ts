/*
 * A compact frame window (Phase 3 design, 9.1 to 9.4, BD-12, BD-15 to BD-17
 * and BD-23): placed first inside a frame piece (the Home header, a sticky
 * header, the bottom bar, the drawer), it paints the shared backdrop there
 * under the theme's glass, so the piece reads as a window onto the fixed
 * layer while posts stay on opaque ground. Renders nothing unless a
 * backdrop is active, `COMPACT_FRAME_WINDOWS` is on, the phone frame is
 * "Bars" and the piece is not inside a dialog (`windowActive`).
 */

import {StyleSheet} from 'react-native'

import {useHideBottomBarBorder} from '#/lib/hooks/useHideBottomBarBorder'
import {useBreakpoints, useTheme} from '#/alf'
import {useDialogContext} from '#/components/Dialog/context'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {BackdropWindow} from '#/horizon/backdrops/BackdropWindow'
import {
  bottomBarShape,
  FILL_SHAPE,
  windowActive,
  type WindowKind,
  windowOverlays,
} from '#/horizon/backdrops/frame'
import {type BackdropDef} from '#/horizon/backdrops/types'

function ActiveWindow({kind, def}: {kind: WindowKind; def: BackdropDef}) {
  const t = useTheme()
  const hideBorder = useHideBottomBarBorder()
  const shape =
    kind === 'bottomBar'
      ? bottomBarShape({
          hairline: StyleSheet.hairlineWidth,
          hideBorder,
          borderColor: t.atoms.border_contrast_low.borderColor,
        })
      : FILL_SHAPE
  return (
    <BackdropWindow
      def={def}
      overlays={windowOverlays(def, t.name)}
      shape={shape}
      homeHeader={kind === 'homeHeader'}
    />
  )
}

/**
 * The window of a frame piece. `enabled` false renders nothing (the Home
 * header's inner row, whose wrapper is already a window).
 */
export function FrameWindow({
  kind,
  enabled = true,
}: {
  kind: WindowKind
  enabled?: boolean
}) {
  const def = useActiveBackdrop()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  const {isWithinDialog} = useDialogContext()
  if (
    !def ||
    !windowActive({
      def,
      frameStyle: device.frameStyle,
      kind,
      gtMobile,
      isWithinDialog,
      enabled,
    })
  ) {
    return null
  }
  return <ActiveWindow kind={kind} def={def} />
}
