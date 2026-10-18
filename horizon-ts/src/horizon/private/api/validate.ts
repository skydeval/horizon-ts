/*
 * Local validation of a private record before it is written. aurora checks
 * nothing about a private record's shape (dependency A-7), so a malformed
 * record would be stored as sent. This runs before every write.
 *
 * The hand-written schema checks types, formats, lengths, the embed union and
 * the blobs; this file adds what a schema does not: the key whitelist (with
 * `langs` and `labels` only once `PRIVATE_LANGS_LABELS` is on), the
 * always-present `text`, the empty-post rule, the audience URI's shape, the
 * facet byte bounds and layout (sorted, non-overlapping, spoiler facets
 * non-empty, marker facets over `||` only, the whole within prism's cap),
 * the language and self-label counts, and the embeds
 * whose server-support constant is off, which are rejected as unknown
 * embeds.
 */

import {countGraphemes} from 'unicode-segmenter/grapheme'

import {kryphocron} from '#/horizon/lexicons'
import {type PostPrivate} from '#/horizon/lexicons/kryphocron'
import {
  PRIVATE_GALLERY,
  PRIVATE_LANGS_LABELS,
  PRIVATE_QUOTE_WITH_MEDIA,
  PRIVATE_VIDEO,
} from '#/horizon/private/server-support'
import {isAudienceUri, PP_COLLECTION} from '#/horizon/private/uri'
import {isSpoilerFeature, isSpoilerMarkerFeature} from '#/horizon/spoilers/nsid'

const ALLOWED_KEYS = new Set([
  '$type',
  'text',
  'facets',
  'createdAt',
  'audienceList',
  'reply',
  'embed',
])

/**
 * Keys Horizon writes once `PRIVATE_LANGS_LABELS` is on (K-1).
 */
const LANGS_LABELS_KEYS = new Set(['langs', 'labels'])

const MAX_LANGS = 3
const MAX_SELF_LABELS = 10

const MAX_TEXT_GRAPHEMES = 300
const MAX_TEXT_BYTES = 3000
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 2_000_000
const MAX_GALLERY_ITEMS = 20
const MAX_VIDEO_BYTES = 300_000_000
const POST_PUBLIC = 'tools.kryphocron.feed.postPublic'
/**
 * prism's display-field cap (64 KiB): a larger `facets` is not stored.
 */
const MAX_FACETS_BYTES = 64 * 1024
const SPOILER_MARKER_BYTES = new Set(['||', '||\n', '\n||'])

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function utf8Slice(text: string, start: number, end: number): string {
  return decoder.decode(encoder.encode(text).slice(start, end))
}

/**
 * A private record failed local validation. Nothing was written.
 */
export class PrivatePostInvalidError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Private post is not valid at ${path}: ${detail}`)
    this.name = 'PrivatePostInvalidError'
  }
}

/**
 * The UTF-8 length of `text`, as lexicon `maxLength` and facet indices count.
 */
export function utf8Length(text: string): number {
  let length = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return length
}

function fail(path: string, detail: string): never {
  throw new PrivatePostInvalidError(path, detail)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkImageBlob(blob: unknown, path: string) {
  if (!isObject(blob)) fail(path, 'not a blob')
  if (
    typeof blob.mimeType !== 'string' ||
    !blob.mimeType.startsWith('image/')
  ) {
    fail(`${path}.mimeType`, 'not an image type')
  }
  if (typeof blob.size !== 'number' || blob.size > MAX_IMAGE_BYTES) {
    fail(`${path}.size`, `over ${MAX_IMAGE_BYTES} bytes`)
  }
}

/**
 * The rules of one media embed (or a quote), at `path`. A video or a gallery
 * is an unknown embed while its constant is off.
 */
function checkMedia(embed: Record<string, unknown>, path: string) {
  switch (embed.$type) {
    case `${POST_PUBLIC}#embedImage`: {
      if (!Array.isArray(embed.images)) return
      if (embed.images.length > MAX_IMAGES) {
        fail(`${path}.images`, `more than ${MAX_IMAGES} images`)
      }
      embed.images.forEach((image: unknown, i) => {
        const at = `${path}.images[${i}]`
        if (!isObject(image)) fail(at, 'not an object')
        if (typeof image.alt !== 'string') fail(`${at}.alt`, 'not a string')
        checkImageBlob(image.image, `${at}.image`)
      })
      return
    }
    case `${POST_PUBLIC}#embedGallery`: {
      if (!PRIVATE_GALLERY) fail(path, 'not an embed Horizon writes')
      if (!Array.isArray(embed.items)) fail(`${path}.items`, 'not an array')
      if (embed.items.length > MAX_GALLERY_ITEMS) {
        fail(`${path}.items`, `more than ${MAX_GALLERY_ITEMS} items`)
      }
      embed.items.forEach((item: unknown, i) => {
        const at = `${path}.items[${i}]`
        if (!isObject(item)) fail(at, 'not an object')
        if (item.$type !== `${POST_PUBLIC}#galleryImage`) {
          fail(`${at}.$type`, `must be ${POST_PUBLIC}#galleryImage`)
        }
        if (typeof item.alt !== 'string') fail(`${at}.alt`, 'not a string')
        if (!isObject(item.aspectRatio)) fail(`${at}.aspectRatio`, 'missing')
        checkImageBlob(item.image, `${at}.image`)
      })
      return
    }
    case `${POST_PUBLIC}#embedVideo`: {
      if (!PRIVATE_VIDEO) fail(path, 'not an embed Horizon writes')
      const blob = embed.video
      if (!isObject(blob)) fail(`${path}.video`, 'not a blob')
      if (blob.mimeType !== 'video/mp4') {
        fail(`${path}.video.mimeType`, 'not video/mp4')
      }
      if (typeof blob.size !== 'number' || blob.size > MAX_VIDEO_BYTES) {
        fail(`${path}.video.size`, `over ${MAX_VIDEO_BYTES} bytes`)
      }
      return
    }
    default:
      return
  }
}

