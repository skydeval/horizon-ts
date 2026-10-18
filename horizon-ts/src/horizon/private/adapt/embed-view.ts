/*
 * Embed views built from a private record (6.1.3), for a post prism serves
 * without an `embed` view (P-1) and for a just-written post (4.9). The stock
 * renderers take `app.bsky.embed.*#view` shapes, so the record's embed is
 * turned into one:
 *
 * - images and gallery items as `getBlob` URLs on the author's PDS, omitted
 *   when that PDS is not known;
 * - a link card as written, its thumbnail from the PDS when there is one;
 * - a quote of a private post as `#viewNotFound`, which the private quote
 *   hook resolves through prism for a reader who may view it; a quote of a
 *   public post from the public views the caller fetched, else
 *   `#viewNotFound`;
 * - a video with the video service's playlist and thumbnail for its blob,
 *   until prism serves a view (whether the service serves a video only a
 *   private record references is not verified);
 * - a quote with media from the two parts.
 *
 * A video view prism serves carries no `presentation` (P-1, its private video
 * reply); `withRecordPresentation` copies it from the record, so a GIF-style
 * video still plays as one.
 *
 * Records come from prism unchecked, so every field is read defensively and
 * an unreadable embed gives no view.
 */

import {type $Typed, getBlobCidString} from '@atproto/lex'
import {type AtUriString, type UriString} from '@atproto/syntax'

import {isPrivatePostUri} from '#/horizon/private/uri'
import {videoPlaylistUrl, videoThumbnailUrl} from '#/horizon/video/service'
import {type app} from '#/lexicons'

const POST_PUBLIC = 'tools.kryphocron.feed.postPublic'

/**
 * What building a view needs besides the record.
 */
export type EmbedViewContext = {
  /** The post's author, whose repo holds the blobs. */
  authorDid: string
  /** The author's PDS; without it images and gallery items are omitted. */
  pdsUrl?: string
  /** Public posts the record may quote, by URI. */
  quoteViews?: ReadonlyMap<string, app.bsky.feed.defs.PostView>
}

type EmbedView = NonNullable<app.bsky.feed.defs.PostView['embed']>
type MediaView = app.bsky.embed.recordWithMedia.View['media']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The CID of a blob as a string, whether the record was parsed into lex
 * values (a CID object) or kept as JSON (`{$link}`), or a legacy blob.
 */
export function blobCid(blob: unknown): string | undefined {
  if (!isObject(blob)) return undefined
  const ref = blob.ref
  if (isObject(ref) && typeof ref.$link === 'string') return ref.$link
  if (typeof blob.cid === 'string') return blob.cid
  if (ref === undefined || ref === null) return undefined
  try {
    return getBlobCidString(blob as Parameters<typeof getBlobCidString>[0])
  } catch {
    return undefined
  }
}

/**
 * The `getBlob` URL of a blob in `did`'s repo on `pdsUrl`.
 */
export function blobUrl(pdsUrl: string, did: string, cid: string): UriString {
  return `${pdsUrl.replace(/\/$/, '')}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}` as UriString
}

function aspectRatioOf(
  value: unknown,
): app.bsky.embed.defs.AspectRatio | undefined {
  if (!isObject(value)) return undefined
  const {width, height} = value
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    return undefined
  }
  return {width, height}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function imagesView(
  embed: Record<string, unknown>,
  ctx: EmbedViewContext,
): $Typed<app.bsky.embed.images.View> | undefined {
  if (!ctx.pdsUrl || !Array.isArray(embed.images)) return undefined
  const pdsUrl = ctx.pdsUrl
  const images: app.bsky.embed.images.ViewImage[] = []
  for (const image of embed.images as unknown[]) {
    if (!isObject(image)) continue
    const cid = blobCid(image.image)
    if (!cid) continue
    const url = blobUrl(pdsUrl, ctx.authorDid, cid)
    const aspectRatio = aspectRatioOf(image.aspectRatio)
    images.push({
      thumb: url,
      fullsize: url,
      alt: str(image.alt) ?? '',
      ...(aspectRatio ? {aspectRatio} : {}),
    })
  }
  return images.length
    ? {$type: 'app.bsky.embed.images#view', images}
    : undefined
}

