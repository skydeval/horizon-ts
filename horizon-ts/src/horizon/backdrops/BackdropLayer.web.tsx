/*
 * The backdrop layer (Phase 3 design, 7.6, BD-1): the shell root's first
 * child, a fixed full-viewport raw `div` painted with the compiled backdrop
 * and, in dark, the veil. A raw `div` because RN-web drops the layered
 * `backgroundPosition` (4.5); it leaves `z-index` at `auto` so it paints in
 * tree order beneath the views after it.
 */

import {useTheme} from '#/alf'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {compileBackdrop} from '#/horizon/backdrops/compile'
import {cssBackground} from '#/horizon/backdrops/css'
import {veilOverlays} from '#/horizon/backdrops/glass'
import {useViewportFrame} from '#/horizon/backdrops/viewport'

function Layer() {
  const t = useTheme()
  const def = useActiveBackdrop()
  const frame = useViewportFrame()
  const compiled = def ? compileBackdrop(def, t.name, frame) : null
  if (!compiled) return null
  const background = cssBackground(compiled, veilOverlays(t.name), frame, {
    x: 0,
    y: 0,
  })
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        ...background,
      }}
    />
  )
}

/** Renders nothing unless `active` (the shell's `useShellBackdrop`). */
export function BackdropLayer({active}: {active: boolean}) {
  return active ? <Layer /> : null
}
