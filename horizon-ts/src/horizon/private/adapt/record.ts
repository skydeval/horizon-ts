/*
 * Converting between Bluesky's post shapes and the kryphocron private record.
 *
 * Writing: the stock `resolveRT` and `resolveEmbed` produce
 * `app.bsky.richtext.facet` and `app.bsky.embed.*`; the private record
 * carries `tools.kryphocron.feed.postPublic#facet` and its embed defs. Each
 * embed the lexicon defines is converted once its server-support constant is
 * on (video `PRIVATE_VIDEO`, gallery `PRIVATE_GALLERY`, quote with media
 * `PRIVATE_QUOTE_WITH_MEDIA`, image aspect ratio and link thumbnail
 * `PRIVATE_MEDIA_EXTRAS`). While a constant is off its field is dropped, or
 * its embed is blocked in the composer and throws here if it is ever reached.
 *
 * Reading: a private record converts back to an `app.bsky.feed.post` record,
 * which every stock renderer takes, with its languages and self-labels (K-1).
 * Until prism serves facets (P-1), links and hashtags are detected locally in
 * a record that has none (6.1.2), and so are spoilers written with their
 * markers kept (a content warning's by its shape, 2J design 4.3). Horizon's
 * spoiler and content warning features (`app.nearhorizon.richtext.facet`)
 * and its per-item media spoiler flag pass through unchanged both ways.
 */

import {type $Typed} from '@atproto/lex'
import {type DatetimeString, isValidLanguage} from '@atproto/syntax'
import {RichText} from '@bsky/sdk/richtext'

import {
  type PostPrivate,
  type PostPrivateEmbed,
  type PostPrivateFacet,
} from '#/horizon/lexicons/kryphocron'
import {CW_SELF_LABEL, isFlagged, withFlag} from '#/horizon/media-spoilers/nsid'
import {
  PRIVATE_GALLERY,
  PRIVATE_LANGS_LABELS,
  PRIVATE_MEDIA_EXTRAS,
  PRIVATE_QUOTE_WITH_MEDIA,
  PRIVATE_VIDEO,
  privateFacetsServed,
} from '#/horizon/private/server-support'
import {detectLocalContentWarningFacets} from '#/horizon/spoilers/content-warning'
import {detectLocalSpoilerFacets} from '#/horizon/spoilers/local'
import {
  CONTENT_WARNING_FEATURE,
  contentWarningFeature,
  isContentWarningFeature,
  isSpoilerFeature,
  isSpoilerMarkerFeature,
  SPOILER_FEATURE,
  SPOILER_MARKER_FEATURE,
  spoilerFeature,
  spoilerMarkerFeature,
} from '#/horizon/spoilers/nsid'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

const POST_PUBLIC = 'tools.kryphocron.feed.postPublic'

/**
 * The composer produced an embed a private post cannot carry. The composer's
 * blockers should make this unreachable.
 */
export class PrivateEmbedUnsupportedError extends Error {
  constructor(readonly embedType: string) {
    super(`A private post can't carry ${embedType}`)
    this.name = 'PrivateEmbedUnsupportedError'
  }
}

/**
 * `app.bsky.richtext.facet` to the kryphocron facet. A feature of a type the
 * lexicon does not define is dropped, and a facet left with no feature is
 * dropped with it.
 */
