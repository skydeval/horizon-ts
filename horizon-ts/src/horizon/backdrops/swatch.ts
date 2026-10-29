/*
 * Swatch previews (Phase 3 design, 10.2 and 11.2). In dim and dark, a pale
 * swatch (not a flag, every stripe light) is stretched away from white so the
 * pale materials stay distinguishable on a dark page, and a near-black one is
 * lifted towards white so it shows on a black one (skydeval, 2026-10-29). A
 * flag's swatch draws its stripes as sharp bands, which a tile this small
 * otherwise blurs into one blend (skydeval, 2026-10-29). Only the preview
 * changes, never the backdrop itself.
 */

import {hexToRgb, rgbToHex} from '#/horizon/backdrops/compile'
import {luminance} from '#/horizon/backdrops/glass'
import {makeStripedStops} from '#/horizon/backdrops/stripes'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

/** The relative luminance at or above which a stripe counts as pale. */
export const PALE_LUMINANCE = 0.45

/** The swatch tile's size, in pixels. */
export const SWATCH_SIZE = 36

/** True when the def's swatch is stretched in this theme. */
export function isPaleSwatch(def: BackdropDef, theme: ThemeName): boolean {
  if (theme === 'light') return false
  if (def.collection === 'pride' || def.stripes.length === 0) return false
  // A def with its own layers (skies, blobs) is drawn as it is.
  if (def.layers) return false
  return def.stripes.every(
    color => luminance(hexToRgb(color)) >= PALE_LUMINANCE,
  )
}

function stretch(channel: number) {
  return Math.max(0, 255 - (255 - channel) * 2)
}

/** The relative luminance below which a stripe counts as near black. */
export const DARK_LUMINANCE = 0.03

/** How far towards white a near-black swatch is lifted, 0 to 1. */
const DARK_LIFT = 0.18

/** Every colour a def draws: its layers' stops, or its stripes. */
function defColors(def: BackdropDef): string[] {
  return def.layers
    ? def.layers.flatMap(layer => layer.stops.map(stop => stop.color))
    : def.stripes
}

/**
 * True when the def's swatch is lifted in this theme: a Calm shade whose
 * every colour is near black (Slate, Charcoal). The starfield is near black
 * too, but its stars already show.
 */
export function isDarkSwatch(def: BackdropDef, theme: ThemeName): boolean {
  if (theme === 'light' || def.collection !== 'calm') return false
  const colors = defColors(def)
  if (colors.length === 0) return false
  return colors.every(color => luminance(hexToRgb(color)) < DARK_LUMINANCE)
}

function lift(channel: number) {
  return Math.round(channel + (255 - channel) * DARK_LIFT)
}

/**
 * How much of each band blends into the next: half of it, so a flag's
 * colours flow into each other with no hard line yet each still shows
 * solid (skydeval: "add gradient to the colors", 2026-10-29).
 */
const SWATCH_BLEND = 0.5

/**
 * A flag's stripes as crisp diagonal bands, corner to corner, blending
 * into each other.
 */
function sharpFlag(def: BackdropDef): BackdropDef {
  return {
    ...def,
    layers: [
      {
        kind: 'linear',
        direction: {kind: 'corner'},
        stops: makeStripedStops(def.stripes, {
          edgeEpsilon: SWATCH_BLEND / 2 / def.stripes.length,
          softenEdges: false,
        }),
        opacity: 1,
      },
    ],
  }
}

/** The def with `channel` applied to every colour it draws. */
function mapStripes(
  def: BackdropDef,
  channel: (c: number) => number,
): BackdropDef {
  const map = (color: string) => {
    const {r, g, b} = hexToRgb(color)
    return rgbToHex({r: channel(r), g: channel(g), b: channel(b)})
  }
  return {
    ...def,
    stripes: def.stripes.map(map),
    ...(def.layers
      ? {
          layers: def.layers.map(layer => ({
            ...layer,
            stops: layer.stops.map(stop => ({...stop, color: map(stop.color)})),
          })),
        }
      : {}),
  }
}

/**
 * The def a swatch, chip dot or preset dot compiles: a flag as sharp bands,
 * a pale def stretched and a near-black one lifted in dim and dark, and
 * anything else as it is.
 */
export function swatchDef(def: BackdropDef, theme: ThemeName): BackdropDef {
  if (def.collection === 'pride' && !def.layers && def.stripes.length >= 2) {
    return sharpFlag(def)
  }
  if (isPaleSwatch(def, theme)) return mapStripes(def, stretch)
  if (isDarkSwatch(def, theme)) return mapStripes(def, lift)
  return def
}
