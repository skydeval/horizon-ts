/*
 * The native painter (Phase 3 design, 4.6): a compiled backdrop as
 * `react-native-svg` rects, one per layer, with user-space gradients, then
 * one rect per uniform overlay. Imported only by native components.
 */

import {useId} from 'react'
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg'

import {
  type Compiled,
  type Frame,
  type ResolvedStop,
  rgbToHex,
} from '#/horizon/backdrops/compile'

function stops(list: ResolvedStop[]) {
  return list.map((stop, i) => (
    <Stop
      key={i}
      offset={stop.pos}
      stopColor={rgbToHex(stop)}
      stopOpacity={stop.a}
    />
  ))
}

/**
 * Draws `compiled` at `frame` size, its origin at `offset` inside the parent
 * (which clips it). `overlays` are uniform colours, top first.
 */
export function CompiledSvg({
  compiled,
  overlays = [],
  frame,
  offset = {x: 0, y: 0},
}: {
  compiled: Compiled
  overlays?: string[]
  frame: Frame
  offset?: {x: number; y: number}
}) {
  const base = useId().replace(/:/g, '')
  const W = frame.width
  const H = frame.height
  return (
    <Svg
      width={W}
      height={H}
      style={{position: 'absolute', left: offset.x, top: offset.y}}
      pointerEvents="none">
      <Defs>
        {compiled.layers.map((layer, i) =>
          layer.kind === 'linear' ? (
            <LinearGradient
              key={i}
              id={`${base}-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={layer.x1}
              y1={layer.y1}
              x2={layer.x2}
              y2={layer.y2}>
              {stops(layer.stops)}
            </LinearGradient>
          ) : (
            <RadialGradient
              key={i}
              id={`${base}-${i}`}
              gradientUnits="userSpaceOnUse"
              cx={layer.cx}
              cy={layer.cy}
              r={layer.r}>
              {stops(layer.stops)}
            </RadialGradient>
          ),
        )}
      </Defs>
      {compiled.layers.map((_layer, i) => (
        <Rect key={i} width={W} height={H} fill={`url(#${base}-${i})`} />
      ))}
      {[...overlays].reverse().map((color, i) => (
        <Rect key={`o${i}`} width={W} height={H} fill={color} />
      ))}
    </Svg>
  )
}
