/*
 * Writing one's own profileAlt record (spec, "Writing"), after the profile
 * record so the new images' CIDs are known:
 *
 * - each slot names the image it describes by the CID now in the profile;
 *   a slot with no text, or for an image that is gone, is left out (a
 *   description is never empty);
 * - keys Horizon does not know are kept; a record left with no slots and
 *   nothing else is deleted (the same thing to readers);
 * - writes swap on the CID last read, so a change made elsewhere is not
 *   overwritten.
 */

import {
  type Client,
  jsonToLex,
  type JsonValue,
  type LexMap,
  lexToJson,
  XrpcResponseError,
} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {type QueryClient} from '@tanstack/react-query'

import {IdentityWriteConflictError} from '#/horizon/identity/writes'
import {PROFILE_ALT_COLLECTION} from '#/horizon/lexicons/nearhorizon'
import {
  altFits,
  type ImageAlt,
  parseProfileAlt,
  PROFILE_IMAGE_SLOTS,
  type ProfileImageSlot,
} from '#/horizon/profile-alt/parse'
import {
  type ProfileAltAnswer,
  profileAltQueryKey,
} from '#/horizon/profile-alt/query'
import {com} from '#/lexicons'

const SELF = 'self'
const PROFILE_COLLECTION = 'app.bsky.actor.profile'

/** The account written as. */
export type ProfileAltWriter = {
  did: string
  pdsClient: Client
  queryClient: QueryClient
}

/** The text in each slot's field ('' for none). */
export type ProfileAltTexts = Record<ProfileImageSlot, string>

/** The CID of each image the profile has now. */
export type ProfileImageCids = Partial<Record<ProfileImageSlot, string>>

/** A description over the lexicon's limits; nothing was written. */
export class ProfileAltTooLongError extends Error {
  constructor() {
    super('An image description is too long')
    this.name = 'ProfileAltTooLongError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof XrpcResponseError &&
    (error.error === 'InvalidSwap' || error.error === 'RecordNotFound')
  )
}

/** The slots to write: text trimmed, empty or imageless slots left out. */
export function nextSlots(
  texts: ProfileAltTexts,
  cids: ProfileImageCids,
): Partial<Record<ProfileImageSlot, ImageAlt>> {
  const slots: Partial<Record<ProfileImageSlot, ImageAlt>> = {}
  for (const slot of PROFILE_IMAGE_SLOTS) {
    const alt = texts[slot].trim()
    const image = cids[slot]
    if (alt && image) slots[slot] = {image, alt}
  }
  return slots
}

/**
 * The record to write over `previousRaw`, or `null` when it would hold
 * nothing (delete it, or write nothing when there is none).
 */
export function buildProfileAltRecord(
  previousRaw: Record<string, unknown>,
  slots: Partial<Record<ProfileImageSlot, ImageAlt>>,
  now: string,
): Record<string, unknown> | null {
  const record: Record<string, unknown> = {...previousRaw}
  delete record.$type
  delete record.updatedAt
  for (const slot of PROFILE_IMAGE_SLOTS) {
    const entry = slots[slot]
    if (entry) record[slot] = {image: entry.image, alt: entry.alt}
    else delete record[slot]
  }
  if (Object.keys(record).length === 0) return null
  return {$type: PROFILE_ALT_COLLECTION, ...record, updatedAt: now}
}

/** Whether two sets of slots say the same thing. */
export function sameSlots(
  a: Partial<Record<ProfileImageSlot, ImageAlt>>,
  b: Partial<Record<ProfileImageSlot, ImageAlt>>,
): boolean {
  return PROFILE_IMAGE_SLOTS.every(slot => {
    const x = a[slot]
    const y = b[slot]
    if (!x || !y) return !x && !y
    return x.image === y.image && x.alt === y.alt
  })
}

/** A blob's CID in JSON form: `ref.$link`, or a legacy blob's `cid`. */
function blobCid(value: unknown): string | undefined {
  if (!isObject(value)) return undefined
  if (isObject(value.ref) && typeof value.ref.$link === 'string') {
    return value.ref.$link
  }
  return typeof value.cid === 'string' ? value.cid : undefined
}

/** The avatar and banner CIDs in one's own profile record, as saved. */
export async function readOwnProfileImageCids(
  w: ProfileAltWriter,
): Promise<ProfileImageCids> {
  try {
    const res = await w.pdsClient.call(com.atproto.repo.getRecord, {
      repo: w.did as DidString,
      collection: PROFILE_COLLECTION,
      rkey: SELF,
    })
    const value = lexToJson(res.value)
    if (!isObject(value)) return {}
    const cids: ProfileImageCids = {}
    const avatar = blobCid(value.avatar)
    const banner = blobCid(value.banner)
    if (avatar) cids.avatar = avatar
    if (banner) cids.banner = banner
    return cids
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return {}
    }
    throw error
  }
}

/**
 * Save the descriptions in `texts` for the images in `cids`, over the
 * record read (`previous`). Writes nothing when the slots would not change.
 * A record changed elsewhere since it was read is
 * {@link IdentityWriteConflictError}.
 */
export async function saveProfileAlt(
  w: ProfileAltWriter,
  previous: ProfileAltAnswer,
  texts: ProfileAltTexts,
  cids: ProfileImageCids,
): Promise<void> {
  const slots = nextSlots(texts, cids)
  for (const slot of PROFILE_IMAGE_SLOTS) {
    const entry = slots[slot]
    if (entry && !altFits(entry.alt)) throw new ProfileAltTooLongError()
  }
  const before = previous.record
  if (before && sameSlots(slots, before)) return
  if (!before && Object.keys(slots).length === 0) return

  const record = buildProfileAltRecord(
    before?.raw ?? {},
    slots,
    new Date().toISOString(),
  )
  const key = profileAltQueryKey(w.did)
  const swap = previous.cid ?? null
  try {
    if (record) {
      const res = await w.pdsClient.call(com.atproto.repo.putRecord, {
        repo: w.did as DidString,
        collection: PROFILE_ALT_COLLECTION,
        rkey: SELF,
        record: jsonToLex(record as JsonValue) as LexMap,
        swapRecord: swap,
      })
      const next: ProfileAltAnswer = {
        record: parseProfileAlt(record),
        cid: res.cid,
      }
      w.queryClient.setQueryData(key, next)
    } else if (before) {
      await w.pdsClient.call(com.atproto.repo.deleteRecord, {
        repo: w.did as DidString,
        collection: PROFILE_ALT_COLLECTION,
        rkey: SELF,
        ...(swap ? {swapRecord: swap} : {}),
      })
      const next: ProfileAltAnswer = {record: null}
      w.queryClient.setQueryData(key, next)
    }
  } catch (error) {
    if (isConflict(error)) {
      void w.queryClient.invalidateQueries({queryKey: key})
      throw new IdentityWriteConflictError()
    }
    throw error
  }
}
