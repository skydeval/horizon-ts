/*
 * The CW line of a whole-post content warning, drawn as a warning (2J
 * follow-up): "CW: " before it, drawn by Horizon and never stored, and the
 * line in the warning style. Pure, apart from the set of texts built from a
 * CW post's record.
 *
 * The line is found two ways. With a body, the body is a CW span (its facets
 * carry `#contentWarning`) and the line is the text before it. Without a
 * body (a CW line and media only), the text has no spoiler facet and only
 * the record's CW self-label marks it, so the sites that build a post's
 * `RichText` from its record pass the record to `withContentWarningRecord`.
 *
 * Positions are UTF-8 byte offsets, as facets count.
 */

import {type RichText as RichTextAPI} from '@bsky/sdk/richtext'

import {isContentWarningRecord} from '#/horizon/media-spoilers/nsid'
import {contentWarningsOn} from '#/horizon/media-spoilers/switches-read'
import {isPostText, markPostText} from './post-texts'

/**
 * Texts built from a record with the CW self-label. Keyed by the object, so
 * nothing is added to the stock `RichText` and a part built from it later
 * (a new object) is not a CW post's text.
 */
const cwTexts = new WeakSet<RichTextAPI>()

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * `richText`, unchanged, remembered as a post's text (`post-texts.ts`, read
 * by local detection of spoilers from other apps) and as a CW post's text
 * when `record` (the record it was built from) carries the CW self-label.
 */
export function withContentWarningRecord<T extends RichTextAPI | undefined>(
  richText: T,
  record: unknown,
): T {
  if (!richText) return richText
  markPostText(richText)
  if (isContentWarningRecord(record)) cwTexts.add(richText)
  return richText
}

/**
 * `to`, a text rebuilt from `from` (local detection), takes `from`'s marks.
 */
export function carryTextMarks(from: RichTextAPI, to: RichTextAPI): void {
  if (isPostText(from)) markPostText(to)
  if (cwTexts.has(from)) cwTexts.add(to)
}

/**
 * `richText` was built from a record with the CW self-label.
 */
export function isContentWarningText(richText: RichTextAPI): boolean {
  return cwTexts.has(richText)
}

/**
 * A span of the visible text; `cw`: a content warning's body.
 */
export type CwLineSpan = {start: number; end: number; cw: boolean}

/**
 * The end of the CW line in the visible bytes of a post text; the line
 * starts at 0. `labelled`: the text was built from a record with the CW
 * self-label. `undefined` when the text has no CW line:
 *
 * - With a body: the first span is a CW span that runs to the end of the
 *   text (trailing whitespace aside), and the text before it, trailing
 *   whitespace dropped, is one line that starts with a non-space. A line
 *   break flattened to a space (the notification sentence) still counts.
 * - Without a body: the record is labelled, the text has no span, and it is
 *   one line (the CW line is written without line breaks).
 *
 * Anything else (no line, a span before the body, text after it, a label on
 * a text with spoilers but no CW span) draws no prefix: the text renders as
 * it does today.
 */
export function contentWarningLineEnd(
  bytes: Uint8Array,
  spans: readonly CwLineSpan[],
  labelled: boolean,
): number | undefined {
  const first = spans[0]
  let head: string
  if (first?.cw) {
    if (/\S/u.test(decoder.decode(bytes.slice(first.end)))) return undefined
    head = decoder.decode(bytes.slice(0, first.start))
  } else if (labelled && spans.length === 0) {
    head = decoder.decode(bytes)
  } else {
    return undefined
  }
  const line = head.trimEnd()
  if (!line || /^\s/u.test(line) || /[\r\n]/.test(line)) return undefined
  return encoder.encode(line).length
}

/**
 * The CW line's end in `richText`'s visible bytes, with content warnings on;
 * `undefined` otherwise.
 */
export function cwLineEndOf(
  richText: RichTextAPI,
  bytes: Uint8Array,
  spans: readonly CwLineSpan[],
): number | undefined {
  if (!contentWarningsOn()) return undefined
  return contentWarningLineEnd(bytes, spans, isContentWarningText(richText))
}

/**
 * The label a screen reader reads for a run of text that holds the CW line
 * (on native, where nested texts have none of their own): `spoken` ("Content
 * warning:") in place of the drawn "CW:", then the run as read, a part by
 * `covered(part)` when it is covered (its cover's name) and by its text
 * otherwise. `undefined` for a run without the line.
 */
export function cwLineRunLabel<
  P extends {kind: string; cwLine?: boolean; richText: {text: string}},
>(
  parts: readonly P[],
  spoken: string,
  covered: (part: P) => string | undefined,
): string | undefined {
  if (!parts.some(part => part.kind === 'plain' && part.cwLine)) {
    return undefined
  }
  const read = parts
    .map(part => covered(part) ?? part.richText.text)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
  return `${spoken} ${read}`
}

/**
 * The record-labelled text without spoiler facets has a CW line, so it is
 * drawn by the spoiler renderer to show the prefix.
 */
export function rendersContentWarningLine(richText: RichTextAPI): boolean {
  if (!contentWarningsOn() || !isContentWarningText(richText)) return false
  return (
    contentWarningLineEnd(encoder.encode(richText.text), [], true) !== undefined
  )
}
