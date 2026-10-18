/*
 * What a post text with spoiler facets draws (spoilers design, 6.3): the
 * record's text and facets turned into runs of plain parts and inline
 * covers, and drawers for spoilers that occupy whole lines. Pure; rendering
 * is `SpoilerRichText.tsx`.
 *
 * Positions are UTF-8 byte offsets, as facets count.
 */

import {type Facet, RichText as RichTextAPI} from '@bsky/sdk/richtext'

import {SPOILER_TAGS} from '#/horizon/switches'
import {isSpoilerFeature, isSpoilerMarkerFeature} from './nsid'

/**
 * A rendering of at most this many lines (a notification line, the DM post
 * embed) draws block spoilers as inline covers.
 */
export const COMPACT_MAX_LINES = 3

/**
 * The text carries a spoiler facet and the switch is on. Texts without one
 * (bios, DMs, descriptions, posts without spoilers) render as stock.
 */
export function rendersSpoilers(richText: RichTextAPI): boolean {
  return (
    SPOILER_TAGS &&
    !!richText.facets?.some(
      facet =>
        Array.isArray(facet.features) && facet.features.some(isSpoilerFeature),
    )
  )
}

export type SpoilerPart =
  | {kind: 'plain'; richText: RichTextAPI}
  | {kind: 'spoiler'; id: number; richText: RichTextAPI}

/**
 * Inline text: `parts`, then, when a block follows, the arrow that opens it
 * (`arrowFor`, the block's id) and the blank lines after the arrow (`tail`).
 */
export type SpoilerRun = {
  kind: 'run'
  parts: SpoilerPart[]
  arrowFor?: number
  tail: SpoilerPart[]
}

/**
 * A block spoiler's drawer. `label`: nothing precedes it, so it opens from a
 * "Spoiler" row of its own.
 */
export type SpoilerDrawer = {
  kind: 'drawer'
  id: number
  label: boolean
  parts: SpoilerPart[]
}

export type SpoilerLayout = {
  /**
   * There is a block, so the items stack in a column; otherwise there is one
   * run.
   */
  column: boolean
  items: (SpoilerRun | SpoilerDrawer)[]
}

type ByteRange = {start: number; end: number}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const PIPE = 0x7c
const NEWLINE = 0x0a
/** `\n`, `\r`, `\t` and space. */
const MARKER_SPACE = new Set([0x0a, 0x0d, 0x09, 0x20])

function isCodePointBoundary(bytes: Uint8Array, b: number): boolean {
  return b === 0 || b === bytes.length || (bytes[b] & 0xc0) !== 0x80
}

function isMarkerBytes(bytes: Uint8Array, start: number, end: number) {
  const pipes = (at: number) => bytes[at] === PIPE && bytes[at + 1] === PIPE
  if (end - start === 2) return pipes(start)
  if (end - start === 3) {
    return (
      (pipes(start) && MARKER_SPACE.has(bytes[start + 2])) ||
      (MARKER_SPACE.has(bytes[start]) && pipes(start + 1))
    )
  }
  return false
}

function overlaps(x: ByteRange, y: ByteRange): boolean {
  return x.start < y.end && y.start < x.end
}

function rangeOf(facet: Facet): ByteRange {
  return {start: facet.index.byteStart, end: facet.index.byteEnd}
}

/**
 * The visible text of a post with spoiler facets: marker facets hidden,
 * spoiler spans found and merged, and the other facets that remain, all
 * against the visible bytes.
 */
export function visibleSpoilerText(richText: RichTextAPI): {
  bytes: Uint8Array
  spans: ByteRange[]
  facets: Facet[]
} {
  const source = encoder.encode(richText.text)

  // 1. Facets that fit the text.
  const valid = (richText.facets ?? [])
    .filter(facet => {
      const {start, end} = rangeOf(facet)
      return (
        Array.isArray(facet.features) &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        start < end &&
        end <= source.length &&
        isCodePointBoundary(source, start) &&
        isCodePointBoundary(source, end)
      )
    })
    .sort((x, y) => x.index.byteStart - y.index.byteStart)

  // 2. Hidden markers: a marker facet over `||` and at most one space byte.
  const hidden: ByteRange[] = []
  const rest: Facet[] = []
  for (const facet of valid) {
    if (!facet.features.some(isSpoilerMarkerFeature)) {
      rest.push(facet)
      continue
    }
    const range = rangeOf(facet)
    if (
      facet.features.length === 1 &&
      !hidden.some(h => overlaps(h, range)) &&
      isMarkerBytes(source, range.start, range.end)
    ) {
      hidden.push(range)
      continue
    }
    const features = facet.features.filter(f => !isSpoilerMarkerFeature(f))
    if (features.length) rest.push({...facet, features})
  }
  const shown = rest.filter(
    facet => !hidden.some(h => overlaps(h, rangeOf(facet))),
  )

  const kept: number[] = []
  let cursor = 0
  for (const h of hidden) {
    for (let b = cursor; b < h.start; b++) kept.push(source[b])
    cursor = h.end
  }
  for (let b = cursor; b < source.length; b++) kept.push(source[b])
  const bytes = Uint8Array.from(kept)
  const shift = (b: number) =>
    b -
    hidden.reduce((sum, h) => (h.end <= b ? sum + (h.end - h.start) : sum), 0)

  // 3. Spans, merged, without whitespace-only ones.
  const raw: ByteRange[] = []
  const others: Facet[] = []
  for (const facet of shown) {
    const range = {
      start: shift(facet.index.byteStart),
      end: shift(facet.index.byteEnd),
    }
    const features = facet.features.filter(f => !isSpoilerFeature(f))
    if (features.length < facet.features.length) raw.push(range)
    if (features.length) {
      others.push({
        ...facet,
        index: {...facet.index, byteStart: range.start, byteEnd: range.end},
        features,
      })
    }
  }
  raw.sort((x, y) => x.start - y.start)
  const merged: ByteRange[] = []
  for (const span of raw) {
    const last = merged[merged.length - 1]
    if (last && last.end >= span.start) last.end = Math.max(last.end, span.end)
    else merged.push({...span})
  }
  const spans = merged.filter(span =>
    /\S/u.test(decoder.decode(bytes.slice(span.start, span.end))),
  )
  const facets = others.filter(
    facet =>
      !spans.some(span =>
        [span.start, span.end].some(
          edge => facet.index.byteStart < edge && edge < facet.index.byteEnd,
        ),
      ),
  )
  return {bytes, spans, facets}
}

