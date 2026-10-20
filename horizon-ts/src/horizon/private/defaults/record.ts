/*
 * The private posting defaults and their record,
 * `app.nearhorizon.actor.postingDefaults/self` (schema in
 * `lexicons/posting-defaults.ts`). Reads are lenient, field by field; a write
 * replaces `private` and keeps every other field as read, so a newer
 * client's fields survive an older client's write.
 *
 * A default audience is never widened by a bad value: an audience that is
 * present but does not parse (an unknown mode, a list URI that is not one of
 * the owner's own audience records) reads as Only me. An absent one stays
 * absent (none chosen): a new post made Private then uses Everyone, the
 * composer's own default, and a quote of a private post uses Followers
 * (round 2 list, item 6).
 */

import {AtUri, type AtUriString} from '@atproto/syntax'

import {
  POSTING_DEFAULTS_COLLECTION,
  type PostingDefaultsRecord,
  type PrivateDefaultsRecord,
} from '#/horizon/lexicons/posting-defaults'
import {type StandingMode} from '#/horizon/private/api/audiences'
import {AUDIENCE_COLLECTION} from '#/horizon/private/uri'

/**
 * The audience a private compose starts with: a standing mode, or one of the
 * account's list audiences (the composer's `ComposeAudience` without
 * `parent`).
 */
export type DefaultAudience =
  {kind: 'mode'; mode: StandingMode} | {kind: 'list'; uri: string}

/**
 * How a new post starts in the composer, for a member.
 */
export type PrivateDefaults = {
  /** "New posts start as". */
  startAs: 'public' | 'private'
  /** "Default audience"; absent while the account has chosen none. */
  audience?: DefaultAudience
}

export const DEFAULT_PRIVATE_DEFAULTS: PrivateDefaults = {startAs: 'public'}

/** The audience a new post made Private uses while none is chosen. */
export const UNSET_AUDIENCE: DefaultAudience = {kind: 'mode', mode: 'everyone'}

/** The audience a quote of a private post starts with while none is chosen. */
export const UNSET_QUOTE_AUDIENCE: DefaultAudience = {
  kind: 'mode',
  mode: 'followers',
}

const ONLY_ME: DefaultAudience = {kind: 'mode', mode: 'nobody'}

const STANDING_MODES: readonly string[] = [
  'everyone',
  'followers',
  'following',
  'nobody',
]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether `uri` names an audience record in `ownerDid`'s own repo.
 */
export function isOwnAudienceUri(uri: unknown, ownerDid: string): boolean {
  if (typeof uri !== 'string' || !uri.startsWith('at://')) return false
  try {
    const parsed = new AtUri(uri)
    return (
      parsed.host === ownerDid &&
      parsed.collection === AUDIENCE_COLLECTION &&
      parsed.rkey.length > 0
    )
  } catch {
    return false
  }
}

/** A record's `#audience`, as read for `ownerDid`; undefined when absent. */
export function parseDefaultAudience(
  value: unknown,
  ownerDid: string,
): DefaultAudience | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || typeof value.mode !== 'string') return ONLY_ME
  if (value.mode === 'list') {
    return isOwnAudienceUri(value.list, ownerDid)
      ? {kind: 'list', uri: value.list as string}
      : ONLY_ME
  }
  if (STANDING_MODES.includes(value.mode)) {
    return {kind: 'mode', mode: value.mode as StandingMode}
  }
  return ONLY_ME
}

/** A record's `#privateDefaults`, as read for `ownerDid`. */
export function parsePrivateDefaults(
  value: unknown,
  ownerDid: string,
): PrivateDefaults {
  if (!isObject(value)) return DEFAULT_PRIVATE_DEFAULTS
  const audience = parseDefaultAudience(value.audience, ownerDid)
  return {
    startAs: value.startAs === 'private' ? 'private' : 'public',
    ...(audience ? {audience} : {}),
  }
}

/**
 * Parse a record value read from `ownerDid`'s repo. Null when it is not an
 * object or its `$type` is another collection's (treated as no record).
 * `raw` is a shallow copy without `$type`, kept for writing back.
 */
export function parsePostingDefaultsRecord(
  value: unknown,
  ownerDid: string,
): {defaults: PrivateDefaults; raw: Record<string, unknown>} | null {
  if (!isObject(value)) return null
  if (
    value.$type !== undefined &&
    value.$type !== POSTING_DEFAULTS_COLLECTION
  ) {
    return null
  }
  const {$type: _type, ...raw} = value
  return {defaults: parsePrivateDefaults(value.private, ownerDid), raw}
}

/** A default audience as the record's `#audience`. */
export function audienceRecord(
  audience: DefaultAudience,
): NonNullable<PrivateDefaultsRecord['audience']> {
  return audience.kind === 'list'
    ? {mode: 'list', list: audience.uri as AtUriString}
    : {mode: audience.mode}
}

/** The written record: the stock shape plus any fields kept from `raw`. */
export type BuiltPostingDefaultsRecord = PostingDefaultsRecord &
  Record<string, unknown>

/**
 * The record to put: `raw` (the record as read, or null when there is none)
 * with `private` replaced by `defaults`. Fields of `private` this client does
 * not know are kept. No audience chosen writes none, so it stays unchosen.
 */
export function buildPostingDefaultsRecord(
  raw: Record<string, unknown> | null,
  defaults: PrivateDefaults,
  now: Date,
): BuiltPostingDefaultsRecord {
  const base: Record<string, unknown> = raw ? {...raw} : {}
  const readPrivate = isObject(base.private) ? base.private : {}
  const {audience: _readAudience, ...readRest} = readPrivate
  base.private = {
    ...readRest,
    startAs: defaults.startAs,
    ...(defaults.audience ? {audience: audienceRecord(defaults.audience)} : {}),
  }
  const version =
    raw && typeof raw.version === 'number' && Number.isInteger(raw.version)
      ? Math.max(1, raw.version)
      : 1
  return {
    ...base,
    $type: POSTING_DEFAULTS_COLLECTION,
    version,
    updatedAt: now.toISOString() as PostingDefaultsRecord['updatedAt'],
  }
}