export function toPrivateFacets(
  facets: app.bsky.richtext.facet.Main[] | undefined,
): PostPrivateFacet[] | undefined {
  if (!facets?.length) return undefined
  const converted: PostPrivateFacet[] = []
  for (const facet of facets) {
    const features: PostPrivateFacet['features'] = []
    for (const feature of facet.features) {
      if (bsky.isType(app.bsky.richtext.facet.mention, feature)) {
        features.push({$type: `${POST_PUBLIC}#mention`, did: feature.did})
      } else if (bsky.isType(app.bsky.richtext.facet.link, feature)) {
        features.push({$type: `${POST_PUBLIC}#link`, uri: feature.uri})
      } else if (bsky.isType(app.bsky.richtext.facet.tag, feature)) {
        features.push({$type: `${POST_PUBLIC}#tag`, tag: feature.tag})
      } else if (isSpoilerFeature(feature)) {
        features.push({$type: SPOILER_FEATURE})
      } else if (isSpoilerMarkerFeature(feature)) {
        features.push({$type: SPOILER_MARKER_FEATURE})
      } else if (isContentWarningFeature(feature)) {
        features.push({$type: CONTENT_WARNING_FEATURE})
      }
    }
    if (features.length === 0) continue
    converted.push({
      $type: `${POST_PUBLIC}#facet`,
      index: {
        byteStart: facet.index.byteStart,
        byteEnd: facet.index.byteEnd,
      },
      features,
    })
  }
  return converted.length ? converted : undefined
}

/**
 * The composer's self-labels (content warnings) as the kryphocron
 * `#selfLabels` (K-1), or `undefined` when there are none or
 * `PRIVATE_LANGS_LABELS` is off.
 */
export function toPrivateSelfLabels(
  labels: readonly string[] | undefined,
): PostPrivate['labels'] | undefined {
  if (!PRIVATE_LANGS_LABELS || !labels?.length) return undefined
  return {
    $type: `${POST_PUBLIC}#selfLabels`,
    values: labels.map(val => ({val})),
  }
}

/**
 * The self-label values a private record carries, read defensively.
 */
export function privateSelfLabelValues(record: unknown): string[] {
  if (!isObject(record) || !isObject(record.labels)) return []
  const labels = record.labels
  if (labels.$type !== `${POST_PUBLIC}#selfLabels`) return []
  if (!Array.isArray(labels.values)) return []
  const values: string[] = []
  for (const value of labels.values as unknown[]) {
    if (
      isObject(value) &&
      typeof value.val === 'string' &&
      value.val.length > 0 &&
      value.val.length <= 128
    ) {
      values.push(value.val)
    }
  }
  // The lexicon's limit; more would fail the post record's lexicon.
  return values.slice(0, 10)
}

type PrivateMediaEmbed = Extract<
  PostPrivateEmbed,
  {
    $type:
      | 'tools.kryphocron.feed.postPublic#embedImage'
      | 'tools.kryphocron.feed.postPublic#embedGallery'
      | 'tools.kryphocron.feed.postPublic#embedVideo'
      | 'tools.kryphocron.feed.postPublic#embedExternal'
  }
>

type PrivateRecordEmbed = Extract<
  PostPrivateEmbed,
  {$type: 'tools.kryphocron.feed.postPublic#embedRecord'}
>

function toPrivateImages(
  embed: app.bsky.embed.images.Main,
): $Typed<PrivateMediaEmbed> {
  return {
    $type: `${POST_PUBLIC}#embedImage`,
    images: embed.images.map(image =>
      keepFlag(image, {
        image: image.image,
        alt: image.alt,
        ...(PRIVATE_MEDIA_EXTRAS && image.aspectRatio
          ? {aspectRatio: image.aspectRatio}
          : {}),
      }),
    ),
  }
}

function toPrivateExternal(
  embed: app.bsky.embed.external.Main,
): $Typed<PrivateMediaEmbed> {
  return {
    $type: `${POST_PUBLIC}#embedExternal`,
    external: {
      uri: embed.external.uri,
      title: embed.external.title,
      description: embed.external.description,
      ...(PRIVATE_MEDIA_EXTRAS && embed.external.thumb
        ? {thumb: embed.external.thumb}
        : {}),
    },
  }
}

/**
 * The stock video embed under the kryphocron name (K-6), field for field.
 * The blob is the one the video job returned, unchanged.
 */
