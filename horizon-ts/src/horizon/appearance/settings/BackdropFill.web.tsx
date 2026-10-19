/*
 * A backdrop drawn into a small box (a swatch, the Custom chip's dot, a
 * preset's dot), on web: a raw `div` filling its parent (Phase 3 design,
 * 10.2). The parent clips it with its own radius. `BackdropFill.tsx` is the
 * native painter.
 */

import {compileBackdrop} from '#/horizon/backdrops/compile'
import {cssBackground} from '#/horizon/backdrops/css'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

/** Fills the parent with `def` compiled at `size` x `size`. */
export function BackdropFill({
  def,
  theme,
  size,
}: {
  def: BackdropDef
  theme: ThemeName
  size: number
}) {
  const frame = {width: size, height: size}
  const compiled = compileBackdrop(def, theme, frame)
  if (!compiled) return null
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        ...cssBackground(compiled, [], frame, {x: 0, y: 0}),
      }}
    />
  )
}
