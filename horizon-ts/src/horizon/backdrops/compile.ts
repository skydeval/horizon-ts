/*
 * The backdrop compiler (Phase 3 design, 4.4): a def, a theme and a frame in,
 * resolved layers out, honouring every field of the layers it is given. Pure
 * and shared by every platform; the web painter (`css.ts`) and the native one
 * (`CompiledSvg.tsx`) draw its output.
 */

import {seenLayers, specLayers} from '#/horizon/backdrops/layers'
import {BACKDROP_LOOK, type BackdropLook} from '#/horizon/backdrops/look'
import {
  type BackdropDef,
  type Hex,
  type Stop,
  type ThemeName,
  type Tuning,
} from '#/horizon/backdrops/types'

export type Frame = {width: number; height: number}

export type RGB = {r: number; g: number; b: number}

export type ResolvedStop = RGB & {a: number; pos: number}

export type ResolvedLinear = {
  kind: 'linear'
  /** CSS angle in degrees, for web. */
  cssDeg: number
  /** Gradient line endpoints in frame pixels, for SVG. */
  x1: number
  y1: number
  x2: number
  y2: number
  stops: ResolvedStop[]
}

export type ResolvedRadial = {
  kind: 'radial'
  /** Frame pixels. */
  cx: number
  cy: number
  r: number
  stops: ResolvedStop[]
}

export type Compiled = {
  /** Bottom first, as drawn. */
  layers: (ResolvedLinear | ResolvedRadial)[]
  /** The last stop colour of the first linear layer; painted under the image. */
  base: RGB
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

/** `#RRGGBB` (either case) to channels. */
export function hexToRgb(hex: Hex): RGB {
  const n = parseInt(hex.slice(1, 7), 16)
  return {r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255}
}

function channelHex(value: number) {
  return Math.round(value).toString(16).padStart(2, '0').toUpperCase()
}

/** Channels to `#RRGGBB`, uppercase. */
export function rgbToHex({r, g, b}: RGB): Hex {
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`
}

/** Channels 0-255 to hue 0-360, saturation and lightness 0-1. */
export function rgbToHsl({r, g, b}: RGB): {h: number; s: number; l: number} {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return {h: 0, s: 0, l}
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return {h: h * 60, s, l}
}

/** The inverse of {@link rgbToHsl}, channels rounded to integers. */
export function hslToRgb({h, s, l}: {h: number; s: number; l: number}): RGB {
  if (s === 0) {
    const v = Math.round(l * 255)
    return {r: v, g: v, b: v}
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = h / 360
  const channel = (offset: number) => {
    let x = hue + offset
    if (x < 0) x += 1
    if (x > 1) x -= 1
    let v: number
    if (x < 1 / 6) v = p + (q - p) * 6 * x
    else if (x < 1 / 2) v = q
    else if (x < 2 / 3) v = p + (q - p) * (2 / 3 - x) * 6
    else v = p
    return Math.round(v * 255)
  }
  return {r: channel(1 / 3), g: channel(0), b: channel(-1 / 3)}
}

function tuneColor(rgb: RGB, tuning: Tuning | undefined): RGB {
  if (!tuning) return rgb
  const saturation = tuning.saturation ?? 1
  const brightness = tuning.brightness ?? 1
  if (saturation === 1 && brightness === 1) return rgb
  const hsl = rgbToHsl(rgb)
  return hslToRgb({
    h: hsl.h,
    s: clamp01(hsl.s * saturation),
    l: clamp01(hsl.l * brightness),
  })
}

function resolveStops(
  stops: Stop[],
  opacity: number,
  tuning: Tuning | undefined,
  tuneColors: boolean,
): ResolvedStop[] {
  let resolved = stops.map(stop => {
    const rgb = hexToRgb(stop.color)
    const color = tuneColors ? tuneColor(rgb, tuning) : rgb
    return {
      ...color,
      a: clamp01((stop.alpha ?? 1) * opacity * (tuning?.opacity ?? 1)),
      pos: clamp01(stop.pos),
    }
  })
  const ordered = resolved.every(
    (stop, i) => i === 0 || stop.pos >= resolved[i - 1].pos,
  )
  if (!ordered) {
    if (__DEV__) {
      throw new Error('Backdrop stop positions must be non-decreasing')
    }
    resolved = resolved
      .map((stop, i) => ({stop, i}))
      .sort((x, y) => x.stop.pos - y.stop.pos || x.i - y.i)
      .map(({stop}) => stop)
  }
  return resolved
}

/**
 * Compile a def for a theme and a frame. Null for a def with no layers
 * (`none`).
 */
export function compileBackdrop(
  def: BackdropDef,
  theme: ThemeName,
  frame: Frame,
  look: BackdropLook = BACKDROP_LOOK,
): Compiled | null {
  const layers = look === 'seen' ? seenLayers(def) : specLayers(def)
  if (layers.length === 0) return null
  const tuning = look === 'spec' ? def.tuning?.[theme] : undefined
  const tuneColors = look === 'spec' && !def.lockColors
  const W = frame.width
  const H = frame.height

  const resolved = layers.map((layer): ResolvedLinear | ResolvedRadial => {
    const stops = resolveStops(layer.stops, layer.opacity, tuning, tuneColors)
    if (layer.kind === 'radial') {
      return {
        kind: 'radial',
        cx: layer.cx * W,
        cy: layer.cy * H,
        r: layer.r * Math.max(W, H),
        stops,
      }
    }
    if (layer.direction.kind === 'corner') {
      return {
        kind: 'linear',
        cssDeg: 90 + (Math.atan2(H, W) * 180) / Math.PI,
        x1: 0,
        y1: 0,
        x2: W,
        y2: H,
        stops,
      }
    }
    const deg = layer.direction.deg
    const rad = (deg * Math.PI) / 180
    const sin = Math.sin(rad)
    const cos = Math.cos(rad)
    const L = Math.abs(W * sin) + Math.abs(H * cos)
    const dx = (sin * L) / 2
    const dy = (-cos * L) / 2
    return {
      kind: 'linear',
      cssDeg: deg,
      x1: W / 2 - dx,
      y1: H / 2 - dy,
      x2: W / 2 + dx,
      y2: H / 2 + dy,
      stops,
    }
  })

  const first = resolved.find(layer => layer.kind === 'linear') ?? resolved[0]
  const last = first.stops[first.stops.length - 1]
  return {layers: resolved, base: {r: last.r, g: last.g, b: last.b}}
}
