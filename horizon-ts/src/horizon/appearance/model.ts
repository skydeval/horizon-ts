/*
 * An account's or a device's appearance (Phase 3 design, 3.3 to 3.5): the
 * selected backdrop, the custom colours and the ten preset slots.
 */

import {type Hex} from '#/horizon/backdrops/types'

export type CustomConfig = {
  mode: 'solid' | 'twoTone'
  /** Solid colour, or Top Left in two-tone. */
  a: Hex
  /** Bottom Right in two-tone; kept while solid so switching back restores it. */
  b: Hex
}

export const DEFAULT_CUSTOM: CustomConfig = {
  mode: 'twoTone',
  a: '#FFE2FF',
  b: '#CCFFFF',
}

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

export type Appearance = {
  /** A registry id, `custom`, or an id this build does not know (kept, drawn as none). */
  backdrop: string
  custom: CustomConfig
  presets: PresetSlots
}

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

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/

/** True for `#RRGGBB` in either case. */
export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_PATTERN.test(value)
}
