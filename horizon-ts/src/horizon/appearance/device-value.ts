/*
 * The device value under `horizon:appearance` (Phase 3 design, 6.1): this
 * device's own appearance, the opt-out, a copy per account and the two
 * device-only prototype settings. Parsed leniently, field by field; a
 * missing, unparsable or other-version value reads as the default.
 */

import {
  type Appearance,
  type AppearanceField,
  DEFAULT_APPEARANCE,
  DEFAULT_CUSTOM,
  emptyPresetSlots,
  PRESET_SLOT_COUNT,
  type PresetSlots,
} from '#/horizon/appearance/model'
import {
  parseBackdropId,
  parseCustom,
  parsePresetBody,
} from '#/horizon/appearance/record'

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
  /** Compact frame prototype (9.7). Device only. */
  frameStyle: 'bars' | 'buttons'
  /** Inset reading card (9.6). Device only. */
  insetCard: boolean
}

export function defaultDeviceValue(): DeviceAppearanceV1 {
  return {
    v: 1,
    device: DEFAULT_APPEARANCE,
    optOut: false,
    accounts: {},
    frameStyle: 'bars',
    insetCard: false,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FIELDS = new Set<string>([
  'backdrop',
  'custom',
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
  return {
    backdrop: parseBackdropId(value.backdrop),
    custom: parseCustom(value.custom) ?? DEFAULT_CUSTOM,
    presets: parseSlots(value.presets),
  }
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
    frameStyle: value.frameStyle === 'buttons' ? 'buttons' : 'bars',
    insetCard: value.insetCard === true,
  }
}

/** The JSON string to store. */
export function serializeDeviceValue(value: DeviceAppearanceV1): string {
  return JSON.stringify(value)
}