function galleryView(
  embed: Record<string, unknown>,
  ctx: EmbedViewContext,
): $Typed<app.bsky.embed.gallery.View> | undefined {
  if (!ctx.pdsUrl || !Array.isArray(embed.items)) return undefined
  const pdsUrl = ctx.pdsUrl
  const items: $Typed<app.bsky.embed.gallery.ViewImage>[] = []
  for (const item of embed.items as unknown[]) {
    if (!isObject(item)) continue
    const cid = blobCid(item.image)
    const aspectRatio = aspectRatioOf(item.aspectRatio)
    if (!cid || !aspectRatio) continue
    const url = blobUrl(pdsUrl, ctx.authorDid, cid)
    items.push({
      $type: 'app.bsky.embed.gallery#viewImage',
      thumbnail: url,
      fullsize: url,
      alt: str(item.alt) ?? '',
      aspectRatio,
    })
  }
  return items.length
    ? {$type: 'app.bsky.embed.gallery#view', items}
    : undefined
}

function externalView(
  embed: Record<string, unknown>,
  ctx: EmbedViewContext,
): $Typed<app.bsky.embed.external.View> | undefined {
  const external = embed.external
  if (!isObject(external)) return undefined
  const uri = str(external.uri)
  if (!uri) return undefined
  const thumbCid = blobCid(external.thumb)
  return {
    $type: 'app.bsky.embed.external#view',
    external: {
      uri: uri as UriString,
      title: str(external.title) ?? '',
      description: str(external.description) ?? '',
      ...(thumbCid && ctx.pdsUrl
        ? {thumb: blobUrl(ctx.pdsUrl, ctx.authorDid, thumbCid)}
        : {}),
    },
  }
}

function videoView(
  embed: Record<string, unknown>,
  ctx: EmbedViewContext,
): $Typed<app.bsky.embed.video.View> | undefined {
  const cid = blobCid(embed.video)
  if (!cid) return undefined
  const aspectRatio = aspectRatioOf(embed.aspectRatio)
  const alt = str(embed.alt)
  const presentation = str(embed.presentation)
  return {
    $type: 'app.bsky.embed.video#view',
    cid,
    playlist: videoPlaylistUrl(ctx.authorDid, cid) as UriString,
    thumbnail: videoThumbnailUrl(ctx.authorDid, cid) as UriString,
    ...(alt ? {alt} : {}),
    ...(aspectRatio ? {aspectRatio} : {}),
    ...(presentation ? {presentation} : {}),
  }
}

/**
 * The URI a record embed quotes, or `undefined`.
 */
function quotedUri(embed: Record<string, unknown>): string | undefined {
  const ref = embed.record
  return isObject(ref) ? str(ref.uri) : undefined
}

function recordView(
  uri: string,
  ctx: EmbedViewContext,
): $Typed<app.bsky.embed.record.View> {
  const quote = isPrivatePostUri(uri) ? undefined : ctx.quoteViews?.get(uri)
  if (!quote) {
    return {
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewNotFound',
        uri: uri as AtUriString,
        notFound: true,
      },
    }
  }
  return {
    $type: 'app.bsky.embed.record#view',
    record: {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: quote.uri,
      cid: quote.cid,
      author: quote.author,
      value: quote.record,
      labels: quote.labels,
      indexedAt: quote.indexedAt,
      embeds: quote.embed ? [quote.embed] : undefined,
    },
  }
}

function mediaView(
  embed: Record<string, unknown>,
  ctx: EmbedViewContext,
): MediaView | undefined {
  switch (embed.$type) {
    case `${POST_PUBLIC}#embedImage`:
      return imagesView(embed, ctx)
    case `${POST_PUBLIC}#embedGallery`:
      return galleryView(embed, ctx)
    case `${POST_PUBLIC}#embedExternal`:
      return externalView(embed, ctx)
    case `${POST_PUBLIC}#embedVideo`:
      return videoView(embed, ctx)
    default:
      return undefined
  }
}

