/*
 * What a private post can carry today, and what blocks publishing while
 * Private is selected. A private record carries what the kryphocron lexicon
 * defines and the servers keep. Each media kind is written once its
 * server-support constant is on (design 2.5); until then a private post with
 * a video, a gallery (five or more images), a quote and media together, or a
 * content warning is blocked rather than published without it. These
 * messages are the interim behaviour of a server dependency, not a statement
 * that the feature is not coming.
 *
 * A private compose is also blocked while the account's posting route is
 * `checking` or `none` (2K design 8.1): a locked reply, or a private draft
 * restored, on an account that cannot post privately yet, and while its
 * audience is unpicked (a draft restored with no visibility entry on this
 * device, P5R7-L1). The route and the audience always come in as arguments
 * from a hook (PA-26): the composer calls these in render, and React
 * Compiler memoizes them on their arguments, so a store read in here would
 * keep a stale answer.
 *
 * With another account chosen in the "Posting as" control (Phase 5 design
 * 8.2, 8.5), the routes are that account's, mapped to posting route `none`
 * with reason `other-account` off `locus`, and the posting account's handle
 * comes in as an argument too, for the two notes that name it.
 */

import {t} from '@lingui/core/macro'

import {type AssetType} from '#/view/com/composer/SelectMediaButton'
import {
  type PostDraft,
  type ThreadDraft,
} from '#/view/com/composer/state/composer'
import {PRODUCT_NAME} from '#/horizon/branding'
import {type ComposeAudience} from '#/horizon/private/composer/state'
import {
  PRIVATE_GALLERY,
  PRIVATE_LANGS_LABELS,
  PRIVATE_QUOTE_WITH_MEDIA,
  PRIVATE_VIDEO,
} from '#/horizon/private/server-support'
import {type WriteRoutes} from '#/horizon/routing/write-route'

/**
 * The first sentence of the `none` note, also the inert Private segment's
 * accessibility hint.
 */
export function privateRouteHint(): string {
  return t`Private posting isn’t available for your account yet.`
}

/**
 * `@handle`, or a neutral stand-in when the handle is not known.
 */
function atHandle(handle: string | undefined): string {
  return handle ? `@${handle}` : t`that account`
}

/**
 * The note for posting route `checking` or `none` (8.1), else `undefined`.
 * Neutral about locus versus elsewhere (LO-3, SQ-13). `postingHandle` is the
 * posting account's, for reason `other-account`.
 */
export function privateRouteNote(
  routes: Pick<WriteRoutes, 'postingRoute' | 'reason' | 'indexing'>,
  postingHandle?: string,
): string | undefined {
  if (routes.postingRoute === 'checking') {
    return t`${PRODUCT_NAME} is still checking your account.`
  }
  if (routes.postingRoute !== 'none') return undefined
  if (routes.reason === 'other-account') {
    const other = atHandle(postingHandle)
    return t`Switch to ${other} to post privately.`
  }
  if (routes.reason === 'no-encoder') {
    return t`Private posting isn’t available for your account yet. Posting privately from your server isn’t available in this app yet.`
  }
  if (routes.indexing) {
    return t`Private posting isn’t available for your account yet. ${PRODUCT_NAME} is still checking your account.`
  }
  return t`Private posting isn’t available for your account yet. Your server doesn’t have it, and ${PRODUCT_NAME} can’t prepare private posts for you right now.`
}

/**
 * What blocks a private compose because of the posting route: the note while
 * it is `checking` or `none`, else `undefined`.
 */
export function privateRouteBlocker(
  routes: WriteRoutes,
  postingHandle?: string,
): string | undefined {
  return privateRouteNote(routes, postingHandle)
}

/**
 * The note for a private compose whose audience is unpicked, else
 * `undefined`, by where the `unpicked` came from. `postingHandle` names the
 * posting account in the note of an account change.
 */
export function unpickedAudienceNote(
  audience: ComposeAudience,
  postingHandle?: string,
): string | undefined {
  if (audience.kind !== 'unpicked') return undefined
  if (audience.why === 'unsaved') {
    return t`This draft’s visibility wasn’t saved on this device. Choose Public or who can see it.`
  }
  if (audience.why === 'draft') return t`Choose who can see this draft.`
  if (audience.why === 'switch') {
    const other = atHandle(postingHandle)
    return t`Choose an audience for ${other}. Audiences belong to the account that posts.`
  }
  return t`Choose who can see this post.`
}

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
 * The first blocker message that applies to a private compose of `thread` on
 * `routes` with `audience`, else `undefined`. A draft whose visibility is
 * unknown on this device says so before the route's note, since picking
 * Public is the way out on any route. `postingHandle` is the posting
 * account's, for the notes that name it.
 */
export function privateComposeBlocker(
  thread: ThreadDraft,
  routes: WriteRoutes,
  audience: ComposeAudience,
  postingHandle?: string,
): string | undefined {
  const unpicked = unpickedAudienceNote(audience, postingHandle)
  if (audience.kind === 'unpicked' && audience.why === 'unsaved') {
    return unpicked
  }
  const route = privateRouteBlocker(routes, postingHandle)
  if (route) return route
  if (unpicked) return unpicked
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
 * and for a private one only while no blocker applies (an unpicked audience
 * included).
 */
export function privateComposeAllows(
  thread: ThreadDraft,
  isPrivate: boolean,
  routes: WriteRoutes,
  audience: ComposeAudience,
): boolean {
  return (
    !isPrivate || privateComposeBlocker(thread, routes, audience) === undefined
  )
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
