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

/**
 * The background for an element. `overlays` are uniform colours, top first
 * (the glass tint, the veil); `offset` is where the frame's origin sits
 * inside the element.
 */
export function cssBackground(
  compiled: Compiled,
  overlays: string[],
  frame: Frame,
  offset: {x: number; y: number},
): WebBackgroundStyle {
  const images: string[] = []
  const sizes: string[] = []
  for (const color of overlays) {
    images.push(`linear-gradient(${color}, ${color})`)
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
