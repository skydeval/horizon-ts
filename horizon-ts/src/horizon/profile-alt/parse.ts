/*
 * Profile image descriptions (spec atproto-profile-alt): parsing `app.nearhorizon.actor.profileAlt` and
 * matching a slot to the image on screen.
 *
 * A slot describes one image by its blob CID. It is shown only while that
 * CID is the image shown, by an exact string compare (spec, "Matching"), so
 * an image changed in any client is never described by its old text. A
 * slot that breaks the lexicon is dropped on its own; the other one stands.
 */

import {countGraphemes} from 'unicode-segmenter/grapheme'

import {PROFILE_ALT_COLLECTION} from '#/horizon/lexicons/nearhorizon'

/** The two images a profile has. */
export type ProfileImageSlot = 'avatar' | 'banner'

export const PROFILE_IMAGE_SLOTS: readonly ProfileImageSlot[] = [
  'avatar',
  'banner',
]

/** The lexicon's limits on `alt`. */
export const PROFILE_ALT_MAX_GRAPHEMES = 2000
export const PROFILE_ALT_MAX_BYTES = 20000

/** One slot: the CID of the image it describes, and the description. */
export type ImageAlt = {image: string; alt: string}

/** A parsed record: its valid slots, and the record as read (JSON form). */
export type ProfileAlt = {
  avatar?: ImageAlt
  banner?: ImageAlt
  raw: Record<string, unknown>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `alt` fits the lexicon: not empty, within both limits. */
export function altFits(alt: string): boolean {
  return (
    alt.length > 0 &&
    new TextEncoder().encode(alt).length <= PROFILE_ALT_MAX_BYTES &&
    countGraphemes(alt) <= PROFILE_ALT_MAX_GRAPHEMES
  )
}

function imageAlt(value: unknown): ImageAlt | undefined {
  if (!isObject(value)) return undefined
  const {image, alt} = value
  if (typeof image !== 'string' || image.length === 0) return undefined
  // Whitespace alone is no description (spec, "Reading")
  if (typeof alt !== 'string' || !altFits(alt) || !alt.trim()) return undefined
  return {image, alt}
}

/**
 * The record, or `null` for anything that is not an object of the
 * collection. Slots that do not parse are left out.
 */
export function parseProfileAlt(value: unknown): ProfileAlt | null {
  if (!isObject(value)) return null
  if (value.$type !== undefined && value.$type !== PROFILE_ALT_COLLECTION) {
    return null
  }
  const parsed: ProfileAlt = {raw: value}
  const avatar = imageAlt(value.avatar)
  const banner = imageAlt(value.banner)
  if (avatar) parsed.avatar = avatar
  if (banner) parsed.banner = banner
  return parsed
}

/*
 * A CID string as it appears in a URL: base32 (`b...`) or base58btc
 * (`Qm...`), letters and digits only.
 */
const CID_PATTERN = /^[A-Za-z0-9]{32,}$/

/**
 * The blob CID an image URL names: Bluesky's CDN
 * (`/img/<preset>/plain/<did>/<cid>@<ext>`) or a `getBlob` URL (`?cid=`).
 * `undefined` for any other URL.
 */
export function cidOfImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const query = parsed.searchParams.get('cid')
  if (query) return CID_PATTERN.test(query) ? query : undefined
  const parts = parsed.pathname.split('/')
  if (parts.length < 2 || parts[parts.length - 3] !== 'plain') return undefined
  const last = parts[parts.length - 1].split('@')[0]
  return CID_PATTERN.test(last) ? last : undefined
}

/**
 * The description of the image at `url` in `slot`, when the record has one
 * for that very image.
 */
export function altForImage(
  record: ProfileAlt | null | undefined,
  slot: ProfileImageSlot,
  url: string | undefined,
): string | undefined {
  const entry = record?.[slot]
  if (!entry) return undefined
  const cid = cidOfImageUrl(url)
  return cid !== undefined && cid === entry.image ? entry.alt : undefined
}
