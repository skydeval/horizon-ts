/*
 * The web painter (Phase 3 design, 4.5): a compiled backdrop as a layered CSS
 * background. Pure and shared, with no DOM access; only web components call
 * it, and they put the result on a raw `div` (RN-web's style validation
 * drops a multi-value `backgroundPosition`).
 */

import {
  type Compiled,
  type Frame,
  paintedLayers,
  type ResolvedLayer,
  type ResolvedPattern,
  type ResolvedStop,
  rgbToHex,
} from '#/horizon/backdrops/compile'
import {GRAIN_TILE, grainTileUrl} from '#/horizon/backdrops/grain'

/** The CSS background properties the painter sets. */
export type WebBackgroundStyle = {
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
  /** `no-repeat`, or a list when a pattern or the grain tiles. */
  backgroundRepeat: string
  backgroundColor: string
}

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

/** A uniform overlay colour as a background image. */
function overlayImage(overlay: string) {
  return `linear-gradient(${overlay}, ${overlay})`
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

/**
 * The CSS of overlays (uniform CSS colours) alone, top first, each filling
 * the element.
 */
export function cssOverlays(overlays: string[]): {
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
 * The background for an element. `overlays` are uniform CSS colours, top
 * first (the glass tint); `offset` is where the frame's origin sits inside
 * the element.
 */
export function cssBackground(
  compiled: Compiled,
  overlays: string[],
  frame: Frame,
  offset: {x: number; y: number},
): WebBackgroundStyle {
  const images: string[] = []
  const sizes: string[] = []
  for (const overlay of overlays) {
    images.push(overlayImage(overlay))
    sizes.push('100% 100%')
  }
  const repeats: string[] = overlays.map(() => 'no-repeat')
  const frameSize = `${px(frame.width)} ${px(frame.height)}`
  const painted = paintedLayers(compiled)
  for (const layer of [...painted].reverse()) {
    const css = layerCss(layer, frameSize)
    images.push(css.image)
    sizes.push(css.size)
    repeats.push(css.repeat)
  }
  return {
    backgroundImage: images.join(', '),
    backgroundSize: sizes.join(', '),
    backgroundPosition: cssBackgroundPosition(
      overlays.length,
      painted.length,
      offset,
    ),
    // One value when nothing tiles, as before patterns and grain.
    backgroundRepeat: repeats.every(r => r === 'no-repeat')
      ? 'no-repeat'
      : repeats.join(', '),
    backgroundColor: rgbToHex(compiled.base),
  }
}

function rgba(layer: ResolvedPattern, alpha: number) {
  return `rgba(${layer.r}, ${layer.g}, ${layer.b}, ${formatNumber(alpha, 3)})`
}

/*
 * A pattern tile as CSS (change list 2, item 7). Each tile is anchored at
 * the frame's origin like the gradients, so a window's offset lines it up
 * with the fixed layer. The diagonal lines are one repeating gradient over
 * the frame; the others are a small tile repeated.
 */
function patternCss(
  layer: ResolvedPattern,
  frameSize: string,
): {image: string; size: string; repeat: string} {
  const on = rgba(layer, layer.a)
  const off = rgba(layer, 0)
  const tile = `${layer.size}px ${layer.size}px`
  switch (layer.shape) {
    case 'dots':
      return {
        image: `radial-gradient(circle at 50% 50%, ${on} 0px, ${on} 1.25px, ${off} 1.75px)`,
        size: tile,
        repeat: 'repeat',
      }
    case 'hlines':
      return {
        image: `linear-gradient(180deg, ${on} 0px, ${on} 1px, ${off} 1px)`,
        size: tile,
        repeat: 'repeat',
      }
    case 'vlines':
      return {
        image: `linear-gradient(90deg, ${on} 0px, ${on} 1px, ${off} 1px)`,
        size: tile,
        repeat: 'repeat',
      }
    case 'diagonal':
      return {
        image: `repeating-linear-gradient(45deg, ${on} 0px, ${on} 1px, ${off} 1px, ${off} ${layer.size}px)`,
        size: frameSize,
        repeat: 'no-repeat',
      }
  }
}

/** One compiled layer as a CSS background image, its size and repeat. */
function layerCss(
  layer: ResolvedLayer,
  frameSize: string,
): {image: string; size: string; repeat: string} {
  if (layer.kind === 'pattern') return patternCss(layer, frameSize)
  if (layer.kind === 'grain') {
    const tile = grainTileUrl()
    // `none` keeps the layer count (and so the positions) the same.
    return {
      image: tile ? `url("${tile}")` : 'none',
      size: `${GRAIN_TILE}px ${GRAIN_TILE}px`,
      repeat: 'repeat',
    }
  }
  const stops = layer.stops.map(stopCss).join(', ')
  return {
    image:
      layer.kind === 'linear'
        ? `linear-gradient(${formatNumber(layer.cssDeg, 2)}deg, ${stops})`
        : `radial-gradient(circle ${px(layer.r)} at ${px(layer.cx)} ${px(layer.cy)}, ${stops})`,
    size: frameSize,
    repeat: 'no-repeat',
  }
}
