/*
 * Swatch previews (Phase 3 design, 10.2 and 11.2). In dim and dark, a pale
 * swatch (not a flag, every stripe light) is stretched away from white so the
 * pale materials stay distinguishable on a dark page. Only the preview
 * changes, never the backdrop itself.
 */

import {hexToRgb, rgbToHex} from '#/horizon/backdrops/compile'
import {luminance} from '#/horizon/backdrops/glass'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

/** The relative luminance at or above which a stripe counts as pale. */
export const PALE_LUMINANCE = 0.45

/** The swatch tile's size, in pixels. */
export const SWATCH_SIZE = 36

/** True when the def's swatch is stretched in this theme. */
export function isPaleSwatch(def: BackdropDef, theme: ThemeName): boolean {
  if (theme === 'light') return false
  if (def.collection === 'pride' || def.stripes.length === 0) return false
  return def.stripes.every(
    color => luminance(hexToRgb(color)) >= PALE_LUMINANCE,
  )
}

function stretch(channel: number) {
  return Math.max(0, 255 - (255 - channel) * 2)
}

/**
 * The def a swatch, chip dot or preset dot compiles: the def itself, or its
 * pale stretch in dim and dark.
 */
export function swatchDef(def: BackdropDef, theme: ThemeName): BackdropDef {
  if (!isPaleSwatch(def, theme)) return def
  return {
    ...def,
    stripes: def.stripes.map(color => {
      const {r, g, b} = hexToRgb(color)
      return rgbToHex({r: stretch(r), g: stretch(g), b: stretch(b)})
    }),
  }
}
