/*
 * Reading and writing the appearance record (Phase 3 design, 5.3 and 5.4).
 * Reads are lenient, field by field; writes replace only the fields an edit
 * named and keep everything else as read, so a newer client's fields survive
 * an older client's write.
 */

import {countGraphemes} from 'unicode-segmenter/grapheme'

import {
  type Appearance,
  type AppearanceField,
  CUSTOM_MODES,
  type CustomConfig,
  DEFAULT_APPEARANCE,
  DEFAULT_CUSTOM,
  emptyPresetSlots,
  isHex,
  parseThemePrefs,
  PATTERN_NAMES,
  type Preset,
  PRESET_SLOT_COUNT,
  type PresetSlots,
  STRIPES_MAX,
  STRIPES_MIN,
  THEME_PREF_FIELDS,
} from '#/horizon/appearance/model'
import {
  migrateRemovedSolid,
  REMOVED_SOLIDS,
  RENAMED_BACKDROPS,
} from '#/horizon/backdrops/registry'
import {type PatternName} from '#/horizon/backdrops/types'
import {
  APPEARANCE_COLLECTION,
  type AppearanceRecord,
  type CustomBackdropRecord,
  type PresetRecord,
} from '#/horizon/lexicons/appearance'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSlot(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PRESET_SLOT_COUNT
  )
}

/**
 * Custom stripes (change list 3, item 10): 2 to 8 colours, uppercased;
 * undefined for anything else.
 */
export function parseStripes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length < STRIPES_MIN || value.length > STRIPES_MAX) return undefined
  if (!value.every(isHex)) return undefined
  return value.map(hex => hex.toUpperCase())
}

/** A custom configuration, or null when it does not parse (5.3). */
export function parseCustom(value: unknown): CustomConfig | null {
  if (!isObject(value)) return null
  const {a, b} = value
  if (!(CUSTOM_MODES as readonly unknown[]).includes(value.mode)) return null
  if (!isHex(a)) return null
  if (b !== undefined && !isHex(b)) return null
  const upperA = a.toUpperCase()
  const stripes = parseStripes(value.stripes)
  const config: CustomConfig = {
    // Stripes without usable colours read as the two-tone of `a` and `b`.
    mode:
      value.mode === 'stripes' && !stripes
        ? 'twoTone'
        : (value.mode as CustomConfig['mode']),
    a: upperA,
    b: b === undefined ? upperA : b.toUpperCase(),
  }
  // An unknown pattern reads as none; the colours still count.
  if ((PATTERN_NAMES as readonly unknown[]).includes(value.pattern)) {
    config.pattern = value.pattern as PatternName
  }
  if (stripes) config.stripes = stripes
  return config
}

/** A backdrop id: a string of 1-64 characters, else the default. */
export function parseBackdropId(value: unknown): string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    ? value
    : DEFAULT_APPEARANCE.backdrop
}

/** A preset name: kept if a string of 1-64 graphemes. */
export function parsePresetName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const n = countGraphemes(value)
  return n >= 1 && n <= 64 ? value : undefined
}

/** A preset's fields other than its slot, or null when they do not parse. */
export function parsePresetBody(value: unknown): Preset | null {
  if (!isObject(value)) return null
  const custom = parseCustom(value.custom)
  if (!custom || typeof value.savedAt !== 'string') return null
  const name = parsePresetName(value.name)
  return name === undefined
    ? {custom, savedAt: value.savedAt}
    : {name, custom, savedAt: value.savedAt}
}

/** The record's preset items as ten slots; the first item wins a slot. */
function parsePresetItems(value: unknown): PresetSlots {
  const slots = emptyPresetSlots()
  if (!Array.isArray(value)) return slots
  for (const item of value) {
    if (!isObject(item) || !isSlot(item.slot)) continue
    if (slots[item.slot - 1]) continue
    const preset = parsePresetBody(item)
    if (preset) slots[item.slot - 1] = preset
  }
  return slots
}

/**
 * Parse a record value. Null when it is not an object or its `$type` is
 * another collection's (treated as no record). `raw` is a shallow copy
 * without `$type`, kept for writing back.
 */
