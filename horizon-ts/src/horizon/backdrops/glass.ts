/*
 * The theme's glass over the backdrop (Phase 3 design, 7.3): one tint per
 * theme for every frame surface, at the smallest alpha that keeps the
 * theme's `text_contrast_medium` at 4.5:1 over the backdrop's worst colour.
 */

import {themes} from '#/alf/themes'
import {IS_WEB} from '#/env'
import {
  compileBackdrop,
  hexToRgb,
  layersKey,
  type RGB,
} from '#/horizon/backdrops/compile'
import {BACKDROP_LOOK, type BackdropLook} from '#/horizon/backdrops/look'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

/** The highest alpha the rule goes to. */
export const MAX_GLASS_ALPHA = 0.92

/** The alpha floor where the browser asks for reduced transparency. */
export const REDUCED_TRANSPARENCY_ALPHA = 0.85

/*
 * Nothing is blurred any more (performance fix 7a): the rail and nav cards
 * paint the backdrop into themselves under the glass instead. A live
 * `backdrop-filter` over a full-screen or scroll-overlapping area is what
 * made 1.0 lag; do not add one back.
 */

/*
 * Live fix batch 1: the dark theme's black veil (0.18) is gone. Dim and dark
 * now soften the backdrop's colours instead (`softness.ts`), which the
 * compiler applies, so every colour this module samples is already treated.
 */

export type GlassTheme = {
  tint: RGB
  baseAlpha: number
  /** The text colour the alpha is checked against. */
  text: RGB
}

function themeColor(value: unknown): RGB {
  if (typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)) {
    return hexToRgb(value)
  }
  throw new Error(`Unexpected theme colour ${String(value)}`)
}

/** The glass of each theme. */
export const GLASS: Record<ThemeName, GlassTheme> = {
  light: {
    tint: {r: 255, g: 255, b: 255},
    baseAlpha: 0.55,
    text: themeColor(themes.light.atoms.text_contrast_medium.color),
  },
  dim: {
    tint: themeColor(themes.dim.atoms.bg.backgroundColor),
    baseAlpha: 0.38,
    text: themeColor(themes.dim.atoms.text_contrast_medium.color),
  },
  dark: {
    tint: {r: 0, g: 0, b: 0},
    baseAlpha: 0.38,
    text: themeColor(themes.dark.atoms.text_contrast_medium.color),
  },
}

