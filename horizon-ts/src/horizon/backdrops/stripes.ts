/*
 * 1.0's two layer builders (`makeStripedBackdrop.ts`), ported verbatim and
 * typed (Phase 3 design, 4.1).
 */

import {type Hex, type RadialLayer, type Stop} from '#/horizon/backdrops/types'

/**
 * The stops of 1.0's striped linear layer: n stripes give 2n + 1 stops, with
 * a pair of stops `edgeEpsilon` either side of each boundary. With
 * `softenEdges` and at least three stripes, the first and last stripes weigh
 * 1.05 instead of 1. Throws for fewer than two stripes, as 1.0 did.
 */
export function makeStripedStops(
  stripes: Hex[],
  {edgeEpsilon, softenEdges}: {edgeEpsilon: number; softenEdges: boolean},
): Stop[] {
  const n = stripes.length
  if (n < 2) {
    throw new Error('makeStripedStops requires at least 2 stripe colors')
  }
  const weights = new Array<number>(n).fill(1)
  if (softenEdges && n >= 3) {
    weights[0] = 1.05
    weights[n - 1] = 1.05
  }
  const total = weights.reduce((sum, w) => sum + w, 0)
  const cum: number[] = [0]
  for (let i = 0; i < n; i++) cum.push(cum[i] + weights[i] / total)

  const stops: Stop[] = []
  for (let i = 0; i < n; i++) {
    const color = stripes[i]
    const start = cum[i]
    const end = cum[i + 1]
    if (i === 0) stops.push({color, pos: start})
    stops.push({color, pos: Math.max(start, end - edgeEpsilon)})
    if (i < n - 1) {
      stops.push({color: stripes[i + 1], pos: Math.min(1, end + edgeEpsilon)})
    } else {
      stops.push({color, pos: end})
    }
  }
  return stops
}

/**
 * 1.0's neutral bloom: a white-to-black circle near the top left.
 */
export function bloomLayer(opacity: number): RadialLayer {
  return {
    kind: 'radial',
    cx: 0.28,
    cy: 0.18,
    r: 0.95,
    opacity,
    stops: [
      {color: '#FFFFFF', pos: 0},
      {color: '#FFFFFF', pos: 0.35},
      {color: '#000000', pos: 1},
    ],
  }
}