/**
 * The layout of a post text with spoiler facets. `compact` (a rendering of
 * `COMPACT_MAX_LINES` lines or fewer) draws every spoiler inline.
 */
export function buildSpoilerLayout(
  richText: RichTextAPI,
  {compact}: {compact: boolean},
): SpoilerLayout {
  const {bytes, spans, facets} = visibleSpoilerText(richText)
  const length = bytes.length
  const hasNewline = bytes.includes(NEWLINE)

  // 4. Blocks occupy whole lines of a text with more than one line.
  const isBlock = (span: ByteRange) =>
    !compact &&
    hasNewline &&
    (span.start === 0 || bytes[span.start - 1] === NEWLINE) &&
    (span.end === length || bytes[span.end] === NEWLINE)
  const numbered = spans.map((span, id) => ({
    ...span,
    id,
    block: isBlock(span),
  }))
  const inline = numbered.filter(span => !span.block)

  const sliceText = (start: number, end: number) =>
    decoder.decode(bytes.slice(start, end))

  // 7. Parts of a range: plain text and inline covers, with their facets.
  const partOf = (start: number, end: number): RichTextAPI => {
    const inside = facets
      .filter(f => f.index.byteStart >= start && f.index.byteEnd <= end)
      .map(f => ({
        ...f,
        index: {
          ...f.index,
          byteStart: f.index.byteStart - start,
          byteEnd: f.index.byteEnd - start,
        },
      }))
    return new RichTextAPI({
      text: sliceText(start, end),
      facets: inside.length ? inside : undefined,
    })
  }
  const partsOf = (start: number, end: number, covers: boolean) => {
    const parts: SpoilerPart[] = []
    let cursor = start
    if (covers) {
      for (const span of inline) {
        const from = Math.max(span.start, start)
        const to = Math.min(span.end, end)
        if (from >= to) continue
        if (from > cursor) {
          parts.push({kind: 'plain', richText: partOf(cursor, from)})
        }
        parts.push({kind: 'spoiler', id: span.id, richText: partOf(from, to)})
        cursor = to
      }
    }
    if (end > cursor) parts.push({kind: 'plain', richText: partOf(cursor, end)})
    return parts
  }

  const blocks = numbered.filter(span => span.block)
  if (blocks.length === 0) {
    return {
      column: false,
      items: [{kind: 'run', parts: partsOf(0, length, true), tail: []}],
    }
  }

  // 5 and 6. A column: runs, each block's arrow or label row, drawers.
  const items: (SpoilerRun | SpoilerDrawer)[] = []
  let cursor = 0
  for (const block of blocks) {
    const runEnd = Math.max(cursor, block.start - 1)
    const headEnd = lastFilledLineEnd(bytes, cursor, runEnd)
    if (headEnd !== undefined) {
      items.push({
        kind: 'run',
        parts: partsOf(cursor, headEnd, true),
        arrowFor: block.id,
        tail: partsOf(headEnd, runEnd, true),
      })
    } else if (runEnd > cursor) {
      items.push({kind: 'run', parts: partsOf(cursor, runEnd, true), tail: []})
    }
    items.push({
      kind: 'drawer',
      id: block.id,
      label: headEnd === undefined,
      parts: partsOf(block.start, block.end, false),
    })
    cursor = block.end < length ? block.end + 1 : block.end
  }
  if (cursor < length) {
    items.push({kind: 'run', parts: partsOf(cursor, length, true), tail: []})
  }
  return {column: true, items}
}

/**
 * The end of the last line in `[start, end)` that is not blank, if any.
 */
function lastFilledLineEnd(
  bytes: Uint8Array,
  start: number,
  end: number,
): number | undefined {
  let lineEnd = end
  for (let b = end - 1; b >= start - 1; b--) {
    if (b === start - 1 || bytes[b] === NEWLINE) {
      const line = decoder.decode(bytes.slice(b + 1, lineEnd))
      if (/\S/u.test(line)) return lineEnd
      lineEnd = b
    }
  }
  return undefined
}

/**
 * Where a caller's `suffix` goes: at the end of the last run, or, when the
 * layout ends with a drawer, in a text of its own after it.
 */
export function suffixInLastRun(layout: SpoilerLayout): boolean {
  return layout.items[layout.items.length - 1]?.kind === 'run'
}
