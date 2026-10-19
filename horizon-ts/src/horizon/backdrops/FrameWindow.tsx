/*
 * A compact frame window (Phase 3 design, 9.1 to 9.4, BD-12, BD-15 to BD-17
 * and BD-23; live fix batch 1): placed first inside a frame piece (the Home
 * header, a sticky header, the bottom bar, the drawer), it paints the
 * shared backdrop there, so the piece reads as a window onto the fixed
 * layer while posts stay on opaque ground. The phone frame style decides
 * which pieces are windows and how (`windowMode`): the whole piece under
 * the theme's glass, the whole piece bare with a shade under each item
 * (Bars, batch A; the window hands the shades their colours), or the Edges
 * frame's slim band. Renders nothing unless
 * a backdrop is active, `COMPACT_FRAME_WINDOWS` is on, the style draws the
 * piece and it is not inside a dialog.
 */

import {StyleSheet} from 'react-native'

import {useHideBottomBarBorder} from '#/lib/hooks/useHideBottomBarBorder'
import {useBreakpoints, useTheme} from '#/alf'
import {useDialogContext} from '#/components/Dialog/context'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {BackdropWindow} from '#/horizon/backdrops/BackdropWindow'
import {
  bottomBarEdgeShape,
  bottomBarShape,
  FILL_SHAPE,
  HEADER_EDGE_SHAPE,
  type WindowKind,
  type WindowMode,
  windowMode,
  windowOverlays,
  type WindowShape,
} from '#/horizon/backdrops/frame'
import {type BackdropDef} from '#/horizon/backdrops/types'

function ActiveWindow({
  kind,
  mode,
  def,
}: {
  kind: WindowKind
  mode: WindowMode
  def: BackdropDef
}) {
  const t = useTheme()
  const hideBorder = useHideBottomBarBorder()
  let shape: WindowShape = FILL_SHAPE
  if (kind === 'bottomBar') {
    shape =
      mode === 'edge'
        ? bottomBarEdgeShape(StyleSheet.hairlineWidth)
        : bottomBarShape({
            hairline: StyleSheet.hairlineWidth,
            hideBorder,
            borderColor: t.atoms.border_contrast_low.borderColor,
          })
  } else if (mode === 'edge') {
    shape = HEADER_EDGE_SHAPE
  }
  return (
    <BackdropWindow
      def={def}
      overlays={windowOverlays(def, t.name, mode)}
      shape={shape}
      homeHeader={kind === 'homeHeader'}
      followsAnimations={kind === 'drawer'}
      shades={mode === 'bare'}
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
  const mode = windowMode({
    def,
    frameStyle: device.frameStyle,
    kind,
    gtMobile,
    isWithinDialog,
    enabled,
  })
  if (!def || !mode) return null
  return <ActiveWindow kind={kind} mode={mode} def={def} />
}
