/*
 * Pure parsers for the pronouns and plural records (Phase 5 design 4.1,
 * 5.1): each record to a typed value or `null`, tolerant of keys Horizon
 * does not know (kept in `raw` for the editors) and strict on the limits of
 * the fields it displays. A displayed field over its lexicon's limit is
 * refused: an optional one is dropped, and a required one (a member's
 * `displayName`, the pronouns' `sets`, the front's `members`) refuses the
 * record. Horizon 1.0's off-spec fields (system `avatar`, `banner`,
 * `externalUrl`; member `pronounDisplayMode`, `externalUrl`) are never read
 * (PP-13).
 *
 * Values are read in their JSON form (`lexToJson`): blobs as
 * `{$type: 'blob', ref: {$link}}` or the legacy `{cid, mimeType}`, so a
 * parsed value can be persisted with the query cache as it is.
 */

import {isValidRecordKey} from '@atproto/syntax'
import {countGraphemes} from 'unicode-segmenter/grapheme'

import {
  PLURAL_FRONT_COLLECTION,
  PLURAL_MEMBER_COLLECTION,
  PLURAL_SYSTEM_COLLECTION,
  PRONOUNS_COLLECTION,
} from '#/horizon/lexicons/nearhorizon'

/** A pronouns record's display mode; anything else reads as `all`. */
export type DisplayMode = 'all' | 'firstOnly'

/** `app.nearhorizon.actor.pronouns`, as read. */
export type Pronouns = {
  /** Each set's forms, exactly as written. */
  sets: string[][]
  displayMode: DisplayMode
  createdAt?: string
  updatedAt?: string
  /** The record as read (JSON form), for the editor's spread on save. */
  raw: Record<string, unknown>
}

/** A blob reference, as the image URLs need it. */
export type BlobInfo = {cid: string; mimeType: string; size?: number}

/** `app.nearhorizon.plural.system`, as read. */
export type PluralSystem = {
  name?: string
  description?: string
  collectiveNoun?: string
  /** Self-reported, free text ("20+", "many"). */
  memberCount?: string
  createdAt?: string
  updatedAt?: string
  raw: Record<string, unknown>
}

/** `app.nearhorizon.plural.member#proxyRef`. */
export type MemberProxy = {id: string; note?: string}

/** `app.nearhorizon.plural.member`, as read. */
export type PluralMember = {
  displayName: string
  description?: string
  emoji?: string
  /** `#RRGGBB`. */
  color?: string
  /** Each set's forms, exactly as written. */
  pronouns: string[][]
  roles: string[]
  memberTypes: string[]
  agePresentation?: string
  proxy?: MemberProxy
  avatar?: BlobInfo
  banner?: BlobInfo
  createdAt?: string
  updatedAt?: string
  raw: Record<string, unknown>
}

/** `app.nearhorizon.plural.front#frontMember`. */
export type FrontMember = {id: string; status?: string}

/** `app.nearhorizon.plural.front`, as read. */
export type PluralFront = {
  members: FrontMember[]
  state?: string
  comment?: string
  setAt?: string
  raw: Record<string, unknown>
}

const COLOR = /^#[0-9A-Fa-f]{6}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/** A string within the limits, else `undefined`. */
function text(
  value: unknown,
  maxGraphemes: number,
  maxBytes: number,
): string | undefined {
  if (typeof value !== 'string') return undefined
  if (bytes(value) > maxBytes) return undefined
  if (countGraphemes(value) > maxGraphemes) return undefined
  return value
}

/** An optional string: absent is fine, present must be within limits. */
function optionalText(
  value: unknown,
  maxGraphemes: number,
  maxBytes: number,
): string | undefined {
  return value === undefined ? undefined : text(value, maxGraphemes, maxBytes)
}

