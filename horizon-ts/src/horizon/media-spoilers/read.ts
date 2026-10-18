/*
 * Reading media spoilers (2J design, 6.1, 6.13). Views are built field by
 * field by every server, so the flag is never in `post.embed`: it is read
 * from the record's media object and paired with the view's items by index.
 * Wherever the record and the view do not pair, every item is flagged when
 * any record item is (fail closed).
 *
 * Records are read with plain object checks, never through the post schema,
 * so a record that fails an unrelated rule still has its flags read.
 */

import {IS_WEB} from '#/env'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {isContentWarningRecord, isFlagged} from './nsid'
import {contentWarningsOn, mediaSpoilersOn} from './switches-read'

/**
 * The blur of a covered item (MS-13): a CSS blur in pixels on web, a native
 * radius on iOS and Android.
 */
export const MEDIA_SPOILER_BLUR_RADIUS = IS_WEB ? 40 : 100

type MediaKind = 'images' | 'gallery' | 'video'

/**
 * One media view, as `parseEmbed` gives it to the image and video embeds.
 */
export type MediaView =
  | app.bsky.embed.images.View
  | app.bsky.embed.gallery.View
  | app.bsky.embed.video.View

export type MediaSpoilerState = {
  /** Per view item, in the order the cells receive them. */
  flags: boolean[]
  /** The post is a CW post: its pills read "Content warning". */
  contentWarning: boolean
}

const RECORD_KINDS: Record<string, MediaKind> = {
  'app.bsky.embed.images': 'images',
  'app.bsky.embed.gallery': 'gallery',
  'app.bsky.embed.video': 'video',
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The record's media object: its embed, or the media of a quote with media.
 */
function recordMedia(record: unknown): Record<string, unknown> | undefined {
  if (!isObject(record) || !isObject(record.embed)) return undefined
  const embed = record.embed
  if (embed.$type === 'app.bsky.embed.recordWithMedia') {
    return isObject(embed.media) ? embed.media : undefined
  }
  return embed
}

/**
 * The record's media items and their kind, if it has images, a gallery or a
 * video.
 */
function recordItems(
  record: unknown,
): {kind: MediaKind; items: unknown[]} | undefined {
  const media = recordMedia(record)
  if (!media || typeof media.$type !== 'string') return undefined
  const kind = RECORD_KINDS[media.$type]
  switch (kind) {
    case 'images':
      return Array.isArray(media.images)
        ? {kind, items: media.images as unknown[]}
        : undefined
    case 'gallery':
      return Array.isArray(media.items)
        ? {kind, items: media.items as unknown[]}
        : undefined
    case 'video':
      return {kind, items: [media]}
    default:
      return undefined
  }
}

function viewKind(view: MediaView): MediaKind | undefined {
  if (bsky.isType(app.bsky.embed.images.view, view)) return 'images'
  if (bsky.isType(app.bsky.embed.gallery.view, view)) return 'gallery'
  if (bsky.isType(app.bsky.embed.video.view, view)) return 'video'
  return undefined
}

/**
 * The view's items before filtering, and which of them the cells receive (a
 * gallery's image items, as `ImageEmbed` filters them).
 */
function viewItems(view: MediaView): {all: unknown[]; shown: boolean[]} {
  if (bsky.isType(app.bsky.embed.images.view, view)) {
    return {all: view.images, shown: view.images.map(() => true)}
  }
  if (bsky.isType(app.bsky.embed.gallery.view, view)) {
    return {
      all: view.items,
      shown: view.items.map(item =>
        bsky.isType(app.bsky.embed.gallery.viewImage, item),
      ),
    }
  }
  return {all: [view], shown: [true]}
}

/**
 * The flags of one media view's items, in the cells' order, and whether the
 * post is a CW post (6.1).
 */
export function mediaSpoilerState(
  record: unknown,
  view: MediaView,
): MediaSpoilerState {
  const {all, shown} = viewItems(view)
  const count = shown.filter(Boolean).length
  if (!mediaSpoilersOn()) {
    return {flags: new Array<boolean>(count).fill(false), contentWarning: false}
  }
  const contentWarning = contentWarningsOn() && isContentWarningRecord(record)
  const items = recordItems(record)
  const recordFlags = items ? items.items.map(isFlagged) : []
  const paired =
    !!items &&
    items.kind === viewKind(view) &&
    items.items.length === all.length
  const any = contentWarning || recordFlags.some(Boolean)
  const flags = all
    .map((_, i) => (paired ? contentWarning || recordFlags[i] : any))
    .filter((_, i) => shown[i])
  return {flags, contentWarning}
}

/**
 * The key a reveal is kept under for each item, in the cells' order: an
 * image's thumbnail, a video's thumbnail or else its playlist. Keyed so, a
 * reveal stays on its image when the view is rebuilt in another order.
 */
export function mediaItemKeys(view: MediaView): string[] {
  if (bsky.isType(app.bsky.embed.images.view, view)) {
    return view.images.map(image => image.thumb)
  }
  if (bsky.isType(app.bsky.embed.gallery.view, view)) {
    return view.items.flatMap(item =>
      bsky.isType(app.bsky.embed.gallery.viewImage, item)
        ? [item.thumbnail]
        : [],
    )
  }
  if (bsky.isType(app.bsky.embed.video.view, view)) {
    return [view.thumbnail ?? view.playlist]
  }
  return []
}

/**
 * Per item, whether it may be shown: not flagged, or revealed.
 */
export function shownFlags(
  flags: readonly boolean[],
  keys: readonly string[],
  revealed: ReadonlySet<string>,
): boolean[] {
  return flags.map((flag, i) => !flag || revealed.has(keys[i]))
}

/**
 * The view (a post's `embed`) has images, a gallery or a video, top level or
 * in a quote with media.
 */
function viewHasMedia(embed: unknown): boolean {
  const media = bsky.isType(app.bsky.embed.recordWithMedia.view, embed)
    ? embed.media
    : embed
  return (
    bsky.isType(app.bsky.embed.images.view, media) ||
    bsky.isType(app.bsky.embed.gallery.view, media) ||
    bsky.isType(app.bsky.embed.video.view, media)
  )
}

/**
 * The record has a flagged media item, or is a CW post with media.
 */
export function recordHasMediaSpoilers(record: unknown): boolean {
  return hasMediaSpoilers({record})
}

/**
 * The post has spoiler media, or is a CW post with images or a video, so a
 * compact surface blurs all its thumbnails (6.13, MS-9). With
 * `CONTENT_WARNINGS` off a CW post's media are still covered by the flags
 * its writer added.
 */
export function hasMediaSpoilers(post: {
  record: unknown
  embed?: unknown
}): boolean {
  if (!mediaSpoilersOn()) return false
  const items = recordItems(post.record)
  if (items?.items.some(isFlagged)) return true
  return (
    contentWarningsOn() &&
    isContentWarningRecord(post.record) &&
    (!!items || viewHasMedia(post.embed))
  )
}

/**
 * The blur of a video card's thumbnail (6.13).
 */
export function mediaSpoilerCardBlur(post: {
  record: unknown
  embed?: unknown
}): number {
  return hasMediaSpoilers(post) ? MEDIA_SPOILER_BLUR_RADIUS : 0
}

/**
 * The post is a CW post, for the wording of a pill.
 */
export function readsAsContentWarning(record: unknown): boolean {
  return (
    mediaSpoilersOn() && contentWarningsOn() && isContentWarningRecord(record)
  )
}
