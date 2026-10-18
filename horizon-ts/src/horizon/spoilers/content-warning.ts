/*
 * The text of a whole-post content warning (2J design, 4.3): the CW line,
 * then the body as one block spoiler whose facets also carry
 * `#contentWarning`. In keep mode the body sits between an outer `||` pair
 * wrapped straight around it (`line\n||body||`, so other clients show an
 * ordinary spoiler) and keeps its own markers; in strip mode no marker is
 * written. The body's own spoilers are subsumed by the CW (5.5).
 *
 * Reading a keep-mode CW without facets (a served private post while prism
 * does not serve them) splits the text by this shape, or by the earlier one
 * with each outer marker alone on its line, instead of pairing markers,
 * which would pair a `||` in the line or the body with the outer ones and
 * show part of the body.
 *
 * Positions are UTF-16 code units unless stated.
 */

import {type Client} from '@atproto/lex'
import {type Facet, RichText, UnicodeString} from '@bsky/sdk/richtext'
import {splitGraphemes} from 'unicode-segmenter/grapheme'

import {shortenLinks, stripInvalidMentions} from '#/lib/strings/rich-text-manip'
import {SPOILER_TAGS} from '#/horizon/switches'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {convertAltSpoilers} from './alias'
import {buildSpoilerRichText, type SpoilerWriteMode} from './build'
import {contentWarningFeature, spoilerFeature} from './nsid'
import {
  graphemeBoundaries,
  parseSpoilers,
  type SpoilerInsertion,
  type SpoilerParse,
} from './parse'

/**
 * The CW line's limit (MS-11).
 */
export const CW_LINE_MAX_GRAPHEMES = 100

/**
 * The first `max` graphemes of `text`.
 */
export function cutGraphemes(text: string, max: number): string {
  let out = ''
  let count = 0
  for (const grapheme of splitGraphemes(text)) {
    if (count >= max) break
    out += grapheme
    count++
  }
  return out
}

/**
 * The CW line as written: each run of line breaks and tabs becomes one
 * space, the ends are trimmed, and it is cut to the limit. The line is
 * literal; markers and escapes in it are not parsed.
 */
export function normalizeCwLine(line: string): string {
  return cutGraphemes(
    line.replace(/[\r\n\t]+/g, ' ').trim(),
    CW_LINE_MAX_GRAPHEMES,
  )
}

/**
 * The body as the stock write cleans it (as `resolveSpoilerRT`): leading
 * whitespace-only lines and trailing whitespace trimmed, `>!...!<` converted,
 * newlines cleaned.
 */
function cleanBody(text: string): string {
  const trimmed = text.replace(/^(\s*\n)+/, '').trimEnd()
  return new RichText(
    {text: convertAltSpoilers(trimmed)},
    {cleanNewlines: true},
  ).text
}

type Prepared =
  {kind: 'line'; line: string} | {kind: 'block'; parse: SpoilerParse}

/**
 * Where the outer markers of a keep-mode CW sit. `hug`: around the body,
 * `||body||`, as an ordinary spoiler reads in other clients (what Horizon
 * writes). `lines`: each alone on its line, `||\nbody\n||` (what Horizon
 * wrote before, and still writes for a body `hug` would break, see
 * `keepShape`). Both are a block in Horizon: the body fills whole lines of
 * the visible text.
 */
type CwShape = 'hug' | 'lines'

const OUTER_MARKERS: Record<
  CwShape,
  {open: SpoilerInsertion['text']; close: SpoilerInsertion['text']}
> = {
  hug: {open: '||', close: '||'},
  lines: {open: '||\n', close: '\n||'},
}

/**
 * The shape the writer uses for a keep-mode body (the text between the
 * outer markers, its own markers and escapes kept). `hug` unless the outer
 * markers would not stand alone: a body starting with a mark that joins the
 * `|` before it into one grapheme, or ending with one that joins the `|`
 * after it (a marker must sit on grapheme boundaries, spoilers design 4.1),
 * or ending with `\`, which would read the closing `||` as an escape for a
 * reader that pairs markers.
 */
function keepShape(body: string): CwShape {
  const boundaries = graphemeBoundaries('||' + body + '||')
  if (!boundaries.has(2) || !boundaries.has(body.length + 2)) return 'lines'
  if (body.endsWith('\\')) return 'lines'
  return 'hug'
}

/**
 * Steps 3 to 5: the line alone when the body has nothing visible, else the
 * synthetic parse of line and body with one span over the body. `shape`
 * places the outer markers in keep mode; by default the writer's choice.
 */
function prepare(
  line: string,
  body: string,
  mode: SpoilerWriteMode,
  shape: CwShape = keepShape(body),
): Prepared {
  const pb = parseSpoilers(body, {unescape: mode === 'strip'})
  const vb = pb.visible
  if (!/\S/u.test(vb)) return {kind: 'line', line}
  const prefix = line ? line + '\n' : ''
  const visible = prefix + vb
  const {open, close} = OUTER_MARKERS[shape]
  const insertions: SpoilerInsertion[] =
    mode === 'keep'
      ? [
          {at: prefix.length, text: open},
          ...pb.insertions.map(insertion => ({
            at: insertion.at + prefix.length,
            text: insertion.text,
          })),
          {at: visible.length, text: close},
        ]
      : []
  return {
    kind: 'block',
    parse: {
      visible,
      spans: [{start: prefix.length, end: visible.length}],
      insertions,
    },
  }
}

