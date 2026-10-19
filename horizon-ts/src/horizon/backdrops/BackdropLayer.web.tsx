/*
 * The backdrop layer (Phase 3 design, 7.6, BD-1): the shell root's first
 * child, a fixed full-viewport raw `div` painted with the compiled backdrop.
 * In dim and dark the colours are the softened ones (`softness.ts`, live
 * fix batch 1), which replaced the dark theme's black veil. A raw `div`
 * because RN-web drops the layered `backgroundPosition` (4.5); it leaves
 * `z-index` at `auto` so it paints in tree order beneath the views after it.
 *
 * Performance fix 7c: the layer is promoted explicitly (`will-change`) and
 * contained (`contain: strict`), so it is rasterised once per size and only
 * composited, whatever a browser's heuristics. Below 800px it is not drawn
 * at all unless the phone frame shows it (Gutter's margins,
 * `fixedLayerDrawn`): everywhere else the opaque reading surface covers it
 * and the windows paint their own.
 */

import {useBreakpoints, useTheme} from '#/alf'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {compileBackdrop} from '#/horizon/backdrops/compile'
import {cssLayers} from '#/horizon/backdrops/css'
import {fixedLayerDrawn} from '#/horizon/backdrops/frame'
import {useViewportFrame} from '#/horizon/backdrops/viewport'

function Layer() {
  const t = useTheme()
  const def = useActiveBackdrop()
  const frame = useViewportFrame()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  const compiled = def ? compileBackdrop(def, t.name, frame) : null
  if (!compiled) return null
  if (!fixedLayerDrawn({frameStyle: device.frameStyle, gtMobile})) return null
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        willChange: 'transform',
        contain: 'strict',
        ...cssLayers(compiled, frame),
      }}
    />
  )
}

/** Renders nothing unless `active` (the shell's `useShellBackdrop`). */
export function BackdropLayer({active}: {active: boolean}) {
  return active ? <Layer /> : null
}
