/*
 * What the servers support for private posts. prism's support is read at
 * run time, per account, from the feature families its membership query
 * answers (`routing/features.ts`, 2H design 4): each function below names
 * its family. A function is `servesFeature` for the published account, or,
 * with `{forWrite: true}`, `servesFeatureForWrite`, which also needs this
 * run's answer (4.7): a list read from the device never unlocks a write.
 *
 * The constants that remain name a dependency (Phase 2 design section 16)
 * that no feature family covers. Unlike a switch, flipping one does not restore stock
 * behaviour: it moves a private feature from its defined interim behaviour
 * to its intended one, and is flipped in the commit that wires the landed
 * server interface.
 */

import {
  type PrismFeature,
  servesFeature,
  servesFeatureForWrite,
} from '#/horizon/routing/features'

/**
 * How a server-support function is asked.
 */
export type ServedOptions = {
  /** For a decision that writes: needs this run's answer (4.7). */
  forWrite?: boolean
}

function served(feature: PrismFeature, opts: ServedOptions | undefined) {
  return opts?.forWrite
    ? servesFeatureForWrite(feature)
    : servesFeature(feature)
}

/**
 * prism serves facets on private posts (`private.embeds`, P-1). Until then
 * links and hashtags are detected locally in a served private post's text;
 * mentions stay plain text. It also sets how private spoilers are written
 * (spoilers design 5.3): until it is served they keep their `||` markers in
 * the text, which readers parse locally; once served (as answered in this
 * run, for the write), the markers leave the text and the spoilers travel as
 * facets only.
 */
export function privateFacetsServed(opts?: ServedOptions): boolean {
  return served('private.embeds', opts)
}

/**
 * prism serves bookmarks of private posts (`private.bookmarks`, P-8, P-19).
 * Until then: a bookmark press on a private post is refused with a toast,
 * and Saved's Private tab shows its empty state and makes no request.
 */
export function privateBookmarksServed(opts?: ServedOptions): boolean {
  return served('private.bookmarks', opts)
}

/**
 * prism applies threadgates and postgates on private posts
 * (`private.gates`, P-18) whose thread root, or quoted post, is private.
 * Until then readers' clients check them (design 7.4.2), and who can reply,
 * Hide reply for everyone and Detach quote are absent on private posts.
 */
export function privateGatesServed(opts?: ServedOptions): boolean {
  return served('private.gates', opts)
}

/**
 * prism serves interactions on private posts (`private.interactions`, P-2,
 * P-5, P-16): counts and viewer state on views (read by data, not by this
 * function), the likes, reposts and quotes lists, repost items, and thread
 * mutes of private roots. Until then: no Mute thread on a private root, and
 * no mirror of a public root's mute to prism.
 */
export function privateInteractionsServed(opts?: ServedOptions): boolean {
  return served('private.interactions', opts)
}

/**
 * prism serves private notifications (`private.notifications`, P-9): the
 * list, the unread count and mark-seen.
 */
export function privateNotificationsServed(opts?: ServedOptions): boolean {
  return served('private.notifications', opts)
}

/**
 * prism pages past what the reader cannot read and filters its private
 * author feed like the stock one (`private.paging`, P-20, P-6, P-14), and
 * serves `getReplies`. Until then the profile's Posts tab filters prism's
 * author feed on the client.
 */
export function privatePagingServed(opts?: ServedOptions): boolean {
  return served('private.paging', opts)
}

/**
 * prism filters its private author feed with `posts_with_media` and
 * `posts_with_video` (`private.mediaFilters`, P-30; change list item 4).
 * Until then the profile Media and Videos tabs are public-only.
 */
export function privateMediaFiltersServed(opts?: ServedOptions): boolean {
  return served('private.mediaFilters', opts)
}

/**
 * prism searches the private posts the reader may read (`private.search`,
 * P-7).
 */
export function privateSearchServed(opts?: ServedOptions): boolean {
  return served('private.search', opts)
}

/**
 * prism reads a reply by its thread root's current audience
 * (`private.threadAudience`, P-21, P-22).
 */
export function threadAudienceServed(opts?: ServedOptions): boolean {
  return served('private.threadAudience', opts)
}

/**
 * aurora renames, edits and deletes audience records (A-4). Until then: the
 * Audiences screen offers create only.
 */
export const AUDIENCE_EDIT: boolean = false

/**
 * The kryphocron lexicon defines `langs` and self-labels on private posts
 * (K-1, kryphocron-lexicons 0.3.1). With it on, a private record carries the
 * post's languages and its content warning
 * (`tools.kryphocron.feed.postPublic#selfLabels`), and readers' views carry
 * the self-labels so the stock moderation covers the media; while off,
 * `langs` is not written and a private post with a self-label is blocked.
 */
export const PRIVATE_LANGS_LABELS: boolean = true

/**
 * The kryphocron lexicon defines a quote-with-media embed (K-2,
 * kryphocron-lexicons 0.3.1). With it on, a quote with images, a gallery, a
 * video or a link card is written as `#embedRecordWithMedia`; while off, a
 * private post with both a quote and media is blocked.
 */
export const PRIVATE_QUOTE_WITH_MEDIA: boolean = true

/**
 * The kryphocron lexicon defines `#embedVideo` (K-6, kryphocron-lexicons
 * 0.3.1) and aurora keeps a video blob that only a private record references
 * (A-11, locus `c5a4e09`). With it on, the private media picker is the stock
 * one and a video (or a GIF file, uploaded as video) is written as
 * `#embedVideo`. Playback depends on the view prism serves (P-1); until then
 * the adapter builds the view from the record (6.1.3).
 */
export const PRIVATE_VIDEO: boolean = true

/**
 * The kryphocron lexicon defines `#embedGallery` (K-7, kryphocron-lexicons
 * 0.3.1). With it on, five to ten images are written as `#embedGallery`;
 * while off, such a private post is blocked. Writing needs nothing from
 * prism; readers see the gallery from the record until prism serves its view
 * (P-1, 6.1.3).
 */
export const PRIVATE_GALLERY: boolean = true

/**
 * The kryphocron lexicon defines image `aspectRatio` and link-card `thumb`
 * (K-4, kryphocron-lexicons 0.3.1). With it on both are written; while off
 * both are dropped from private records.
 */
export const PRIVATE_MEDIA_EXTRAS: boolean = true

/**
 * aurora changes a private post's audience in place (A-9, live since
 * `7d15085`), on top-level posts and branch roots (A-13, `9905853`), and
 * answers the new record CID (A-1). With it on, the post settings dialog
 * changes who can see through `updatePostPrivate` (7.8.1); while off it shows
 * who can see read-only. prism re-reads the post on `requestRecord`; that
 * replies follow the move is prism's P-21/P-22 (S12, not built yet), which
 * the dialog's note covers.
 */
export const PRIVATE_AUDIENCE_CHANGE: boolean = true
