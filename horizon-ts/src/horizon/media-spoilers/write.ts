/*
 * Publishing media spoilers and content warnings (2J design, 4.2 to 4.6):
 * the flags added to `resolveEmbed`'s result, the CW self-label, and the CW
 * text in place of the stock or spoiler text. Each reads the compose
 * snapshot the write path captured before its first `await`, so a composer
 * that closes while publishing cannot change what is written.
 */

import {type $Typed, type Client} from '@atproto/lex'
import {type RichText} from '@bsky/sdk/richtext'

import {type PostDraft} from '#/view/com/composer/state/composer'
import {resolveContentWarningRT} from '#/horizon/spoilers/content-warning'
import {type SpoilerWriteMode} from '#/horizon/spoilers/write'
import {app, type com} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {
  type ComposeSpoilers,
  contentWarningOf,
  isImageFlagged,
  isVideoFlagged,
} from './compose-store'
import {
  CW_SELF_LABEL,
  PUBLIC_CW_LABEL_KEPT,
  PUBLIC_MEDIA_FLAG_KEPT,
  withFlag,
} from './nsid'
import {contentWarningsOn, mediaSpoilersOn} from './switches-read'

type PostEmbed = app.bsky.feed.post.Main['embed']
type Media = app.bsky.embed.recordWithMedia.Main['media']

function hasContentWarning(draft: PostDraft, snap: ComposeSpoilers): boolean {
  return contentWarningsOn() && contentWarningOf(snap, draft.id) !== undefined
}

function draftImages(draft: PostDraft) {
  const media = draft.embed.media
  return media?.type === 'images' || media?.type === 'gallery'
    ? media.images
    : []
}

function draftVideoFlagged(draft: PostDraft, snap: ComposeSpoilers): boolean {
  const media = draft.embed.media
  return media?.type === 'video' && isVideoFlagged(snap, media.video)
}

/**
 * Which items of `count` record items are flagged. Item `i` comes from draft
 * image `i` (`resolveMedia` maps them in order); if the counts differ, every
 * item is flagged when any draft image is (fail closed).
 */
function imageFlags(
  count: number,
  draft: PostDraft,
  snap: ComposeSpoilers,
  cw: boolean,
): boolean[] {
  const images = draftImages(draft)
  const own = images.map(image => isImageFlagged(snap, image))
  if (own.length !== count) {
    const any = cw || own.some(Boolean)
    return Array.from({length: count}, () => any)
  }
  return own.map(flag => cw || flag)
}

function flagMedia(
  media: Media,
  draft: PostDraft,
  snap: ComposeSpoilers,
  cw: boolean,
): Media {
  if (bsky.isType(app.bsky.embed.images, media)) {
    const flags = imageFlags(media.images.length, draft, snap, cw)
    if (!flags.some(Boolean)) return media
    return {
      ...media,
      images: media.images.map((image, i) =>
        flags[i] ? withFlag(image) : image,
      ),
    }
  }
  if (bsky.isType(app.bsky.embed.gallery, media)) {
    const flags = imageFlags(media.items.length, draft, snap, cw)
    if (!flags.some(Boolean)) return media
    return {
      ...media,
      items: media.items.map((item, i) => (flags[i] ? withFlag(item) : item)),
    }
  }
  if (bsky.isType(app.bsky.embed.video, media)) {
    return cw || draftVideoFlagged(draft, snap) ? withFlag(media) : media
  }
  return media
}

/**
 * `resolveEmbed`'s result with the flags of the draft's flagged images and
 * video, or of all of them for a post with a content warning. Link cards,
 * GIFs and record-only quotes carry none. Nothing is mutated; with nothing
 * flagged the same object is returned.
 */
export function withMediaSpoilers(
  embed: PostEmbed,
  draft: PostDraft,
  snap: ComposeSpoilers,
): PostEmbed {
  if (!embed || !mediaSpoilersOn()) return embed
  const cw = hasContentWarning(draft, snap)
  if (bsky.isType(app.bsky.embed.recordWithMedia, embed)) {
    const media = flagMedia(embed.media, draft, snap, cw)
    return media === embed.media ? embed : {...embed, media}
  }
  if (
    bsky.isType(app.bsky.embed.images, embed) ||
    bsky.isType(app.bsky.embed.gallery, embed) ||
    bsky.isType(app.bsky.embed.video, embed)
  ) {
    return flagMedia(embed, draft, snap, cw)
  }
  return embed
}

/**
 * The draft has a flagged image or video.
 */
function hasFlaggedMedia(draft: PostDraft, snap: ComposeSpoilers): boolean {
  if (!mediaSpoilersOn()) return false
  return (
    draftImages(draft).some(image => isImageFlagged(snap, image)) ||
    draftVideoFlagged(draft, snap)
  )
}

/**
 * A public post's self-labels with the CW label added (4.4): for a post with
 * a content warning, and, while the Bluesky servers drop the per-item flag
 * (B-MS1), for one with a flagged item. Unchanged while the CW label is not
 * kept by them (B-MS2) or the post needs none.
 */
export function withContentWarningLabel(
  labels: $Typed<com.atproto.label.defs.SelfLabels> | undefined,
  draft: PostDraft,
  snap: ComposeSpoilers,
): $Typed<com.atproto.label.defs.SelfLabels> | undefined {
  if (!PUBLIC_CW_LABEL_KEPT) return labels
  const wants =
    hasContentWarning(draft, snap) ||
    (!PUBLIC_MEDIA_FLAG_KEPT && hasFlaggedMedia(draft, snap))
  if (!wants) return labels
  const values = labels?.values ?? []
  if (values.some(value => value.val === CW_SELF_LABEL)) return labels
  return {
    $type: 'com.atproto.label.defs#selfLabels',
    values: [...values, {val: CW_SELF_LABEL}],
  }
}

/**
 * A private post's self-label values: the draft's, plus the CW label for a
 * post with a content warning (passed to `toPrivateSelfLabels`).
 */
export function contentWarningLabelValues(
  draft: PostDraft,
  snap: ComposeSpoilers,
): string[] {
  const values: string[] = [...draft.labels]
  if (hasContentWarning(draft, snap) && !values.includes(CW_SELF_LABEL)) {
    values.push(CW_SELF_LABEL)
  }
  return values
}

/**
 * The CW text of a post with a content warning, or `undefined` so the
 * caller's stock or spoiler text runs unchanged.
 */
export function resolveComposeRT(
  appviewClient: Client,
  draft: PostDraft,
  snap: ComposeSpoilers,
  mode: SpoilerWriteMode,
): Promise<RichText> | undefined {
  if (!contentWarningsOn()) return undefined
  const cw = contentWarningOf(snap, draft.id)
  if (!cw) return undefined
  return resolveContentWarningRT(appviewClient, draft.richtext, cw.line, mode)
}
