/*
 * An account's or a device's appearance (Phase 3 design, 3.3 to 3.5): the
 * selected backdrop, the custom colours and the ten preset slots, and
 * (change list 2, item 11) the account's colour mode, dark theme, font and
 * font size, each optional: absent means the account has not chosen, and
 * the device's own setting stays.
 */

import {type Hex, type PatternName} from '#/horizon/backdrops/types'

export type CustomConfig = {
  mode: 'solid' | 'twoTone'
  /** Solid colour, or Top Left in two-tone. */
  a: Hex
  /** Bottom Right in two-tone; kept while solid so switching back restores it. */
  b: Hex
  /**
   * A quiet pattern over a one-tone (change list 2, item 7); absent for
   * none. Kept while two-tone, where it is not drawn.
   */
  pattern?: PatternName
}

export const DEFAULT_CUSTOM: CustomConfig = {
  mode: 'twoTone',
  a: '#FFE2FF',
  b: '#CCFFFF',
}

export const PATTERN_NAMES: readonly PatternName[] = ['dots', 'grid', 'lines']

export type Preset = {
  /** Never set by Phase 3 UI; kept from a record (Q8). 1-64 graphemes. */
  name?: string
  custom: CustomConfig
  /** ISO datetime of the save. */
  savedAt: string
}

/** Always length 10; index i is slot i + 1; null is an empty slot. */
export type PresetSlots = (Preset | null)[]

export const PRESET_SLOT_COUNT = 10

export type ColorModePref = 'system' | 'light' | 'dark'
export type DarkThemePref = 'dim' | 'dark'
export type FontPref = 'system' | 'theme'
/** The stock Font size choices, by their labels. */
export type FontSizePref = 'smaller' | 'default' | 'larger'

/** The account-wide theme settings an appearance may carry (item 11). */
export type ThemePrefs = {
  colorMode?: ColorModePref
  darkTheme?: DarkThemePref
  font?: FontPref
  fontSize?: FontSizePref
}

export const THEME_PREF_FIELDS = [
  'colorMode',
  'darkTheme',
  'font',
  'fontSize',
] as const

export type ThemePrefField = (typeof THEME_PREF_FIELDS)[number]

/** Each theme setting's known values. */
export const THEME_PREF_VALUES: {
  [K in ThemePrefField]: readonly NonNullable<ThemePrefs[K]>[]
} = {
  colorMode: ['system', 'light', 'dark'],
  darkTheme: ['dim', 'dark'],
  font: ['system', 'theme'],
  fontSize: ['smaller', 'default', 'larger'],
}

export type Appearance = {
  /** A registry id, `custom`, or an id this build does not know (kept, drawn as none). */
  backdrop: string
  custom: CustomConfig
  presets: PresetSlots
} & ThemePrefs

export function emptyPresetSlots(): PresetSlots {
  return new Array<Preset | null>(PRESET_SLOT_COUNT).fill(null)
}

export const DEFAULT_APPEARANCE: Appearance = {
  backdrop: 'none',
  custom: DEFAULT_CUSTOM,
  presets: emptyPresetSlots(),
}

/** A field an edit changes; a preset slot is named by its number. */
export type AppearanceField =
  | 'backdrop'
  | 'custom'
  | ThemePrefField
  | 'preset:1'
  | 'preset:2'
  | 'preset:3'
  | 'preset:4'
  | 'preset:5'
  | 'preset:6'
  | 'preset:7'
  | 'preset:8'
  | 'preset:9'
  | 'preset:10'

/** The field of preset slot `slot` (1-10). */
export function presetField(slot: number): AppearanceField {
  return `preset:${slot}` as AppearanceField
}

/** Whether `field` is one of the theme settings. */
export function isThemePrefField(field: string): field is ThemePrefField {
  return (THEME_PREF_FIELDS as readonly string[]).includes(field)
}

/** A theme setting's value if it is a known one, else undefined. */
export function parseThemePref<K extends ThemePrefField>(
  field: K,
  value: unknown,
): ThemePrefs[K] {
  return (THEME_PREF_VALUES[field] as readonly unknown[]).includes(value)
    ? (value as ThemePrefs[K])
    : undefined
}

/** The theme settings an object carries, known values only. */
export function parseThemePrefs(value: Record<string, unknown>): ThemePrefs {
  const out: ThemePrefs = {}
  for (const field of THEME_PREF_FIELDS) {
    const parsed = parseThemePref(field, value[field])
    if (parsed !== undefined) Object.assign(out, {[field]: parsed})
  }
  return out
}

/** An appearance without its theme settings (the device's own value). */
export function withoutThemePrefs(appearance: Appearance): Appearance {
  const {
    colorMode: _colorMode,
    darkTheme: _darkTheme,
    font: _font,
    fontSize: _fontSize,
    ...rest
  } = appearance
  return rest
}

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/

/** True for `#RRGGBB` in either case. */
export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_PATTERN.test(value)
}
