/*
 * Spoilers from other apps (change list item 2, reversing spoilers design
 * S-3 as an opt-out setting). A post without spoiler facets, written in
 * another app or before Horizon wrote facets, may still use the `||...||`
 * convention. While the account's setting is on, its pairs are parsed here
 * with the one parser (`parse.ts`), as keep-mode marker and spoiler facets
 * added beside the record's own, and drawn by the spoiler renderer.
 *
 * A strict rule keeps ordinary text from being covered (`otherAppSpoilerPairs`):
 * - every marker pairs, and each pair hugs its text: `||x||`, never
 *   `a || b` or `|| x ||`;
 * - a marker is not glued to a word outside it (`a||b||c` is code-like);
 * - no backtick, no `|||`, and at most one spaced `||` or `&&` operator in
 *   the post (code-like text is left alone);
 * - at most `MAX_OTHER_APP_SPOILERS` pairs; a post with more is left alone.
 * A post that fails any part renders as stock, markers visible.
 */

import {type Facet, RichText as RichTextAPI} from '@bsky/sdk/richtext'

import {buildSpoilerRichText} from './build'
import {carryTextMarks} from './cw-line'
import {isSpoilerFeature, isSpoilerMarkerFeature} from './nsid'
import {graphemeBoundaries, parseSpoilers} from './parse'
import {isPostText} from './post-texts'

/** The most spoilers a post from another app may have and still be drawn. */
export const MAX_OTHER_APP_SPOILERS = 5

/** At most this many spaced `||` or `&&` operators in a post. */
const MAX_OPERATORS = 1

const OPERATOR = /(?:^|\s)(?:\|\||&&)(?=\s|$)/gu
const WORD = /[\p{L}\p{N}_]/u
const SPACE = /\s/u

type Marker = {start: number; end: number}

/**
 * The `||` markers of `text`, tokenized as the parser does (left to right,
 * on grapheme boundaries, a `\|` escape skipped).
 */
function markerTokens(text: string): Marker[] {
  const boundaries = graphemeBoundaries(text)
  const markers: Marker[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (
      (char === '\\' || char === '|') &&
      text[i + 1] === '|' &&
      boundaries.has(i) &&
      boundaries.has(i + 2)
    ) {
      if (char === '|') markers.push({start: i, end: i + 2})
      i += 2
    } else {
      i += 1
    }
  }
  return markers
}

/**
 * The marker pairs of `text` under the strict rule, or `undefined` when the
 * text has none or fails the rule (see the file header).
 */
export function otherAppSpoilerPairs(
  text: string,
): [Marker, Marker][] | undefined {
  if (!text.includes('||')) return undefined
  if (text.includes('`') || text.includes('|||')) return undefined
  if ((text.match(OPERATOR) ?? []).length > MAX_OPERATORS) return undefined
  const markers = markerTokens(text)
  if (markers.length === 0 || markers.length % 2 !== 0) return undefined
  if (markers.length / 2 > MAX_OTHER_APP_SPOILERS) return undefined
  const pairs: [Marker, Marker][] = []
  for (let m = 0; m < markers.length; m += 2) {
    const open = markers[m]
    const close = markers[m + 1]
    if (open.end >= close.start) return undefined
    const first = text[open.end]
    const last = text[close.start - 1]
    if (SPACE.test(first) || SPACE.test(last)) return undefined
    const before = open.start > 0 ? text[open.start - 1] : ''
    const after = close.end < text.length ? text[close.end] : ''
    if (WORD.test(before) || WORD.test(after)) return undefined
    pairs.push([open, close])
  }
  return pairs
}

function hasSpoilerFacets(richText: RichTextAPI): boolean {
  return !!richText.facets?.some(
    facet =>
      Array.isArray(facet.features) &&
      facet.features.some(
        f => isSpoilerFeature(f) || isSpoilerMarkerFeature(f),
      ),
  )
}

/** Each text's conversion, so a rendering keeps one object per post text. */
const converted = new WeakMap<RichTextAPI, RichTextAPI | null>()

/**
 * `richText` with marker and spoiler facets added for its `||...||` pairs,
 * or `undefined` when it already has spoiler facets or fails the rule. The
 * record's facets are kept as they are; the renderer drops any a marker or a
 * spoiler edge cuts.
 */
export function otherAppSpoilerText(
  richText: RichTextAPI,
): RichTextAPI | undefined {
  const cached = converted.get(richText)
  if (cached !== undefined) return cached ?? undefined
  const result = convert(richText)
  converted.set(richText, result ?? null)
  return result
}

function convert(richText: RichTextAPI): RichTextAPI | undefined {
  const text = richText.text
  if (hasSpoilerFacets(richText) || !otherAppSpoilerPairs(text)) {
    return undefined
  }
  const parse = parseSpoilers(text, {unescape: false})
  if (parse.spans.length === 0) return undefined
  const built = buildSpoilerRichText(
    parse,
    new RichTextAPI({text: parse.visible}),
    {mode: 'keep', shorten: false},
  )
  // Keep mode without shortening rebuilds the text exactly; anything else
  // would misplace the record's facets.
  if (built.text !== text || !built.facets?.length) return undefined
  const facets: Facet[] = [...(richText.facets ?? []), ...built.facets].sort(
    (x, y) => x.index.byteStart - y.index.byteStart,
  )
  const out = new RichTextAPI({text, facets})
  carryTextMarks(richText, out)
  return out
}

/**
 * The text a post site's `RichText` renders: with spoilers from other apps
 * drawn when `on` (the account's setting) and `richText` is a post's text;
 * otherwise `richText` itself.
 */
export function withOtherAppSpoilers(
  richText: RichTextAPI,
  on: boolean,
): RichTextAPI {
  if (!on || !isPostText(richText)) return richText
  return otherAppSpoilerText(richText) ?? richText
}
