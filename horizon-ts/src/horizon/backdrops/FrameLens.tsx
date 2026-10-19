/*
 * A button lens, skydeval's button-windows prototype (Phase 3 design, 9.7,
 * BD-19 to BD-21): with the "Buttons" phone frame the bars stay opaque and
 * the frame's buttons (the bottom tabs, the header back, menu and feeds
 * buttons, the compose button) become small windows onto the same backdrop.
 * Placed first inside the button as its bottom layer (below the icon,
 * `BackdropWindow.web.tsx`), clipped to its shape; it shows the backdrop
 * untinted, with only a small backing disc behind the icon where the icon
 * needs it for 3:1 (live fix batch 1, `lensOverlays`). Renders nothing
 * unless a backdrop is active, `COMPACT_FRAME_WINDOWS` is on, the phone
 * frame is "Buttons" and the button is not inside a dialog (`lensActive`).
 */

import {atoms as a, useBreakpoints, useTheme} from '#/alf'
import {useDialogContext} from '#/components/Dialog/context'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {BackdropWindow} from '#/horizon/backdrops/BackdropWindow'
import {
  FILL_SHAPE,
  lensActive,
  type LensKind,
  lensOverlays,
  ROUND_RADIUS,
  TAB_LENS_SHAPE,
  type WindowShape,
} from '#/horizon/backdrops/frame'

function lensShape(kind: LensKind, shape: 'round' | 'square'): WindowShape {
  if (kind === 'tab') return TAB_LENS_SHAPE
  if (kind === 'headerButton' && shape === 'square') {
    return {...FILL_SHAPE, borderRadius: a.rounded_sm.borderRadius}
  }
  return {...FILL_SHAPE, borderRadius: ROUND_RADIUS}
}

/**
 * The lens of a frame button. `shape` is the button's own (`round` or
 * `square`, header buttons only); the tab lens is a pill and the compose
 * button's a circle.
 */
export function FrameLens({
  kind,
  shape = 'round',
}: {
  kind: LensKind
  shape?: 'round' | 'square'
}) {
  const t = useTheme()
  const def = useActiveBackdrop()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  const {isWithinDialog} = useDialogContext()
  if (
    !def ||
    !lensActive({
      def,
      frameStyle: device.frameStyle,
      kind,
      gtMobile,
      isWithinDialog,
    })
  ) {
    return null
  }
  return (
    <BackdropWindow
      def={def}
      overlays={lensOverlays(def, t.name, kind)}
      shape={lensShape(kind, shape)}
    />
  )
}
