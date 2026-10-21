/*
 * The device value under `horizon:appearance` (Phase 3 design, 6.1): this
 * device's own appearance, the opt-out, a copy per account and the
 * device-only settings (the phone frame, the backdrop softness, the grain
 * and the hemisphere "Follow the season" uses). Parsed leniently, field by field; a missing, unparsable or
 * other-version value reads as the default. A stored id of a removed solid
 * reads as a custom one-tone of its colour (change list 2, item 9).
 */

import {
  type Appearance,
  type AppearanceField,
  DEFAULT_APPEARANCE,
  DEFAULT_CUSTOM,
  emptyPresetSlots,
  parseThemePrefs,
  PRESET_SLOT_COUNT,
  type PresetSlots,
  THEME_PREF_FIELDS,
} from '#/horizon/appearance/model'
import {
  parseBackdropId,
  parseCustom,
  parsePresetBody,
} from '#/horizon/appearance/record'
import {
  DEFAULT_FRAME_STYLE,
  type FrameStyle,
  parseFrameStyle,
} from '#/horizon/backdrops/frame-style'
import {migrateRemovedSolid} from '#/horizon/backdrops/registry'
import {
  DEFAULT_SOFTNESS,
  parseSoftness,
  type SoftnessValues,
} from '#/horizon/backdrops/softness'

export const APPEARANCE_DEVICE_KEY = 'horizon:appearance'

export type AccountCopy = {
  /** Parsed from the repo, or what was last written; null = the repo has none. */
  record: Appearance | null
  /** The record as read, for 5.4; null with `record` null. */
  raw: Record<string, unknown> | null
  /** CID of `raw`, for `swapRecord`; null with `record` null. */
  cid: string | null
  /** Epoch ms of the last successful read or write; 0 = never read. */
  syncedAt: number
  /** An edit not yet written. */
  pending: {
    fields: AppearanceField[]
    appearance: Appearance
    seq: number
  } | null
  /** Set after a write the PDS refused for good (6.5); cleared when the store loads at app start. */
  blocked: boolean
}

export type DeviceAppearanceV1 = {
  v: 1
  /** This device's own appearance: used signed out and when opted out. */
  device: Appearance
  /** The opt-out: when true this device ignores every account's record. */
  optOut: boolean
  /** Per account on this device, by DID. */
  accounts: Record<string, AccountCopy>
  /**
   * The phone frame (9.3, 9.6, 9.7, live fix batch 1). Device only. Gutter
   * replaced the retired `insetCard` toggle, which parsing maps to it.
   */
  frameStyle: FrameStyle
  /**
   * Backdrop softness in dim and dark, 0 to 100 (live fix batch 1). Device
   * only: how calm a backdrop should look depends on the screen.
   */
  softness: SoftnessValues
  /**
   * Film grain over the backdrop (change list 2, item 6), off by default.
   * Device only, like the softness: it is about the screen.
   */
  grain: boolean
  /**
   * Whether "Follow the season" uses southern-hemisphere months (change
   * list 3, item 4); false, the northern ones, by default. Device only: it
   * is about where the device is.
   */
  southern: boolean
}

export function defaultDeviceValue(): DeviceAppearanceV1 {
  return {
    v: 1,
    device: DEFAULT_APPEARANCE,
    optOut: false,
    accounts: {},
    frameStyle: DEFAULT_FRAME_STYLE,
    softness: DEFAULT_SOFTNESS,
    grain: false,
    southern: false,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FIELDS = new Set<string>([
  'backdrop',
  'custom',
  ...THEME_PREF_FIELDS,
  ...Array.from({length: PRESET_SLOT_COUNT}, (_v, i) => `preset:${i + 1}`),
])

function parseSlots(value: unknown): PresetSlots {
  const slots = emptyPresetSlots()
  if (!Array.isArray(value)) return slots
  for (let i = 0; i < PRESET_SLOT_COUNT; i++) {
    slots[i] = value[i] === null ? null : parsePresetBody(value[i])
  }
  return slots
}

/** An appearance as this module stores it, parsed with the 5.3 rules. */
export function parseStoredAppearance(value: unknown): Appearance | null {
  if (!isObject(value)) return null
  // A removed solid reads as a custom one-tone (change list 2, item 9).
  return migrateRemovedSolid({
    backdrop: parseBackdropId(value.backdrop),
    custom: parseCustom(value.custom) ?? DEFAULT_CUSTOM,
    presets: parseSlots(value.presets),
    ...parseThemePrefs(value),
  })
}

function parsePending(value: unknown): AccountCopy['pending'] {
  if (!isObject(value)) return null
  const appearance = parseStoredAppearance(value.appearance)
  if (!appearance || !Array.isArray(value.fields)) return null
  const fields = value.fields.filter(
    (field): field is AppearanceField =>
      typeof field === 'string' && FIELDS.has(field),
  )
  const seq =
    typeof value.seq === 'number' && Number.isInteger(value.seq) ? value.seq : 0
  return {fields, appearance, seq}
}

function parseCopy(value: unknown): AccountCopy | null {
  if (!isObject(value)) return null
  const record = parseStoredAppearance(value.record)
  const raw = record && isObject(value.raw) ? value.raw : null
  const cid = record && typeof value.cid === 'string' ? value.cid : null
  return {
    record,
    raw: record ? (raw ?? {}) : null,
    cid,
    syncedAt:
      typeof value.syncedAt === 'number' && value.syncedAt > 0
        ? value.syncedAt
        : 0,
    pending: parsePending(value.pending),
    blocked: value.blocked === true,
  }
}

/** Parse the stored JSON string (or its absence). */
export function parseDeviceValue(json: string | undefined): DeviceAppearanceV1 {
  if (json === undefined) return defaultDeviceValue()
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return defaultDeviceValue()
  }
  if (!isObject(value) || value.v !== 1) return defaultDeviceValue()
  const accounts: Record<string, AccountCopy> = {}
  if (isObject(value.accounts)) {
    for (const [did, copy] of Object.entries(value.accounts)) {
      const parsed = parseCopy(copy)
      if (parsed) accounts[did] = parsed
    }
  }
  return {
    v: 1,
    device: parseStoredAppearance(value.device) ?? DEFAULT_APPEARANCE,
    optOut: value.optOut === true,
    accounts,
    frameStyle: parseFrameStyle(value.frameStyle, value.insetCard),
    softness: parseSoftness(value.softness),
    grain: value.grain === true,
    southern: value.southern === true,
  }
}

/** The JSON string to store. */
export function serializeDeviceValue(value: DeviceAppearanceV1): string {
  return JSON.stringify(value)
}
