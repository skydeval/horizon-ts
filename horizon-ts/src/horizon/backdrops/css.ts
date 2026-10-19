/*
 * The web painter (Phase 3 design, 4.5): a compiled backdrop as a layered CSS
 * background. Pure and shared, with no DOM access; only web components call
 * it, and they put the result on a raw `div` (RN-web's style validation
 * drops a multi-value `backgroundPosition`).
 */

import {
  type Compiled,
  type Frame,
  type ResolvedStop,
  rgbToHex,
} from '#/horizon/backdrops/compile'

/** The CSS background properties the painter sets. */
export type WebBackgroundStyle = {
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
  backgroundRepeat: 'no-repeat'
  backgroundColor: string
}

/**
 * A disc of colour centred in the element: full `color` out to `solid`
 * pixels from the centre, fading to `clear` (the same colour at alpha 0) by
 * `fade`, nothing beyond. A lens's icon backing (live fix batch 1).
 */
export type DiscOverlay = {
  kind: 'disc'
  color: string
  clear: string
  solid: number
  fade: number
}

/** An overlay over the backdrop: a uniform CSS colour, or a disc. */
export type Overlay = string | DiscOverlay

/** At most `digits` decimals, trailing zeros dropped. */
export function formatNumber(value: number, digits: number): string {
  const fixed = Number(value.toFixed(digits))
  return String(fixed === 0 ? 0 : fixed)
}

function px(value: number) {
  return `${formatNumber(value, 2)}px`
}

function stopCss(stop: ResolvedStop) {
  const pos = `${formatNumber(stop.pos * 100, 2)}%`
  if (stop.a === 1) return `${rgbToHex(stop)} ${pos}`
  return `rgba(${stop.r}, ${stop.g}, ${stop.b}, ${formatNumber(stop.a, 3)}) ${pos}`
}

/**
 * The `background-position` list of `cssBackground` alone: `0px 0px` for
 * each overlay, then `offset` for each backdrop layer. A window writes it
 * straight to its node as it moves (9.2).
 */
export function cssBackgroundPosition(
  overlayCount: number,
  layerCount: number,
  offset: {x: number; y: number},
): string {
  const framePosition = `${px(offset.x)} ${px(offset.y)}`
  return [
    ...Array<string>(overlayCount).fill('0px 0px'),
    ...Array<string>(layerCount).fill(framePosition),
  ].join(', ')
}

function overlayImage(overlay: Overlay) {
  if (typeof overlay === 'string') {
    return `linear-gradient(${overlay}, ${overlay})`
  }
  const {color, clear, solid, fade} = overlay
  return `radial-gradient(circle at 50% 50%, ${color} 0px, ${color} ${px(solid)}, ${clear} ${px(fade)})`
}

const layerCache = new WeakMap<Compiled, Map<string, WebBackgroundStyle>>()

/**
 * The backdrop alone, anchored at the element's origin: what the fixed
 * layer and a window's frame-sized inner element paint. Memoised per
 * compiled backdrop and frame (performance fix 7d), so the same object
 * comes back on every render.
 */
export function cssLayers(
  compiled: Compiled,
  frame: Frame,
): WebBackgroundStyle {
  let byFrame = layerCache.get(compiled)
  if (!byFrame) {
    byFrame = new Map()
    layerCache.set(compiled, byFrame)
  }
  const key = `${frame.width}x${frame.height}`
  let style = byFrame.get(key)
  if (!style) {
    style = cssBackground(compiled, [], frame, {x: 0, y: 0})
    byFrame.set(key, style)
  }
  return style
}

/** The CSS of overlays alone, top first, each filling the element. */
export function cssOverlays(overlays: Overlay[]): {
  backgroundImage: string
  backgroundSize: string
  backgroundRepeat: 'no-repeat'
} {
  return {
    backgroundImage: overlays.map(overlayImage).join(', '),
    backgroundSize: overlays.map(() => '100% 100%').join(', '),
    backgroundRepeat: 'no-repeat',
  }
}

/**
 * The background for an element. `overlays` are top first (the glass tint,
 * a lens's icon backing); `offset` is where the frame's origin sits inside
 * the element.
 */
export function cssBackground(
  compiled: Compiled,
  overlays: Overlay[],
  frame: Frame,
  offset: {x: number; y: number},
): WebBackgroundStyle {
  const images: string[] = []
  const sizes: string[] = []
  for (const overlay of overlays) {
    images.push(overlayImage(overlay))
    sizes.push('100% 100%')
  }
  const frameSize = `${px(frame.width)} ${px(frame.height)}`
  for (const layer of [...compiled.layers].reverse()) {
    const stops = layer.stops.map(stopCss).join(', ')
    images.push(
      layer.kind === 'linear'
        ? `linear-gradient(${formatNumber(layer.cssDeg, 2)}deg, ${stops})`
        : `radial-gradient(circle ${px(layer.r)} at ${px(layer.cx)} ${px(layer.cy)}, ${stops})`,
    )
    sizes.push(frameSize)
  }
  return {
    backgroundImage: images.join(', '),
    backgroundSize: sizes.join(', '),
    backgroundPosition: cssBackgroundPosition(
      overlays.length,
      compiled.layers.length,
      offset,
    ),
    backgroundRepeat: 'no-repeat',
    backgroundColor: rgbToHex(compiled.base),
  }
}
