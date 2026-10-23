/*
 * The appearance record's PDS calls (Phase 3 design, 6.4 and 6.5; storage
 * choice design 5.2, 5.3 and 7.3), with no state: a read as a
 * `RecordAnswer`, a put and a delete, each for the account's own DID.
 *
 * `swapRecord` (AS7-N1): a non-member's create sends `null` (on the
 * reference PDS, "only if there is no record"); a non-member's edit and
 * delete send the CID last read; a member's record step leaves the field
 * out (no swap on every PDS).
 */

import {type Client, type LexMap, XrpcResponseError} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'

import {
  type BuiltAppearanceRecord,
  parseAppearanceRecord,
} from '#/horizon/appearance/record'
import {type RecordAnswer} from '#/horizon/appearance/resolve'
import {
  APPEARANCE_COLLECTION,
  APPEARANCE_RKEY,
} from '#/horizon/lexicons/appearance'
import {com} from '#/lexicons'

/**
 * Read `did`'s record. Undefined when the read failed, or answered without
 * a CID (a write could not be swapped safely): the read is unanswered.
 */
export async function readAppearanceRecord(
  client: Client,
  did: string,
): Promise<RecordAnswer | undefined> {
  try {
    const res = await client.call(com.atproto.repo.getRecord, {
      repo: did as DidString,
      collection: APPEARANCE_COLLECTION,
      rkey: APPEARANCE_RKEY,
    })
    if (!res.cid) return undefined
    const parsed = parseAppearanceRecord(res.value)
    // A value of another collection's `$type` reads as no record.
    return parsed
      ? {
          kind: 'record',
          appearance: parsed.appearance,
          raw: parsed.raw,
          cid: res.cid,
        }
      : {kind: 'none'}
  } catch (error) {
    if (isRecordNotFound(error)) return {kind: 'none'}
    return undefined
  }
}

/**
 * Put `record`. `swap`: a CID, `null` (a create), or `undefined` (the field
 * left out, no swap). Returns the new CID; throws on failure.
 */
export async function putAppearanceRecord(
  client: Client,
  did: string,
  record: BuiltAppearanceRecord,
  swap: string | null | undefined,
): Promise<string> {
  const res = await client.call(com.atproto.repo.putRecord, {
    repo: did as DidString,
    collection: APPEARANCE_COLLECTION,
    rkey: APPEARANCE_RKEY,
    // Horizon's fields plus values kept as read (lex values).
    record: record as LexMap,
    ...(swap === undefined ? {} : {swapRecord: swap}),
  })
  return res.cid
}

/**
 * Delete the record, swapped on `swap` when given. `RecordNotFound` counts
 * as done. Throws on any other failure.
 */
export async function deleteAppearanceRecord(
  client: Client,
  did: string,
  swap?: string,
): Promise<void> {
  try {
    await client.call(com.atproto.repo.deleteRecord, {
      repo: did as DidString,
      collection: APPEARANCE_COLLECTION,
      rkey: APPEARANCE_RKEY,
      ...(swap === undefined ? {} : {swapRecord: swap}),
    })
  } catch (error) {
    if (isRecordNotFound(error)) return
    throw error
  }
}

export function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof XrpcResponseError && error.error === 'RecordNotFound'
  )
}

/** A failure that says nothing yet: retry on the next trigger. */
export function isTransientPdsError(error: unknown): boolean {
  if (!(error instanceof XrpcResponseError)) return true
  const status = error.status
  return status === 401 || status === 429 || status >= 500
}

/** The swap did not match: the record changed since it was read. */
export function isPdsSwapFailure(error: unknown): boolean {
  return (
    error instanceof XrpcResponseError &&
    (error.error === 'InvalidSwap' || error.status === 404)
  )
}

/** The record value to mirror: prism's value exactly as it answered it. */
export function mirrorValue(
  raw: Record<string, unknown>,
): BuiltAppearanceRecord {
  return {...raw, $type: APPEARANCE_COLLECTION} as BuiltAppearanceRecord
}