export function parseAppearanceRecord(
  value: unknown,
): {appearance: Appearance; raw: Record<string, unknown>} | null {
  if (!isObject(value)) return null
  if (value.$type !== undefined && value.$type !== APPEARANCE_COLLECTION) {
    return null
  }
  const {$type: _type, ...raw} = value
  return {
    // A removed solid reads as a custom one-tone (change list 2, item 9).
    appearance: migrateRemovedSolid({
      backdrop: parseBackdropId(value.backdrop),
      custom: parseCustom(value.custom) ?? DEFAULT_CUSTOM,
      presets: parsePresetItems(value.presets),
      ...parseThemePrefs(value),
    }),
    raw,
  }
}

function customRecord(config: CustomConfig): CustomBackdropRecord {
  const out: CustomBackdropRecord = {
    mode: config.mode,
    a: config.a,
    b: config.b,
  }
  if (config.pattern) out.pattern = config.pattern
  if (config.stripes) out.stripes = [...config.stripes]
  return out
}

function presetRecord(slot: number, preset: Preset): PresetRecord {
  const item: PresetRecord = {
    slot,
    custom: customRecord(preset.custom),
    savedAt: preset.savedAt as PresetRecord['savedAt'],
  }
  if (preset.name !== undefined) item.name = preset.name
  return item
}

function slotOfField(field: AppearanceField): number | null {
  if (!field.startsWith('preset:')) return null
  const slot = Number(field.slice('preset:'.length))
  return isSlot(slot) ? slot : null
}

/** The written record: the stock shape plus any fields kept from `raw`. */
export type BuiltAppearanceRecord = AppearanceRecord & Record<string, unknown>

/**
 * The record to put (5.4). With no record in the repo (`raw` null) every
 * field is written; otherwise only `fields` are replaced and everything else
 * is kept as read.
 */
export function buildAppearanceRecord(
  raw: Record<string, unknown> | null,
  appearance: Appearance,
  fields: Iterable<AppearanceField>,
  now: Date,
): BuiltAppearanceRecord {
  const base: Record<string, unknown> = raw ? {...raw} : {}
  const named = new Set(fields)
  const all = raw === null
  /*
   * A record still naming a removed solid was read as Custom one-tone of
   * its colour (item 9): any write puts that reading back, so the record
   * and what this device shows agree whatever field the edit named.
   */
  if (typeof raw?.backdrop === 'string' && raw.backdrop in REMOVED_SOLIDS) {
    named.add('backdrop')
    named.add('custom')
  }
  // A renamed backdrop's old id is replaced in the record on any write.
  if (typeof raw?.backdrop === 'string' && raw.backdrop in RENAMED_BACKDROPS) {
    named.add('backdrop')
  }

  if (all || named.has('backdrop')) base.backdrop = appearance.backdrop
  if (all || named.has('custom')) base.custom = customRecord(appearance.custom)
  // The theme settings (item 11): written when set, removed when cleared.
  for (const field of THEME_PREF_FIELDS) {
    if (!all && !named.has(field)) continue
    const value = appearance[field]
    if (value === undefined) delete base[field]
    else base[field] = value
  }

  const replaced = new Set<number>()
  if (all) {
    for (let slot = 1; slot <= PRESET_SLOT_COUNT; slot++) replaced.add(slot)
  } else {
    for (const field of named) {
      const slot = slotOfField(field)
      if (slot !== null) replaced.add(slot)
    }
  }

  const read =
    raw && Array.isArray(raw.presets) ? (raw.presets as unknown[]) : []
  const numbered: {slot: number; item: unknown}[] = []
  const others: unknown[] = []
  for (const item of read) {
    const slot = isObject(item) && isSlot(item.slot) ? item.slot : null
    if (slot === null) others.push(item)
    else if (!replaced.has(slot)) numbered.push({slot, item})
  }
  for (const slot of replaced) {
    const preset = appearance.presets[slot - 1]
    if (preset) numbered.push({slot, item: presetRecord(slot, preset)})
  }
  numbered.sort((x, y) => x.slot - y.slot)
  const presets = [...numbered.map(entry => entry.item), ...others]
  if (presets.length > 0) base.presets = presets
  else delete base.presets

  const version =
    raw && typeof raw.version === 'number' && Number.isInteger(raw.version)
      ? Math.max(1, raw.version)
      : 1

  return {
    ...base,
    $type: APPEARANCE_COLLECTION,
    version,
    updatedAt: now.toISOString() as AppearanceRecord['updatedAt'],
  }
}