function datetime(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A record of `collection`: an object whose `$type`, when set, matches. */
function recordOf(
  value: unknown,
  collection: string,
): Record<string, unknown> | null {
  if (!isObject(value)) return null
  if (value.$type !== undefined && value.$type !== collection) return null
  return value
}

/**
 * Pronoun sets within `limits`, or `null` when any set or form breaks them
 * (a form is never cut or dropped from its set).
 */
function pronounSets(
  value: unknown,
  limits: {
    sets: number
    forms: number
    minForms: number
    graphemes: number
    bytes: number
  },
): string[][] | null {
  if (!Array.isArray(value) || value.length > limits.sets) return null
  const sets: string[][] = []
  for (const set of value) {
    if (!isObject(set) || !Array.isArray(set.forms)) return null
    const forms = set.forms
    if (forms.length < limits.minForms || forms.length > limits.forms) {
      return null
    }
    const kept: string[] = []
    for (const form of forms) {
      const ok = text(form, limits.graphemes, limits.bytes)
      if (ok === undefined) return null
      kept.push(ok)
    }
    sets.push(kept)
  }
  return sets
}

function stringList(
  value: unknown,
  max: number,
  maxGraphemes: number,
  maxBytes: number,
): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined
  const out: string[] = []
  for (const item of value) {
    const ok = text(item, maxGraphemes, maxBytes)
    if (ok === undefined) return undefined
    out.push(ok)
  }
  return out
}

/**
 * A blob reference in JSON form (`{$type: 'blob', ref: {$link}, mimeType,
 * size}` or legacy `{cid, mimeType}`), else `undefined`.
 */
export function parseBlob(value: unknown): BlobInfo | undefined {
  if (!isObject(value)) return undefined
  const mimeType = value.mimeType
  if (typeof mimeType !== 'string') return undefined
  let cid: unknown
  if (isObject(value.ref)) cid = value.ref.$link
  else if (typeof value.cid === 'string') cid = value.cid
  if (typeof cid !== 'string' || cid.length === 0) return undefined
  const size = typeof value.size === 'number' ? value.size : undefined
  return size === undefined ? {cid, mimeType} : {cid, mimeType, size}
}

/**
 * The image types a member's avatar and banner accept: PNG, JPEG and (since
 * 2026-10-25, skydeval) WebP.
 */
export const MEMBER_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
]

/** A member image of {@link MEMBER_IMAGE_TYPES}, at most 1,000,000 bytes when sized. */
function memberImage(value: unknown): BlobInfo | undefined {
  const blob = parseBlob(value)
  if (!blob) return undefined
  if (!MEMBER_IMAGE_TYPES.includes(blob.mimeType)) return undefined
  if (blob.size !== undefined && blob.size > 1_000_000) return undefined
  return blob
}

/**
 * `app.nearhorizon.actor.pronouns`. `null` when it is not one or its sets
 * break the lexicon's limits (at most 10 sets of 1 to 12 forms, each at
 * most 24 graphemes and 240 bytes; the byte limit was raised from 64 on
 * 2026-10-25 so 24 graphemes of any script fit). A missing or unknown
 * `displayMode` reads as `all` (pronouns spec, normative rules).
 */
export function parsePronouns(value: unknown): Pronouns | null {
  const record = recordOf(value, PRONOUNS_COLLECTION)
  if (!record) return null
  const sets = pronounSets(record.sets, {
    sets: 10,
    forms: 12,
    minForms: 1,
    graphemes: 24,
    bytes: 240,
  })
  if (!sets) return null
  return {
    sets,
    displayMode: record.displayMode === 'firstOnly' ? 'firstOnly' : 'all',
    createdAt: datetime(record.createdAt),
    updatedAt: datetime(record.updatedAt),
    raw: record,
  }
}

/**
 * `app.nearhorizon.plural.system`. Every field is optional, so any object
 * of the collection parses; a field over its limit is dropped.
 */