/**
 * The URI the record quotes (alone or with media), for the caller's public
 * quote fetch.
 */
export function recordQuoteUri(record: unknown): string | undefined {
  if (!isObject(record) || !isObject(record.embed)) return undefined
  const embed = record.embed
  if (embed.$type === `${POST_PUBLIC}#embedRecord`) return quotedUri(embed)
  if (
    embed.$type === `${POST_PUBLIC}#embedRecordWithMedia` &&
    isObject(embed.record)
  ) {
    return quotedUri(embed.record)
  }
  return undefined
}

/**
 * Whether the record's embed shows blobs from the author's PDS (images, a
 * gallery or a link thumbnail, alone or with a quote).
 */
export function recordUsesPdsBlobs(record: unknown): boolean {
  if (!isObject(record) || !isObject(record.embed)) return false
  let embed = record.embed
  if (embed.$type === `${POST_PUBLIC}#embedRecordWithMedia`) {
    if (!isObject(embed.media)) return false
    embed = embed.media
  }
  return (
    embed.$type === `${POST_PUBLIC}#embedImage` ||
    embed.$type === `${POST_PUBLIC}#embedGallery` ||
    (embed.$type === `${POST_PUBLIC}#embedExternal` &&
      isObject(embed.external) &&
      embed.external.thumb !== undefined)
  )
}

/**
 * The embed view of a private record's `embed`, or `undefined` when it has
 * none or none can be built.
 */
export function embedViewFromRecord(
  record: unknown,
  ctx: EmbedViewContext,
): EmbedView | undefined {
  if (!isObject(record) || !isObject(record.embed)) return undefined
  const embed = record.embed
  if (embed.$type === `${POST_PUBLIC}#embedRecord`) {
    const uri = quotedUri(embed)
    return uri ? recordView(uri, ctx) : undefined
  }
  if (embed.$type === `${POST_PUBLIC}#embedRecordWithMedia`) {
    const uri = isObject(embed.record) ? quotedUri(embed.record) : undefined
    if (!uri) return undefined
    const quote = recordView(uri, ctx)
    const media = isObject(embed.media)
      ? mediaView(embed.media, ctx)
      : undefined
    if (!media) return quote
    return {
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: quote,
      media,
    }
  }
  return mediaView(embed, ctx)
}

function videoPresentationOf(
  embed: Record<string, unknown>,
): string | undefined {
  return embed.$type === `${POST_PUBLIC}#embedVideo` ||
    embed.$type === 'app.bsky.embed.video'
    ? str(embed.presentation)
    : undefined
}

function withPresentation<V extends {presentation?: string}>(
  view: V,
  presentation: string | undefined,
): V {
  return presentation && !view.presentation ? {...view, presentation} : view
}

/**
 * A served embed view with the record's video `presentation` copied onto its
 * video view, top level or as the media of a quote with media, when the view
 * has none. Any other view, or a record without one, is returned as it is.
 */
export function withRecordPresentation(
  view: EmbedView,
  record: unknown,
): EmbedView {
  if (!isObject(record) || !isObject(record.embed)) return view
  const embed = record.embed
  if (view.$type === 'app.bsky.embed.video#view') {
    return withPresentation(
      view as $Typed<app.bsky.embed.video.View>,
      videoPresentationOf(embed),
    )
  }
  if (view.$type === 'app.bsky.embed.recordWithMedia#view') {
    const withMedia = view as $Typed<app.bsky.embed.recordWithMedia.View>
    const media = withMedia.media
    if (media.$type !== 'app.bsky.embed.video#view') return view
    const isWithMedia =
      embed.$type === `${POST_PUBLIC}#embedRecordWithMedia` ||
      embed.$type === 'app.bsky.embed.recordWithMedia'
    if (!isWithMedia || !isObject(embed.media)) return view
    const next = withPresentation(
      media as $Typed<app.bsky.embed.video.View>,
      videoPresentationOf(embed.media),
    )
    return next === media ? view : {...withMedia, media: next}
  }
  return view
}
