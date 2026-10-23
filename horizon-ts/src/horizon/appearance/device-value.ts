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

/**
 * Where an account's appearance is saved ("Save my appearance", storage
 * choice design section 2): `private` on prism (members only), `public` in
 * the account's repo record, `device` on each device only.
 */
export type AppearanceStore = 'private' | 'public' | 'device'

export const APPEARANCE_STORES: readonly AppearanceStore[] = [
  'private',
  'public',
  'device',
]

/** An edit, a choice change, or both, not yet written (5, 5.1). */
export type PendingAppearance = {
  fields: AppearanceField[]
  appearance: Appearance
  seq: number
  /** A choice change not yet landed (`pending.store`). */
  store?: AppearanceStore
  /**
   * The put is a row creation the member table made (the migration, a first
   * move-up, a rejoin), not the user's choice (sections 4, 6, 8.5).
   */
  auto?: boolean
}

export type AccountCopy = {
  /**
   * The account's value as this device last had it. A non-member: the
   * record as read, or this device's own copy with `device`. A member:
   * prism's row value, or this device's own copy with `device`.
   */
  record: Appearance | null
  /** `record` as read (without `$type`), kept for writing back; null with `record` null. */
  raw: Record<string, unknown> | null
  /** A non-member's record CID, for `swapRecord`; unused for members. */
  cid: string | null
  /** Epoch ms of the last successful read or write; 0 = never read. */
  syncedAt: number
  /** An edit or a choice change not yet written. */
  pending: PendingAppearance | null
  /** Set after a write the PDS refused for good (6.5); cleared when the store loads at app start. */
  blocked: boolean
  /** The chosen store as last answered or derived; null = never resolved. */
  store: AppearanceStore | null
  /**
   * Whether `store` was answered or derived in this run, rather than only
   * remembered. Cleared when the store loads at app start.
   */
  storeKnown: boolean
  /**
   * prism's row `rev` as last read or put; `''` after reading no row; null
   * when this copy was last resolved as a non-member (section 4, AS7-N2).
   */
  rev: string | null
  /** The record step (5.3) is still to run. */
  recordDue: boolean
  /** A non-member's record delete still to land, swapped on `cid` (7.3). */
  cleanup: {cid: string} | null
  /** The migration note is owed, once its delete is confirmed (section 6). */
  noteDue: boolean
  /** The migration note's line under the setting shows, until dismissed. */
  noted: boolean
  /**
   * The last row this device read or put as a member said `device` (8.5).
   * Set and cleared only by such an answer; kept through a removal.
   */
  memberDevice: boolean
  /** The removal note was shown for this removal (8.4). */
  removalNoted: boolean
  /** The removal note's line under the setting shows, until dismissed. */
  removalLine: boolean
  /**
   * prism refused the migration's value for its size (over 16 KiB). The
   * account stays public and the `auto` put is not tried again at sign-in;
   * the next edit tries again, checked locally first. Cleared by the next
   * member row answered.
   */
  tooLarge: boolean
  /** The too-large note's line under the setting shows, until dismissed. */
  tooLargeLine: boolean
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

/** An account copy for an account never read on this device. */
export function emptyAccountCopy(): AccountCopy {
  return {
    record: null,
    raw: null,
    cid: null,
    syncedAt: 0,
    pending: null,
    blocked: false,
    store: null,
    storeKnown: false,
    rev: null,
    recordDue: false,
    cleanup: null,
    noteDue: false,
    noted: false,
    memberDevice: false,
    removalNoted: false,
    removalLine: false,
    tooLarge: false,
    tooLargeLine: false,
  }
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
  const store = parseStore(value.store)
  const out: PendingAppearance = {fields, appearance, seq}
  if (store) {
    out.store = store
    if (value.auto === true) out.auto = true
  }
  return out
}

/** A stored choice, or null for anything else. */
export function parseStore(value: unknown): AppearanceStore | null {
  return APPEARANCE_STORES.find(store => store === value) ?? null
}

function parseCleanup(value: unknown): AccountCopy['cleanup'] {
  if (!isObject(value) || typeof value.cid !== 'string' || !value.cid) {
    return null
  }
  return {cid: value.cid}
}

function parseCopy(value: unknown): AccountCopy | null {
  if (!isObject(value)) return null
  const record = parseStoredAppearance(value.record)
  const raw = record && isObject(value.raw) ? value.raw : null
  const cid = record && typeof value.cid === 'string' ? value.cid : null
  const store = parseStore(value.store)
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
    store,
    storeKnown: store !== null && value.storeKnown === true,
    rev: typeof value.rev === 'string' ? value.rev : null,
    recordDue: value.recordDue === true,
    cleanup: parseCleanup(value.cleanup),
    noteDue: value.noteDue === true,
    noted: value.noted === true,
    memberDevice: value.memberDevice === true,
    removalNoted: value.removalNoted === true,
    removalLine: value.removalLine === true,
    tooLarge: value.tooLarge === true,
    tooLargeLine: value.tooLargeLine === true,
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
