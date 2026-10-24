/*
 * The record the encode route writes (2K design 4.1, PA-10): Horizon's clear
 * structural fields plus the client encoder's fields, verbatim. Horizon never
 * adds, drops or edits a field the encoder returns; prism re-derives the
 * derived ones at read and treats an over-claim as a miss for every reader
 * but the author.
 *
 * `text`, `facets` and `embed` are never in the record: they are inside
 * `encodedContent`. An encoding decodes only at its own DID, collection and
 * rkey (PA-21), so the record and its rkey travel together from the encode to
 * the write, and the encoded bytes are never reused for another rkey or
 * attempt.
 */

import {type LexMap} from '@atproto/lex'

import {
  type PostPrivate,
  PRIVATE_ENCODED_FIELD_KEYS,
} from '#/horizon/lexicons/kryphocron'
import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'
import {type EncodedFields} from '#/horizon/private/encoder'
import {PP_COLLECTION} from '#/horizon/private/uri'

/**
 * The seven keys the encoder owns. A rewrite replaces exactly these.
 */
export const ENCODER_OWNED_KEYS: readonly string[] = PRIVATE_ENCODED_FIELD_KEYS

/**
 * The clear fields Horizon writes on a create. `reply` is added at the write
 * for a thread's later posts, whose parent CID is known only then.
 */
export type EncodedRecordClearFields = {
  createdAt: string
  audienceList: string
  reply?: PostPrivate['reply']
  langs?: PostPrivate['langs']
  labels?: PostPrivate['labels']
  /**
   * The post's fronters (`app.nearhorizon.plural.fronters`), in the clear as
   * locus leaves them (Phase 5 PP-7, B-11); never inside `encodedContent`.
   */
  fronters?: LexMap[string]
}

/**
 * The encoder's input from a composed (plaintext) record: its `text`, and
 * `facets` and `embed` only when it has them.
 */
export function encoderContentOf(record: PostPrivate): {
  text: string
  facets?: PostPrivate['facets']
  embed?: PostPrivate['embed']
} {
  return {
    text: record.text,
    ...(record.facets !== undefined ? {facets: record.facets} : {}),
    ...(record.embed !== undefined ? {embed: record.embed} : {}),
  }
}

/**
 * The record a create writes: `$type`, Horizon's clear fields (absent ones
 * left out) and the encoder's fields as returned.
 */
export function assembleEncodedRecord(
  clear: EncodedRecordClearFields,
  fields: EncodedFields,
): LexMap {
  return {
    $type: PP_COLLECTION,
    createdAt: clear.createdAt,
    audienceList: clear.audienceList,
    ...(clear.reply ? {reply: clear.reply} : {}),
    ...(clear.langs ? {langs: clear.langs} : {}),
    ...(clear.labels ? {labels: clear.labels} : {}),
    ...(clear.fronters !== undefined
      ? {[PLURAL_FRONTERS_KEY]: clear.fronters}
      : {}),
    ...fields,
  }
}

/**
 * The record a rewrite writes (a change of audience, rotation): the stored
 * record with the encoder's seven keys replaced by `fields` (a key the new
 * encoding does not carry is dropped), and `audienceList` set when given.
 * Every other key is kept exactly as stored.
 */
export function rewriteEncodedRecord(
  stored: Record<string, unknown>,
  fields: EncodedFields,
  changes: {audienceList?: string} = {},
): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(stored).filter(([key]) => !ENCODER_OWNED_KEYS.includes(key)),
  )
  return {
    ...kept,
    ...(changes.audienceList ? {audienceList: changes.audienceList} : {}),
    ...fields,
  }
}
