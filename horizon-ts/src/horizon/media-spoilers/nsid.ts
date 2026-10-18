/*
 * Storage of media spoilers and content warnings (2J design, 3): the per-item
 * flag on an image, gallery item or video object of a record, the CW
 * self-label, and the two server-support constants for the fallbacks if a
 * live check finds that a Bluesky server drops one of them.
 */

/**
 * The key of the per-item flag (MS-1). Written only as `true`; absent means
 * not flagged.
 */
export const MEDIA_SPOILER_FIELD = 'app.nearhorizon.spoiler' as const

/**
 * The self-label value that marks a post as a content warning post (MS-2).
 * Namespaced, so no labeler's `cw` definition applies and the stock
 * moderation ignores it (it fails `CUSTOM_LABEL_VALUE_RE`).
 */
export const CW_SELF_LABEL = 'app.nearhorizon.cw' as const

/**
 * The Bluesky PDS and AppView keep and serve the per-item flag (live checks
 * L2, L3). `false` (dependency B-MS1) makes a public post with any flagged
 * item carry the CW self-label as well, so Horizon covers all its media.
 */
export const PUBLIC_MEDIA_FLAG_KEPT: boolean = true

/**
 * The Bluesky PDS accepts and serves the CW self-label (live check L4).
 * `false` (dependency B-MS2) publishes a public CW post without it; private
 * posts keep it (K-1).
 */
export const PUBLIC_CW_LABEL_KEPT: boolean = true

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The item object carries the flag. Only the JSON value `true` flags.
 */
export function isFlagged(item: unknown): boolean {
  return isObject(item) && item[MEDIA_SPOILER_FIELD] === true
}

/**
 * A copy of `item` with the flag. The input is not changed, and no type is
 * widened: the result's type is assignable to `T`.
 */
export function withFlag<T extends object>(
  item: T,
): T & {[MEDIA_SPOILER_FIELD]: true} {
  return Object.assign({}, item, {[MEDIA_SPOILER_FIELD]: true as const})
}

/**
 * The record carries the CW self-label in its `labels`.
 */
export function isContentWarningRecord(record: unknown): boolean {
  if (!isObject(record) || !isObject(record.labels)) return false
  const labels = record.labels
  if (labels.$type !== 'com.atproto.label.defs#selfLabels') return false
  if (!Array.isArray(labels.values)) return false
  return (labels.values as unknown[]).some(
    value => isObject(value) && value.val === CW_SELF_LABEL,
  )
}
