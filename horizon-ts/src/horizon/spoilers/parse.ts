/*
 * The one parser of `||...||` (spoilers design, 4). It runs on the writer's
 * text: at publish, in the counter and, until prism serves facets, on a
 * served private post's text. Rendering never parses; it reads facets.
 *
 * Indices are UTF-16 code units. `|` and `\` are ASCII, so no marker or
 * escape splits a surrogate pair.
 */

import {splitGraphemes} from 'unicode-segmenter/grapheme'

/**
 * A marker taken out of the text: `at` is the index in the visible text it
 * was taken from, `text` what was taken.
 */
export type SpoilerInsertion = {at: number; text: '||' | '||\n' | '\n||'}

/**
 * A range of the visible text, start inclusive, end exclusive.
 */
export type SpoilerSpan = {start: number; end: number}

export type SpoilerParse = {
  /**
   * The text without the markers (and, with `unescape`, without the
   * backslash of each `\|`).
   */
  visible: string
  /**
   * The spoilers, as ranges of `visible`, sorted and merged. Empty means no
   * spoilers.
   */
  spans: SpoilerSpan[]
  /**
   * The markers taken out, in text order.
   */
  insertions: SpoilerInsertion[]
}

/**
 * The grapheme boundaries of `text`, 0 and its length included.
 */
export function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0])
  let index = 0
  for (const grapheme of splitGraphemes(text)) {
    index += grapheme.length
    boundaries.add(index)
  }
  return boundaries
}

type Marker = {start: number; end: number}
type Deletion = {
  start: number
  end: number
  text?: SpoilerInsertion['text']
}

/**
 * Parse `text` for spoilers. With `unescape` (strip mode) the backslash of
 * each `\|` is dropped from the visible text; without it escapes stay as
 * typed.
 */
export function parseSpoilers(
  text: string,
  {unescape}: {unescape: boolean},
): SpoilerParse {
  const boundaries = graphemeBoundaries(text)

  // 1. Tokens, pairing from the left, on grapheme boundaries only.
  const markers: Marker[] = []
  const escapes: number[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]
    if (
      (char === '\\' || char === '|') &&
      next === '|' &&
      boundaries.has(i) &&
      boundaries.has(i + 2)
    ) {
      if (char === '\\') escapes.push(i)
      else markers.push({start: i, end: i + 2})
      i += 2
    } else {
      i += 1
    }
  }

  // 2 and 3. Markers pair in order; an empty or whitespace-only pair is text.
  const pairs: [Marker, Marker][] = []
  for (let m = 0; m + 1 < markers.length; m += 2) {
    const open = markers[m]
    const close = markers[m + 1]
    if (/\S/u.test(text.slice(open.end, close.start))) {
      pairs.push([open, close])
    }
  }
  if (pairs.length === 0) {
    return {
      visible: unescape ? removeEscapes(text, escapes) : text,
      spans: [],
      insertions: [],
    }
  }

  // 4. Markers alone on a line go with that line break.
  const deletions: Deletion[] = []
  const contents: {start: number; end: number}[] = []
  for (const [open, close] of pairs) {
    const openAlone =
      (open.start === 0 || text[open.start - 1] === '\n') &&
      text[open.end] === '\n'
    const openRemoval: Deletion = openAlone
      ? {start: open.start, end: open.end + 1, text: '||\n'}
      : {start: open.start, end: open.end, text: '||'}
    const closeAlone =
      (close.end === text.length || text[close.end] === '\n') &&
      text[close.start - 1] === '\n' &&
      close.start - 1 >= openRemoval.end
    const closeRemoval: Deletion = closeAlone
      ? {start: close.start - 1, end: close.end, text: '\n||'}
      : {start: close.start, end: close.end, text: '||'}
    deletions.push(openRemoval, closeRemoval)
    contents.push({start: openRemoval.end, end: closeRemoval.start})
  }
  if (unescape) {
    for (const at of escapes) deletions.push({start: at, end: at + 1})
  }
  deletions.sort((x, y) => x.start - y.start)

  // 5. The visible text, where each removal was taken from, and the spans.
  const visibleAt = new Array<number>(text.length + 1)
  const insertions: SpoilerInsertion[] = []
  let visible = ''
  let cursor = 0
  for (const deletion of deletions) {
    while (cursor < deletion.start) {
      visibleAt[cursor] = visible.length
      visible += text[cursor]
      cursor++
    }
    if (deletion.text) {
      insertions.push({at: visible.length, text: deletion.text})
    }
    while (cursor < deletion.end) {
      visibleAt[cursor] = visible.length
      cursor++
    }
  }
  while (cursor < text.length) {
    visibleAt[cursor] = visible.length
    visible += text[cursor]
    cursor++
  }
  visibleAt[text.length] = visible.length

  // 6. Spans snap out to whole graphemes of the visible text.
  const sorted = [...graphemeBoundaries(visible)].sort((x, y) => x - y)
  const spans = contents.map(content =>
    snap(
      {start: visibleAt[content.start], end: visibleAt[content.end]},
      sorted,
    ),
  )

  return {visible, spans: mergeSpans(spans), insertions}
}

function removeEscapes(text: string, escapes: number[]): string {
  if (escapes.length === 0) return text
  let out = ''
  let from = 0
  for (const at of escapes) {
    out += text.slice(from, at)
    from = at + 1
  }
  return out + text.slice(from)
}

function snap(span: SpoilerSpan, boundaries: number[]): SpoilerSpan {
  let start = 0
  let end = boundaries[boundaries.length - 1]
  for (const b of boundaries) {
    if (b <= span.start) start = b
    if (b >= span.end) {
      end = b
      break
    }
  }
  return {start, end}
}

/**
 * Sort spans and merge those that overlap or touch.
 */
export function mergeSpans(spans: SpoilerSpan[]): SpoilerSpan[] {
  const sorted = [...spans].sort((x, y) => x.start - y.start)
  const merged: SpoilerSpan[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last && last.end >= span.start) {
      last.end = Math.max(last.end, span.end)
    } else {
      merged.push({...span})
    }
  }
  return merged
}

/**
 * The text holds at least one spoiler, as written in a public post (escapes
 * kept).
 */
export function hasSpoilers(text: string): boolean {
  if (!text.includes('||')) return false
  return parseSpoilers(text, {unescape: false}).spans.length > 0
}
