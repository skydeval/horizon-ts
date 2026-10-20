/*
 * The `RichText` objects that the post sites build from a post record
 * (`withContentWarningRecord` marks them). Keyed by the object, so nothing
 * is added to the stock `RichText`, and a bio, a DM or a part built later
 * (a new object) is not a post's text.
 */

import {type RichText as RichTextAPI} from '@bsky/sdk/richtext'

const postTexts = new WeakSet<RichTextAPI>()

/** Remember `richText` as a post's text. */
export function markPostText(richText: RichTextAPI): void {
  postTexts.add(richText)
}

/** `richText` was built by a post site from a post record. */
export function isPostText(richText: RichTextAPI): boolean {
  return postTexts.has(richText)
}

/**
 * `richText`, unchanged, remembered as a post's text, for a post site that
 * does not go through `withContentWarningRecord` (the DM share preview).
 */
export function asPostText<T extends RichTextAPI>(richText: T): T {
  postTexts.add(richText)
  return richText
}