/** `rgba(...)` for a colour and an alpha. */
export function rgba({r, g, b}: RGB, alpha: number) {
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`
}

/** One 8-bit channel blend, as browsers composite. */
function blend(top: number, under: number, alpha: number) {
  return Math.round(top * alpha + under * (1 - alpha))
}

/** `top` at `alpha` composited over `under`. */
export function composite(top: RGB, under: RGB, alpha: number): RGB {
  return {
    r: blend(top.r, under.r, alpha),
    g: blend(top.g, under.g, alpha),
    b: blend(top.b, under.b, alpha),
  }
}

function linear(channel: number) {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance. */
export function luminance({r, g, b}: RGB) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** WCAG 2.x contrast ratio. */
export function contrast(x: RGB, y: RGB) {
  const lx = luminance(x)
  const ly = luminance(y)
  return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05)
}

/** The number of samples between two adjacent stops. */
const BETWEEN = 16

/** A part of a gradient line, 0 at its start and 1 at its end. */
export type GradientRange = readonly [number, number]

/** The whole gradient line. */
export const FULL_RANGE: GradientRange = [0, 1]

function lerp(a: RGB, b: RGB, f: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * f),
    g: Math.round(a.g + (b.g - a.g) * f),
    b: Math.round(a.b + (b.b - a.b) * f),
  }
}

/**
 * The colours of the def's first linear layer, compiled for the theme and
 * sampled at each stop and at 16 evenly spaced points between adjacent
 * stops. With a `range` (a window's part of the gradient line, batch A),
 * only the samples inside it, plus the colours at its two ends.
 */
export function sampledColors(
  def: BackdropDef,
  theme: ThemeName,
  look: BackdropLook = BACKDROP_LOOK,
  range: GradientRange = FULL_RANGE,
): RGB[] {
  const compiled = compileBackdrop(def, theme, {width: 1, height: 1}, look)
  if (!compiled) return []
  const layer = compiled.layers.find(l => l.kind === 'linear')
  if (!layer) return []
  const [from, to] = range
  const whole = from <= 0 && to >= 1
  const inside = (pos: number) => whole || (pos >= from && pos <= to)
  const out: RGB[] = []
  const stops = layer.stops
  stops.forEach((stop, i) => {
    if (inside(stop.pos)) out.push({r: stop.r, g: stop.g, b: stop.b})
    const next = stops[i + 1]
    if (!next) return
    for (let k = 1; k <= BETWEEN; k++) {
      const f = k / (BETWEEN + 1)
      if (inside(stop.pos + (next.pos - stop.pos) * f)) {
        out.push(lerp(stop, next, f))
      }
    }
  })
  if (!whole) {
    // The colours at the range's ends, where they fall between samples.
    for (const pos of [from, to]) {
      const i = stops.findIndex(
        (stop, j) => j + 1 < stops.length && pos <= stops[j + 1].pos,
      )
      if (i < 0) {
        const last = stops[stops.length - 1]
        out.push({r: last.r, g: last.g, b: last.b})
        continue
      }
      const a = stops[i]
      const b = stops[i + 1]
      const span = b.pos - a.pos
      const f = span > 0 ? Math.min(1, Math.max(0, (pos - a.pos) / span)) : 0
      out.push(lerp(a, b, f))
    }
  }
  /*
   * A def with its own layers (skies, colour blobs, change list 2) has
   * radial pools over the linear base: each pool's colours, at their
   * alpha, over every base sample, so the glass sees the pools too. The
   * whole frame's pools count for any range: a pool is not on the line.
   */
  if (def.layers) {
    const base = [...out]
    for (const radial of compiled.layers) {
      if (radial.kind !== 'radial') continue
      for (const stop of radial.stops) {
        if (stop.a < 0.02) continue
        for (const under of base) out.push(composite(stop, under, stop.a))
      }
    }
  }
  return out
}

/**
 * The smallest alpha, in 0.01 steps from `min` up to `max`, at which `tint`
 * over every colour of `under` gives `text` a contrast of at least `target`;
 * `max` when none does.
 */
export function smallestAlpha({
  under,
  tint,
  text,
  target,
  min,
  max = MAX_GLASS_ALPHA,
}: {
  under: RGB[]
  tint: RGB
  text: RGB
  target: number
  min: number
  max?: number
}): number {
  const from = Math.round(min * 100)
  const to = Math.round(max * 100)
  for (let step = from; step <= to; step++) {
    const alpha = step / 100
    const ok = under.every(
      color => contrast(composite(tint, color, alpha), text) >= target,
    )
    if (ok) return alpha
  }
  return max
}

/**
 * The backdrop's colours as the glass sees them: the sampled colours, with
 * the def's softness already applied by the compiler.
 */
export function colorsUnderGlass(
  def: BackdropDef,
  theme: ThemeName,
  look: BackdropLook = BACKDROP_LOOK,
): RGB[] {
  return sampledColors(def, theme, look)
}

/** What a def's glass depends on: its id, colours, layers and softness. */
export function backdropKey(def: BackdropDef) {
  return `${def.id}|${def.stripes.join(',')}|${layersKey(def.layers)}|${def.soften ?? 0}`
}

const alphaCache = new Map<string, number>()

/**
 * The glass alpha for a def and a theme (7.3), before any
 * reduced-transparency floor. Memoised per def, theme and look.
 */
export function glassAlpha(
  def: BackdropDef,
  theme: ThemeName,
  look: BackdropLook = BACKDROP_LOOK,
): number {
  const key = `${backdropKey(def)}|${theme}|${look}`
  const cached = alphaCache.get(key)
  if (cached !== undefined) return cached
  const glass = GLASS[theme]
  const alpha = smallestAlpha({
    under: colorsUnderGlass(def, theme, look),
    tint: glass.tint,
    text: glass.text,
    target: 4.5,
    min: glass.baseAlpha,
  })
  // Custom previews add a key per slider position; keep the cache small.
  if (alphaCache.size >= 512) alphaCache.clear()
  alphaCache.set(key, alpha)
  return alpha
}

/** True where the browser asks for reduced transparency (web only). */
export function prefersReducedTransparency(): boolean {
  if (!IS_WEB || typeof window === 'undefined' || !window.matchMedia) {
    return false
  }
  return window.matchMedia('(prefers-reduced-transparency: reduce)').matches
}

/**
 * The glass to draw for a def and a theme: the tint as CSS colour and its
 * alpha (raised to 0.85 under reduced transparency).
 */
export function glassFor(
  def: BackdropDef,
  theme: ThemeName,
  reduced: boolean = prefersReducedTransparency(),
): {color: string; alpha: number} {
  const base = glassAlpha(def, theme)
  const alpha = reduced ? Math.max(base, REDUCED_TRANSPARENCY_ALPHA) : base
  return {color: rgba(GLASS[theme].tint, alpha), alpha}
}