/**
 * The record's text and facets for a post with a content warning, as
 * `resolveSpoilerRT` gives them for spoilers: facets detected (mentions
 * resolved through the AppView) on the visible text, links shortened,
 * unresolved mentions removed.
 */
export async function resolveContentWarningRT(
  appviewClient: Client,
  richtext: RichText,
  line: string,
  mode: SpoilerWriteMode,
): Promise<RichText> {
  const prepared = prepare(
    normalizeCwLine(line),
    cleanBody(richtext.text),
    mode,
  )
  if (prepared.kind === 'line') {
    let rt = new RichText({text: prepared.line})
    await rt.detectFacets(appviewClient)
    rt = shortenLinks(rt)
    rt = stripInvalidMentions(rt)
    return rt
  }
  const rt = new RichText({text: prepared.parse.visible})
  await rt.detectFacets(appviewClient)
  return buildSpoilerRichText(prepared.parse, rt, {
    mode,
    shorten: true,
    contentWarning: true,
  })
}

/**
 * The grapheme length of the text `resolveContentWarningRT` would store,
 * without network calls (the composer's count, 4.8).
 */
export function contentWarningGraphemeLength(
  text: string,
  line: string,
  mode: SpoilerWriteMode,
): number {
  const prepared = prepare(normalizeCwLine(line), cleanBody(text), mode)
  if (prepared.kind === 'line') {
    const rt = new RichText({text: prepared.line})
    rt.detectFacetsWithoutResolution()
    return shortenLinks(rt).graphemeLength
  }
  const rt = new RichText({text: prepared.parse.visible})
  rt.detectFacetsWithoutResolution()
  return buildSpoilerRichText(prepared.parse, rt, {
    mode,
    shorten: true,
    contentWarning: true,
  }).graphemeLength
}

type CwSplit = {line: string; body: string; shape: CwShape}

/**
 * The ways a keep-mode CW text splits into line and body by its shape, most
 * hidden first. A shape's outer markers open the text (no line) or follow
 * its first line and its `\n`, and close it; the body is what lies between.
 * Both shapes are read, `hug` (written now) and `lines` (posts written
 * before). No line comes first, so a line that itself starts with `||`
 * reads as part of the body; `lines` before `hug` for the same line, so an
 * old post reads as it was written. Empty for any other text.
 */
function splitKeepModeCw(text: string): CwSplit[] {
  const shapes: CwShape[] = ['lines', 'hug']
  const lineEnd = text.indexOf('\n')
  const starts = lineEnd > 0 ? [0, lineEnd + 1] : [0]
  const splits: CwSplit[] = []
  for (const start of starts) {
    for (const shape of shapes) {
      const {open, close} = OUTER_MARKERS[shape]
      const bodyStart = start + open.length
      const bodyEnd = text.length - close.length
      if (bodyStart > bodyEnd) continue
      if (!text.startsWith(open, start) || !text.endsWith(close)) continue
      splits.push({
        line: start ? text.slice(0, lineEnd) : '',
        body: text.slice(bodyStart, bodyEnd),
        shape,
      })
    }
  }
  return splits
}

/**
 * The facets of a split rebuilt as the writer would write them, when the
 * rebuild is exactly `text`; `undefined` otherwise.
 */
function rebuildKeepModeCw(text: string, split: CwSplit): Facet[] | undefined {
  const prepared = prepare(split.line, split.body, 'keep', split.shape)
  if (prepared.kind !== 'block') return undefined
  const detected = new RichText({text: prepared.parse.visible})
  detected.detectFacetsWithoutResolution()
  const facets: Facet[] = []
  for (const facet of detected.facets ?? []) {
    const features = facet.features.filter(
      f =>
        bsky.isType(app.bsky.richtext.facet.link, f) ||
        bsky.isType(app.bsky.richtext.facet.tag, f),
    )
    if (features.length) facets.push({index: facet.index, features})
  }
  detected.facets = facets.length ? facets : undefined
  const built = buildSpoilerRichText(prepared.parse, detected, {
    mode: 'keep',
    shorten: false,
    contentWarning: true,
  })
  if (built.text === text && built.facets?.length) return built.facets
  return undefined
}

/**
 * Link, hashtag, spoiler and content warning facets for a served private
 * text written in keep mode with a content warning, without network calls
 * and without mentions (as `detectLocalSpoilerFacets`). Splits by shape,
 * never by pairing markers, so a `||` in the line or the body cannot pair
 * with an outer marker. Returns `undefined` with spoiler tags off or when
 * the text has neither keep-mode CW shape. When a shape is there but no
 * rebuild matches the text, the whole text after the line (of the most
 * hidden split) is one hidden facet (fail closed).
 */
export function detectLocalContentWarningFacets(
  text: string,
): Facet[] | undefined {
  if (!SPOILER_TAGS) return undefined
  const splits = splitKeepModeCw(text)
  if (!splits.length) return undefined
  for (const split of splits) {
    const facets = rebuildKeepModeCw(text, split)
    if (facets) return facets
  }
  const split = splits[0]
  const start = split.line ? new UnicodeString(split.line + '\n').length : 0
  return [
    {
      index: {byteStart: start, byteEnd: new UnicodeString(text).length},
      features: [spoilerFeature(), contentWarningFeature()],
    },
  ]
}
