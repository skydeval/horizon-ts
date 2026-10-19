/*
 * A backdrop's layers, two ways (Phase 3 design, 4.1 and 4.2): 1.0's spec as
 * written, and what 1.0 actually drew, stated as data.
 */

import {bloomLayer, makeStripedStops} from '#/horizon/backdrops/stripes'
import {type BackdropDef, type Layer} from '#/horizon/backdrops/types'

function stripedStops(def: BackdropDef) {
  return makeStripedStops(def.stripes, {
    edgeEpsilon: def.stripe.edgeEpsilon,
    softenEdges: def.stripe.softenEdges,
  })
}

/**
 * 1.0's spec: the striped layer at its angle with its hard-edged stops, then
 * the bloom.
 */
export function specLayers(def: BackdropDef): Layer[] {
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
