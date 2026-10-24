/*
 * Putting a picked emoji into the member's emoji field (Phase 5 design 7.2).
 * The pick goes where the cursor is, replacing any selection, or at the end
 * when the field has never had a cursor. A pick that would take the field
 * over its grapheme limit is refused rather than cut, so a half-written
 * ZWJ sequence can never be saved.
 */

import {countGraphemes, splitGraphemes} from 'unicode-segmenter/grapheme'

/** A text selection in UTF-16 code units, as React Native reports it. */
export type Selection = {start: number; end: number}

export type EmojiInsert =
  {ok: true; value: string; cursor: number} | {ok: false; reason: 'full'}

/** The grapheme boundaries of `value`, in UTF-16 offsets, 0 first. */
function boundaries(value: string): number[] {
  const out = [0]
  let at = 0
  for (const grapheme of splitGraphemes(value)) {
    at += grapheme.length
    out.push(at)
  }
  return out
}

/** `offset` moved to a grapheme boundary, down or up. */
function snap(value: string, offset: number, up: boolean): number {
  const clamped = Math.max(0, Math.min(offset, value.length))
  const all = boundaries(value)
  if (up) return all.find(b => b >= clamped) ?? value.length
  let found = 0
  for (const b of all) {
    if (b <= clamped) found = b
  }
  return found
}

/**
 * `emoji` put into `value` at `selection` (or appended without one), or a
 * refusal when the result would hold more than `max` graphemes.
 */
export function insertEmoji(
  value: string,
  emoji: string,
  selection: Selection | undefined,
  max: number,
): EmojiInsert {
  let start = value.length
  let end = value.length
  if (selection && selection.start === selection.end) {
    // A bare cursor inside a grapheme goes to that grapheme's end.
    start = end = snap(value, selection.start, true)
  } else if (selection) {
    // A selection grows to whole graphemes.
    start = snap(value, Math.min(selection.start, selection.end), false)
    end = snap(value, Math.max(selection.start, selection.end), true)
  }
  const next = value.slice(0, start) + emoji + value.slice(end)
  if (countGraphemes(next) > max) return {ok: false, reason: 'full'}
  return {ok: true, value: next, cursor: start + emoji.length}
}