function toPrivateVideo(
  embed: app.bsky.embed.video.Main,
): $Typed<PrivateMediaEmbed> {
  return keepFlag(embed, {
    $type: `${POST_PUBLIC}#embedVideo`,
    video: embed.video,
    ...(embed.captions?.length
      ? {
          captions: embed.captions.map(caption => ({
            lang: caption.lang,
            file: caption.file,
          })),
        }
      : {}),
    ...(embed.alt !== undefined ? {alt: embed.alt} : {}),
    ...(embed.aspectRatio ? {aspectRatio: embed.aspectRatio} : {}),
    ...(embed.presentation !== undefined
      ? {presentation: embed.presentation}
      : {}),
  })
}

/**
 * The stock gallery under the kryphocron name (K-7). Each item carries its
 * own `$type`, and `aspectRatio`, which the lexicon requires.
 */
function toPrivateGallery(
  embed: app.bsky.embed.gallery.Main,
): $Typed<PrivateMediaEmbed> {
  return {
    $type: `${POST_PUBLIC}#embedGallery`,
    items: embed.items.map(item => {
      if (!bsky.isType(app.bsky.embed.gallery.image, item)) {
        throw new PrivateEmbedUnsupportedError(String(item.$type))
      }
      return keepFlag(item, {
        $type: `${POST_PUBLIC}#galleryImage` as const,
        image: item.image,
        alt: item.alt,
        aspectRatio: item.aspectRatio,
      })
    }),
  }
}

function toPrivateMedia(
  embed: app.bsky.embed.recordWithMedia.Main['media'],
): $Typed<PrivateMediaEmbed> {
  if (bsky.isType(app.bsky.embed.images, embed)) return toPrivateImages(embed)
  if (bsky.isType(app.bsky.embed.external, embed)) {
    return toPrivateExternal(embed)
  }
  if (PRIVATE_VIDEO && bsky.isType(app.bsky.embed.video, embed)) {
    return toPrivateVideo(embed)
  }
  if (PRIVATE_GALLERY && bsky.isType(app.bsky.embed.gallery, embed)) {
    return toPrivateGallery(embed)
  }
  throw new PrivateEmbedUnsupportedError(String(embed.$type))
}

function toPrivateRecord(
  ref: app.bsky.embed.record.Main['record'],
): $Typed<PrivateRecordEmbed> {
  return {
    $type: `${POST_PUBLIC}#embedRecord`,
    record: {uri: ref.uri, cid: ref.cid},
  }
}

/**
 * `converted` with the media spoiler flag when `source` carries it.
 */
function keepFlag<T extends object>(source: unknown, converted: T): T {
  return isFlagged(source) ? withFlag(converted) : converted
}

/**
 * `resolveEmbed`'s output to the kryphocron embed. Throws
 * {@link PrivateEmbedUnsupportedError} for an embed the lexicon does not
 * define, or one whose server-support constant is off.
 */
