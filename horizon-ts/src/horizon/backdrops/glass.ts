/*
 * The theme's glass over the backdrop (Phase 3 design, 7.3): one tint per
 * theme for every frame surface, at the smallest alpha that keeps the
 * theme's `text_contrast_medium` at 4.5:1 over the backdrop's worst colour.
 */

import {themes} from '#/alf/themes'
import {IS_WEB} from '#/env'
import {compileBackdrop, hexToRgb, type RGB} from '#/horizon/backdrops/compile'
import {BACKDROP_LOOK, type BackdropLook} from '#/horizon/backdrops/look'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

/** The highest alpha the rule goes to. */
export const MAX_GLASS_ALPHA = 0.92

/** The alpha floor where the browser asks for reduced transparency. */
export const REDUCED_TRANSPARENCY_ALPHA = 0.85

/** The rail and nav cards' blur, in pixels (>= 800px wide only). */
export const GLASS_BLUR = 14

/** The dark theme's veil over the backdrop. */
export const DARK_VEIL = {color: {r: 0, g: 0, b: 0}, alpha: 0.18}

export type GlassTheme = {
  tint: RGB
  baseAlpha: number
  veil: {color: RGB; alpha: number} | null
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
    veil: null,
    text: themeColor(themes.light.atoms.text_contrast_medium.color),
  },
  dim: {
    tint: themeColor(themes.dim.atoms.bg.backgroundColor),
    baseAlpha: 0.38,
    veil: null,
    text: themeColor(themes.dim.atoms.text_contrast_medium.color),
  },
  dark: {
    tint: {r: 0, g: 0, b: 0},
    baseAlpha: 0.38,
    veil: DARK_VEIL,
    text: themeColor(themes.dark.atoms.text_contrast_medium.color),
  },
}

/** `rgba(...)` for a colour and an alpha. */
export function rgba({r, g, b}: RGB, alpha: number) {
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`
}

/** The dark veil as CSS overlays (empty in light and dim). */
export function veilOverlays(theme: ThemeName): string[] {
  const veil = GLASS[theme].veil
  return veil ? [rgba(veil.color, veil.alpha)] : []
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

/**
 * The colours of the def's first linear layer, compiled for the theme and
 * sampled at each stop and at 16 evenly spaced points between adjacent
 * stops.
 */
export function sampledColors(
  def: BackdropDef,
  theme: ThemeName,
  look: BackdropLook = BACKDROP_LOOK,
): RGB[] {
  const compiled = compileBackdrop(def, theme, {width: 1, height: 1}, look)
  if (!compiled) return []
  const layer = compiled.layers.find(l => l.kind === 'linear')
  if (!layer) return []
  const out: RGB[] = []
  layer.stops.forEach((stop, i) => {
    out.push({r: stop.r, g: stop.g, b: stop.b})
    const next = layer.stops[i + 1]
    if (!next) return
    for (let k = 1; k <= BETWEEN; k++) {
      const f = k / (BETWEEN + 1)
      out.push({
        r: Math.round(stop.r + (next.r - stop.r) * f),
        g: Math.round(stop.g + (next.g - stop.g) * f),
        b: Math.round(stop.b + (next.b - stop.b) * f),
      })
    }
  })
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

/** The backdrop's colours as the glass sees them: under the veil in dark. */
export function colorsUnderGlass(
  def: BackdropDef,
  theme: ThemeName,
  look: BackdropLook = BACKDROP_LOOK,
): RGB[] {
  const veil = GLASS[theme].veil
  const colors = sampledColors(def, theme, look)
  return veil
    ? colors.map(color => composite(veil.color, color, veil.alpha))
    : colors
}

function defKey(def: BackdropDef) {
  return `${def.id}|${def.stripes.join(',')}`
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
  const key = `${defKey(def)}|${theme}|${look}`
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
 * The glass to draw for a def and a theme: the tint as CSS colour, its
 * alpha (raised to 0.85 under reduced transparency) and whether blur is
 * allowed (not under reduced transparency).
 */
export function glassFor(
  def: BackdropDef,
  theme: ThemeName,
  reduced: boolean = prefersReducedTransparency(),
): {color: string; alpha: number; blur: boolean} {
  const base = glassAlpha(def, theme)
  const alpha = reduced ? Math.max(base, REDUCED_TRANSPARENCY_ALPHA) : base
  return {color: rgba(GLASS[theme].tint, alpha), alpha, blur: !reduced}
}
