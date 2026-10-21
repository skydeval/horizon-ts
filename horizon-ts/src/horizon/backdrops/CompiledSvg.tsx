/*
 * The native painter (Phase 3 design, 4.6): a compiled backdrop as
 * `react-native-svg` rects, one per layer, with user-space gradients or
 * pattern tiles (a quiet pattern, or the starfield's tile of circles,
 * change list 3), then one rect per uniform overlay. The grain is web only
 * and draws nothing here. Imported only by native components.
 */

import {useId} from 'react'
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Pattern,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg'

import {
  type Compiled,
  type Frame,
  paintedLayers,
  type ResolvedLayer,
  type ResolvedPattern,
  type ResolvedStop,
  rgbToHex,
} from '#/horizon/backdrops/compile'
import {STAR_TILE, STARS} from '#/horizon/backdrops/stars'

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

/** A pattern tile in user space, anchored at the frame's origin. */
function PatternTile({id, layer}: {id: string; layer: ResolvedPattern}) {
  const fill = rgbToHex(layer)
  const s = layer.size
  return (
    <Pattern
      id={id}
      patternUnits="userSpaceOnUse"
      width={s}
      height={s}
      patternTransform={layer.shape === 'diagonal' ? 'rotate(45)' : undefined}>
      {layer.shape === 'dots' ? (
        <Circle
          cx={s / 2}
          cy={s / 2}
          r={1.5}
          fill={fill}
          fillOpacity={layer.a}
        />
      ) : layer.shape === 'vlines' ? (
        <Rect width={1} height={s} fill={fill} fillOpacity={layer.a} />
      ) : (
        <Rect width={s} height={1} fill={fill} fillOpacity={layer.a} />
      )}
    </Pattern>
  )
}

/** The starfield's tile: the same stars the web tile draws. */
function StarTile({id}: {id: string}) {
  return (
    <Pattern
      id={id}
      patternUnits="userSpaceOnUse"
      width={STAR_TILE}
      height={STAR_TILE}>
      {STARS.map((star, i) => (
        <Circle
          key={i}
          cx={star.x}
          cy={star.y}
          r={star.r}
          fill="#FFFFFF"
          fillOpacity={star.a}
        />
      ))}
    </Pattern>
  )
}

function LayerDef({id, layer}: {id: string; layer: ResolvedLayer}) {
  switch (layer.kind) {
    case 'linear':
      return (
        <LinearGradient
          id={id}
          gradientUnits="userSpaceOnUse"
          x1={layer.x1}
          y1={layer.y1}
          x2={layer.x2}
          y2={layer.y2}>
          {stops(layer.stops)}
        </LinearGradient>
      )
    case 'radial':
      return (
        <RadialGradient
          id={id}
          gradientUnits="userSpaceOnUse"
          cx={layer.cx}
          cy={layer.cy}
          r={layer.r}>
          {stops(layer.stops)}
        </RadialGradient>
      )
    case 'pattern':
      return <PatternTile id={id} layer={layer} />
    case 'stars':
      return <StarTile id={id} />
    case 'grain':
      return null
  }
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
  const painted = paintedLayers(compiled)
  const W = frame.width
  const H = frame.height
  return (
    <Svg
      width={W}
      height={H}
      style={{position: 'absolute', left: offset.x, top: offset.y}}
      pointerEvents="none">
      <Defs>
        {painted.map((layer, i) => (
          <LayerDef key={i} id={`${base}-${i}`} layer={layer} />
        ))}
      </Defs>
      {painted.map((layer, i) =>
        layer.kind === 'grain' ? null : (
          <Rect key={i} width={W} height={H} fill={`url(#${base}-${i})`} />
        ),
      )}
      {[...overlays].reverse().map((color, i) => (
        <Rect key={`o${i}`} width={W} height={H} fill={color} />
      ))}
    </Svg>
  )
}