/**
 * Validate a private record as Horizon writes it. Returns it typed; throws
 * {@link PrivatePostInvalidError} naming the field path otherwise.
 */
export function validatePrivateRecord(record: unknown): PostPrivate {
  if (!isObject(record)) fail('record', 'not an object')

  for (const key of Object.keys(record)) {
    if (ALLOWED_KEYS.has(key)) continue
    if (PRIVATE_LANGS_LABELS && LANGS_LABELS_KEYS.has(key)) continue
    fail(key, 'not a field Horizon writes')
  }

  if (record.$type !== PP_COLLECTION) fail('$type', `must be ${PP_COLLECTION}`)

  /*
   * aurora encodes the record only when `text` is present, so it is always
   * written, as "" for a post with only an embed.
   */
  if (!('text' in record)) fail('text', 'missing')
  const text = record.text
  if (typeof text !== 'string') fail('text', 'not a string')
  if (countGraphemes(text) > MAX_TEXT_GRAPHEMES) {
    fail('text', `over ${MAX_TEXT_GRAPHEMES} graphemes`)
  }
  const textBytes = utf8Length(text)
  if (textBytes > MAX_TEXT_BYTES) fail('text', `over ${MAX_TEXT_BYTES} bytes`)
  if (text.length === 0 && record.embed === undefined) {
    fail('text', 'empty, with no embed')
  }

  if (!isAudienceUri(record.audienceList as string | undefined)) {
    fail('audienceList', 'not the at-uri of an audience record')
  }

  const embed = record.embed
  if (embed !== undefined) {
    if (!isObject(embed)) fail('embed', 'not an object')
    if (embed.$type === `${POST_PUBLIC}#embedRecordWithMedia`) {
      if (!PRIVATE_QUOTE_WITH_MEDIA)
        fail('embed', 'not an embed Horizon writes')
      if (!isObject(embed.media)) fail('embed.media', 'not an object')
      checkMedia(embed.media, 'embed.media')
    } else {
      checkMedia(embed, 'embed')
    }
  }

  if (record.facets !== undefined) {
    if (!Array.isArray(record.facets)) fail('facets', 'not an array')
    let previousEnd = 0
    record.facets.forEach((facet: unknown, i) => {
      const path = `facets[${i}].index`
      if (!isObject(facet) || !isObject(facet.index)) fail(path, 'missing')
      const {byteStart, byteEnd} = facet.index
      if (
        typeof byteStart !== 'number' ||
        typeof byteEnd !== 'number' ||
        !Number.isInteger(byteStart) ||
        !Number.isInteger(byteEnd)
      ) {
        fail(path, 'not integer bounds')
      }
      if (byteStart < 0 || byteEnd < 0) fail(path, 'negative')
      if (byteEnd < byteStart) fail(path, 'ends before it starts')
      if (byteEnd > textBytes) fail(path, 'past the end of the text')
      // Spoilers design 5.6: the facet layout's invariants, checked.
      if (byteStart < previousEnd) fail(path, 'overlaps the facet before it')
      previousEnd = byteEnd
      const features = Array.isArray(facet.features) ? facet.features : []
      const isSpoiler = features.some(
        f => isSpoilerFeature(f) || isSpoilerMarkerFeature(f),
      )
      if (isSpoiler && byteStart >= byteEnd) fail(path, 'empty spoiler')
      if (
        features.some(isSpoilerMarkerFeature) &&
        !SPOILER_MARKER_BYTES.has(utf8Slice(text, byteStart, byteEnd))
      ) {
        fail(path, 'a spoiler marker over other text')
      }
    })
    // prism drops a `facets` field over its display-field cap whole.
    if (utf8Length(JSON.stringify(record.facets)) > MAX_FACETS_BYTES) {
      fail('facets', 'Too many or too long links')
    }
  }

  if (record.langs !== undefined) {
    if (!Array.isArray(record.langs)) fail('langs', 'not an array')
    if (record.langs.length > MAX_LANGS) {
      fail('langs', `more than ${MAX_LANGS} languages`)
    }
  }

  if (record.labels !== undefined) {
    const labels = record.labels
    if (!isObject(labels) || labels.$type !== `${POST_PUBLIC}#selfLabels`) {
      fail('labels', `must be ${POST_PUBLIC}#selfLabels`)
    }
    if (!Array.isArray(labels.values)) fail('labels.values', 'not an array')
    if (labels.values.length > MAX_SELF_LABELS) {
      fail('labels.values', `more than ${MAX_SELF_LABELS} labels`)
    }
  }

  const result = kryphocron.postPrivate.safeValidate(record)
  if (!result.success) {
    const issue = result.issues[0]
    const path = issue?.path.length ? issue.path.join('.') : 'record'
    fail(path, issue?.message ?? result.message)
  }
  return result.value
}
