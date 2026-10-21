/*
 * A backdrop's layers, two ways (Phase 3 design, 4.1 and 4.2): 1.0's spec as
 * written, and what 1.0 actually drew, stated as data. A def that lists its
 * own layers (skies, colour blobs) draws those in both looks; a pattern and
 * the grain are its texture, on top in both (change list 2).
 */

import {bloomLayer, makeStripedStops} from '#/horizon/backdrops/stripes'
import {
  type BackdropDef,
  type GrainLayer,
  type Layer,
  type PatternLayer,
  type PatternName,
} from '#/horizon/backdrops/types'

function stripedStops(def: BackdropDef) {
  return makeStripedStops(def.stripes, {
    edgeEpsilon: def.stripe.edgeEpsilon,
    softenEdges: def.stripe.softenEdges,
  })
}

/** The tile of each pattern, in pixels: small enough to read as texture. */
export const PATTERN_TILES: Record<PatternName, PatternLayer[]> = {
  dots: [{kind: 'pattern', shape: 'dots', size: 18}],
  grid: [
    {kind: 'pattern', shape: 'hlines', size: 24},
    {kind: 'pattern', shape: 'vlines', size: 24},
  ],
  lines: [{kind: 'pattern', shape: 'diagonal', size: 14}],
}

/**
 * The texture over a def's layers, bottom first: its pattern's tiles, then
 * the grain. The same in both looks.
 */
export function textureLayers(def: BackdropDef): (PatternLayer | GrainLayer)[] {
  const out: (PatternLayer | GrainLayer)[] = def.pattern
    ? [...PATTERN_TILES[def.pattern]]
    : []
  if (def.grain) out.push({kind: 'grain'})
  return out
}

/**
 * 1.0's spec: the striped layer at its angle with its hard-edged stops, then
 * the bloom.
 */
export function specLayers(def: BackdropDef): Layer[] {
  if (def.layers) return def.layers
  if (def.stripes.length === 0) return []
  return [
    {
      kind: 'linear',
      direction: {kind: 'angle', deg: def.stripe.angleDeg},
      stops: stripedStops(def),
      opacity: 1,
    },
    bloomLayer(def.bloomOpacity),
  ]
}

/**
 * What 1.0 drew: the striped stops' colours only, evenly spaced, corner to
 * corner, with no bloom (its CSS never painted).
 */
export function seenLayers(def: BackdropDef): Layer[] {
  if (def.layers) return def.layers
  if (def.stripes.length === 0) return []
  const colors = stripedStops(def).map(stop => stop.color)
  const k = colors.length
  return [
    {
      kind: 'linear',
      direction: {kind: 'corner'},
      stops: colors.map((color, i) => ({color, pos: i / (k - 1), alpha: 1})),
      opacity: 1,
    },
  ]
}
