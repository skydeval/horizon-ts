/*
 * What a private post can carry today, and what blocks publishing while
 * Private is selected. A private record carries what the kryphocron lexicon
 * defines and the servers keep. Each media kind is written once its
 * server-support constant is on (design 2.5); until then a private post with
 * a video, a gallery (five or more images), a quote and media together, or a
 * content warning is blocked rather than published without it. These
 * messages are the interim behaviour of a server dependency, not a statement
 * that the feature is not coming.
 */

import {t} from '@lingui/core/macro'

import {type AssetType} from '#/view/com/composer/SelectMediaButton'
import {
  type PostDraft,
  type ThreadDraft,
} from '#/view/com/composer/state/composer'
import {
  PRIVATE_GALLERY,
  PRIVATE_LANGS_LABELS,
  PRIVATE_QUOTE_WITH_MEDIA,
  PRIVATE_VIDEO,
} from '#/horizon/private/server-support'

function hasVideo(post: PostDraft) {
  return post.embed.media?.type === 'video'
}

function hasGallery(post: PostDraft) {
  return post.embed.media?.type === 'gallery'
}

function hasQuoteWithMedia(post: PostDraft) {
  return !!post.embed.quote && !!post.embed.media
}

function hasSelfLabel(post: PostDraft) {
  return post.labels.length > 0
}

/**
 * The first blocker message that applies to a private compose of `thread`,
 * else `undefined`.
 */
export function privateComposeBlocker(thread: ThreadDraft): string | undefined {
  if (!PRIVATE_VIDEO && thread.posts.some(hasVideo)) {
    return t`Private posts can’t include video yet.`
  }
  if (!PRIVATE_GALLERY && thread.posts.some(hasGallery)) {
    return t`Private posts can hold up to four images for now. Remove some to post privately.`
  }
  if (!PRIVATE_QUOTE_WITH_MEDIA && thread.posts.some(hasQuoteWithMedia)) {
    return t`Private posts can’t include images and a quote together yet. Remove one to post privately.`
  }
  if (!PRIVATE_LANGS_LABELS && thread.posts.some(hasSelfLabel)) {
    return t`Private posts can’t carry content warnings yet. Remove the warning or post publicly.`
  }
  return undefined
}

/**
 * A term of the composer's `canPost`: always `true` for a public compose,
 * and for a private one only while no blocker applies.
 */
export function privateComposeAllows(
  thread: ThreadDraft,
  isPrivate: boolean,
): boolean {
  return !isPrivate || privateComposeBlocker(thread) === undefined
}

/**
 * The media picker offers images only while private and `PRIVATE_VIDEO` is
 * off; otherwise the stock selection (the full picker).
 */
export function privateAssetTypes(
  selected: AssetType | undefined,
  isPrivate: boolean,
): AssetType | undefined {
  return isPrivate && !PRIVATE_VIDEO ? 'image' : selected
}