export function toPrivateEmbed(
  embed: app.bsky.feed.post.Main['embed'],
): PostPrivateEmbed | undefined {
  if (!embed) return undefined
  if (bsky.isType(app.bsky.embed.record, embed)) {
    return toPrivateRecord(embed.record)
  }
  if (
    PRIVATE_QUOTE_WITH_MEDIA &&
    bsky.isType(app.bsky.embed.recordWithMedia, embed)
  ) {
    return {
      $type: `${POST_PUBLIC}#embedRecordWithMedia`,
      record: {record: toPrivateRecord(embed.record.record).record},
      media: toPrivateMedia(embed.media),
    }
  }
  if (bsky.isType(app.bsky.embed.recordWithMedia, embed)) {
    throw new PrivateEmbedUnsupportedError(embed.$type)
  }
  return toPrivateMedia(embed)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toBskyFacets(
  facets: PostPrivate['facets'],
): app.bsky.richtext.facet.Main[] | undefined {
  if (!facets?.length) return undefined
  const converted: app.bsky.richtext.facet.Main[] = []
  for (const facet of facets) {
    const features: app.bsky.richtext.facet.Main['features'] = []
    for (const feature of facet.features) {
      if (feature.$type === `${POST_PUBLIC}#mention`) {
        features.push({
          $type: 'app.bsky.richtext.facet#mention',
          did: feature.did,
        })
      } else if (feature.$type === `${POST_PUBLIC}#link`) {
        features.push({$type: 'app.bsky.richtext.facet#link', uri: feature.uri})
      } else if (feature.$type === `${POST_PUBLIC}#tag`) {
        features.push({$type: 'app.bsky.richtext.facet#tag', tag: feature.tag})
      } else if (isSpoilerFeature(feature)) {
        features.push(spoilerFeature())
      } else if (isSpoilerMarkerFeature(feature)) {
        features.push(spoilerMarkerFeature())
      } else if (isContentWarningFeature(feature)) {
        features.push(contentWarningFeature())
      }
    }
    if (features.length === 0) continue
    converted.push({
      index: {
        byteStart: facet.index.byteStart,
        byteEnd: facet.index.byteEnd,
      },
      features,
    })
  }
  return converted.length ? converted : undefined
}

function toBskyMedia(
  embed: unknown,
): app.bsky.embed.recordWithMedia.Main['media'] | undefined {
  if (!isObject(embed)) return undefined
  const typed = embed as PostPrivateEmbed
  if (typed.$type === `${POST_PUBLIC}#embedImage`) {
    const images: app.bsky.embed.images.Image[] = typed.images.map(image =>
      keepFlag(image, {
        image: image.image,
        alt: image.alt,
        ...(image.aspectRatio ? {aspectRatio: image.aspectRatio} : {}),
      }),
    )
    return {$type: 'app.bsky.embed.images', images}
  }
  if (typed.$type === `${POST_PUBLIC}#embedExternal`) {
    return {
      $type: 'app.bsky.embed.external',
      external: {
        uri: typed.external.uri,
        title: typed.external.title,
        description: typed.external.description,
        ...(typed.external.thumb ? {thumb: typed.external.thumb} : {}),
      },
    }
  }
  if (typed.$type === `${POST_PUBLIC}#embedVideo`) {
    return keepFlag(typed, {
      $type: 'app.bsky.embed.video' as const,
      video: typed.video,
      ...(typed.captions ? {captions: typed.captions} : {}),
      ...(typed.alt !== undefined ? {alt: typed.alt} : {}),
      ...(typed.aspectRatio ? {aspectRatio: typed.aspectRatio} : {}),
      ...(typed.presentation !== undefined
        ? {presentation: typed.presentation}
        : {}),
    })
  }
  if (typed.$type === `${POST_PUBLIC}#embedGallery`) {
    const items: $Typed<app.bsky.embed.gallery.Image>[] = []
    for (const item of typed.items) {
      if (item.$type !== `${POST_PUBLIC}#galleryImage`) continue
      items.push(
        keepFlag(item, {
          $type: 'app.bsky.embed.gallery#image' as const,
          image: item.image,
          alt: item.alt,
          aspectRatio: item.aspectRatio,
        }),
      )
    }
    return {$type: 'app.bsky.embed.gallery', items}
  }
  return undefined
}

function toBskyEmbed(
  embed: PostPrivate['embed'],
): app.bsky.feed.post.Main['embed'] {
  if (!embed) return undefined
  if (embed.$type === `${POST_PUBLIC}#embedRecord`) {
    return {
      $type: 'app.bsky.embed.record',
      record: {uri: embed.record.uri, cid: embed.record.cid},
    }
  }
  if (embed.$type === `${POST_PUBLIC}#embedRecordWithMedia`) {
    const media = toBskyMedia(embed.media)
    if (!media) return undefined
    return {
      $type: 'app.bsky.embed.recordWithMedia',
      record: {
        $type: 'app.bsky.embed.record',
        record: {
          uri: embed.record.record.uri,
          cid: embed.record.record.cid,
        },
      },
      media,
    }
  }
  return toBskyMedia(embed)
}

/**
 * Link and hashtag facets detected in `text` without any network call
 * (6.1.2). Mention features are dropped: detection without resolution puts
 * the handle where a DID belongs, which would fail the post record's
 * lexicon and drop the post. A text with `||` spoilers (written with its
 * markers kept) also gains its spoiler and marker facets.
 */
export function detectLocalFacets(
  text: string,
): app.bsky.richtext.facet.Main[] | undefined {
  const spoilers = detectLocalSpoilerFacets(text)
  if (spoilers) return spoilers
  const rt = new RichText({text})
  rt.detectFacetsWithoutResolution()
  const facets: app.bsky.richtext.facet.Main[] = []
  for (const facet of rt.facets ?? []) {
    const features: app.bsky.richtext.facet.Main['features'] = []
    for (const feature of facet.features) {
      if (bsky.isType(app.bsky.richtext.facet.link, feature)) {
        features.push({$type: 'app.bsky.richtext.facet#link', uri: feature.uri})
      } else if (bsky.isType(app.bsky.richtext.facet.tag, feature)) {
        features.push({$type: 'app.bsky.richtext.facet#tag', tag: feature.tag})
      }
    }
    if (features.length === 0) continue
    facets.push({
      index: {
        byteStart: facet.index.byteStart,
        byteEnd: facet.index.byteEnd,
      },
      features,
    })
  }
  return facets.length ? facets : undefined
}

/**
 * Local detection for a served record without facets: a record with the CW
 * self-label is split by a keep-mode CW's shape first (2J design 4.3), so no
 * `||` in its line or body pairs with the outer markers; any other text, or
 * one without that shape, takes `detectLocalFacets`. Gated on spoiler tags
 * (inside), not on content warnings, so the body stays hidden either way.
 */
function detectLocalRecordFacets(
  record: unknown,
  text: string,
): app.bsky.richtext.facet.Main[] | undefined {
  if (privateSelfLabelValues(record).includes(CW_SELF_LABEL)) {
    const facets = detectLocalContentWarningFacets(text)
    if (facets) return facets
  }
  return detectLocalFacets(text)
}

/**
 * A private record as an `app.bsky.feed.post` record: text, `createdAt`,
 * facets, reply refs and embed converted. A record without `facets` gains
 * locally detected links and hashtags while prism does not serve facets
 * (`privateFacetsServed`). Returns `undefined` when the record is not a
 * private post record or its text is not a string. A reply ref without a
 * `cid` is kept as served; the adapter fills or drops it.
 */
export function toBskyRecord(
  record: unknown,
): $Typed<app.bsky.feed.post.Main> | undefined {
  if (!isObject(record)) return undefined
  if (record.$type !== 'tools.kryphocron.feed.postPrivate') return undefined
  if (typeof record.text !== 'string') return undefined
  const typed = record as Partial<PostPrivate>
  const converted: $Typed<app.bsky.feed.post.Main> = {
    $type: 'app.bsky.feed.post',
    text: record.text,
    createdAt: (typed.createdAt ?? '') as DatetimeString,
  }
  const facets =
    typed.facets === undefined && !privateFacetsServed()
      ? detectLocalRecordFacets(record, record.text)
      : toBskyFacets(typed.facets)
  if (facets) converted.facets = facets
  const embed = toBskyEmbed(typed.embed)
  if (embed) converted.embed = embed
  if (typed.reply) {
    converted.reply = {
      root: {uri: typed.reply.root.uri, cid: typed.reply.root.cid},
      parent: {uri: typed.reply.parent.uri, cid: typed.reply.parent.cid},
    }
  }
  if (Array.isArray(record.langs)) {
    // A malformed tag would fail the post record's lexicon and drop the post.
    const langs = (record.langs as unknown[]).filter(
      (lang): lang is string =>
        typeof lang === 'string' && isValidLanguage(lang),
    )
    if (langs.length) {
      converted.langs = langs
    }
  }
  const labelValues = privateSelfLabelValues(record)
  if (labelValues.length) {
    converted.labels = {
      $type: 'com.atproto.label.defs#selfLabels',
      values: labelValues.map(val => ({val})),
    }
  }
  return converted
}
