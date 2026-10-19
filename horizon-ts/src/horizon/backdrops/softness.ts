/*
 * Backdrop softness (Phase 3, live fix batch 1): in dim and dark the
 * backdrop is calmed, not darkened. Each colour loses some saturation
 * towards its own luma and is then blended a little towards a mid-tone of
 * the theme, so hues keep their identity, bright colours come down and very
 * dark ones lift slightly. It replaces the dark theme's old black veil.
 *
 * The treatment is applied to the compiled stops (`compile.ts`), so the
 * fixed layer, every window and lens, the rail cards' glass rule and the
 * native painter all see the same colours. Both steps are affine per
 * channel, so treating the stops and then interpolating gives what a CSS
 * `saturate()` and a blend over the interpolated gradient would.
 */

import {themes} from '#/alf/themes'
import {type ThemeName} from '#/horizon/backdrops/types'

type Channels = {r: number; g: number; b: number}

/** Per-device softness, 0 (full colour) to 100 (strongest), per theme. */
export type SoftnessValues = {dim: number; dark: number}

/** The themes that have a softness. Light keeps the full colours. */
export type SoftTheme = keyof SoftnessValues

export const SOFT_THEMES: readonly SoftTheme[] = ['dim', 'dark']

/** Clearly softer, still colourful. */
export const DEFAULT_SOFTNESS: SoftnessValues = {dim: 40, dark: 50}

/** At 100, the share of each colour's saturation taken away. */
export const SOFTNESS_MAX_DESATURATION = 0.5

/** At 100, the share of the theme's mid-tone blended in. */
export const SOFTNESS_MAX_TONE = 0.5

function hexChannels(hex: string): Channels {
  const n = parseInt(hex.slice(1, 7), 16)
  return {r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255}
}

/**
 * A theme's mid-tone: halfway between its background and its
 * `text_contrast_medium`, so dark gets a cool grey and dim a slate.
 */
export function softnessMidTone(theme: ThemeName): Channels {
  const bg = hexChannels(String(themes[theme].atoms.bg.backgroundColor))
  const text = hexChannels(
    String(themes[theme].atoms.text_contrast_medium.color),
  )
  return {
    r: Math.round((bg.r + text.r) / 2),
    g: Math.round((bg.g + text.g) / 2),
    b: Math.round((bg.b + text.b) / 2),
  }
}

const midTones: Partial<Record<ThemeName, Channels>> = {}

function midTone(theme: ThemeName): Channels {
  return (midTones[theme] ??= softnessMidTone(theme))
}

function clamp255(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/**
 * One colour softened for `theme` at `amount` (0..1). Light, or an amount
 * of 0, returns the colour unchanged.
 */
export function softenRgb<T extends Channels>(
  color: T,
  theme: ThemeName,
  amount: number,
): T {
  if (theme === 'light' || !(amount > 0)) return color
  const s = Math.min(1, amount)
  const keep = 1 - SOFTNESS_MAX_DESATURATION * s
  const tone = SOFTNESS_MAX_TONE * s
  const m = midTone(theme)
  // The same luma weights as CSS `saturate()`.
  const luma = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
  const channel = (value: number, mid: number) =>
    clamp255((luma + (value - luma) * keep) * (1 - tone) + mid * tone)
  return {
    ...color,
    r: channel(color.r, m.r),
    g: channel(color.g, m.g),
    b: channel(color.b, m.b),
  }
}

/** A stored softness value, leniently: an integer from 0 to 100. */
function parseOne(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** The stored softness, leniently; anything unusable reads as the default. */
export function parseSoftness(value: unknown): SoftnessValues {
  const source =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    dim: parseOne(source.dim, DEFAULT_SOFTNESS.dim),
    dark: parseOne(source.dark, DEFAULT_SOFTNESS.dark),
  }
}

/** The amount (0..1) the compiler applies for `theme`: 0 in light. */
export function softnessAmount(
  values: SoftnessValues,
  theme: ThemeName,
): number {
  return theme === 'light' ? 0 : values[theme] / 100
}
