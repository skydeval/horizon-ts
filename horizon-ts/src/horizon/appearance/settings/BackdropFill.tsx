/*
 * A backdrop drawn into a small box, on native: the SVG painter in an
 * absolutely placed view (Phase 3 design, 4.6). Built, not verified in
 * Phase 3. `BackdropFill.web.tsx` is the web painter.
 */

import {View} from 'react-native'

import {atoms as a} from '#/alf'
import {compileBackdrop} from '#/horizon/backdrops/compile'
import {CompiledSvg} from '#/horizon/backdrops/CompiledSvg'
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
    <View pointerEvents="none" style={[a.absolute, a.inset_0]}>
      <CompiledSvg compiled={compiled} frame={frame} />
    </View>
  )
}