export function parseSystem(value: unknown): PluralSystem | null {
  const record = recordOf(value, PLURAL_SYSTEM_COLLECTION)
  if (!record) return null
  return {
    name: optionalText(record.name, 64, 640),
    description: optionalText(record.description, 256, 2560),
    collectiveNoun: optionalText(record.collectiveNoun, 32, 320),
    memberCount: optionalText(record.memberCount, 16, 64),
    createdAt: datetime(record.createdAt),
    updatedAt: datetime(record.updatedAt),
    raw: record,
  }
}

/**
 * `app.nearhorizon.plural.member`. `null` without a `displayName` within 64
 * graphemes (and not blank). Optional fields over their limits are
 * dropped; member pronouns follow the member lexicon (at most 10 sets of at
 * most 12 forms, each at most 24 graphemes and 240 bytes; raised from 6 and
 * 6 on 2026-10-25 to match atproto-pronouns). Empty sets in older records
 * are still read, and show nothing.
 */
export function parseMember(value: unknown): PluralMember | null {
  const record = recordOf(value, PLURAL_MEMBER_COLLECTION)
  if (!record) return null
  const displayName = text(record.displayName, 64, 640)
  if (displayName === undefined || displayName.trim().length === 0) {
    return null
  }
  const color =
    typeof record.color === 'string' && COLOR.test(record.color)
      ? record.color
      : undefined
  let proxy: MemberProxy | undefined
  if (
    isObject(record.proxy) &&
    typeof record.proxy.id === 'string' &&
    isValidRecordKey(record.proxy.id)
  ) {
    const note = optionalText(record.proxy.note, 64, 640)
    proxy =
      note === undefined ? {id: record.proxy.id} : {id: record.proxy.id, note}
  }
  return {
    displayName,
    description: optionalText(record.description, 256, 2560),
    emoji: optionalText(record.emoji, 4, 16),
    color,
    pronouns:
      record.pronouns === undefined
        ? []
        : (pronounSets(record.pronouns, {
            sets: 10,
            forms: 12,
            minForms: 0,
            graphemes: 24,
            bytes: 240,
          }) ?? []),
    roles: stringList(record.roles, 10, 32, 320) ?? [],
    memberTypes: stringList(record.memberTypes, 5, 32, 320) ?? [],
    agePresentation: optionalText(record.agePresentation, 32, 320),
    proxy,
    avatar: memberImage(record.avatar),
    banner: memberImage(record.banner),
    createdAt: datetime(record.createdAt),
    updatedAt: datetime(record.updatedAt),
    raw: record,
  }
}

/**
 * `app.nearhorizon.plural.front`. `null` without a `members` array of at
 * most 20. An entry whose `id` is not a record key, or whose `status` is
 * over its limit, is dropped: an unreadable status never reads as absent,
 * which would show that member as fronting on a guess. Duplicates are
 * dropped.
 */
export function parseFront(value: unknown): PluralFront | null {
  const record = recordOf(value, PLURAL_FRONT_COLLECTION)
  if (!record) return null
  if (!Array.isArray(record.members) || record.members.length > 20) {
    return null
  }
  const members: FrontMember[] = []
  const seen = new Set<string>()
  for (const entry of record.members) {
    if (!isObject(entry)) continue
    const id = entry.id
    if (typeof id !== 'string' || !isValidRecordKey(id) || seen.has(id)) {
      continue
    }
    if (entry.status === undefined) {
      members.push({id})
    } else {
      const status = text(entry.status, 32, 320)
      if (status === undefined) continue
      members.push({id, status})
    }
    seen.add(id)
  }
  return {
    members,
    state: optionalText(record.state, 32, 320),
    comment: optionalText(record.comment, 256, 2560),
    setAt: datetime(record.setAt),
    raw: record,
  }
}

/**
 * Whether a front entry is fronting: `status` `engaging` or absent (plural
 * spec).
 */
export function isEngaging(member: FrontMember): boolean {
  return member.status === undefined || member.status === 'engaging'
}
