/*
 * The text of a whole-post content warning (2J design, 4.3): the CW line,
 * then the body as one block spoiler whose facets also carry
 * `#contentWarning`. In keep mode the body sits between an outer `||` pair
 * (each alone on its line) and keeps its own markers; in strip mode no
 * marker is written. The body's own spoilers are subsumed by the CW (5.5).
 *
 * Reading a keep-mode CW without facets (a served private post while prism
 * does not serve them) splits the text by this shape instead of pairing
 * markers, which would pair a `||` in the line or the body with the outer
 * ones and show part of the body.
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
import {parseSpoilers, type SpoilerInsertion, type SpoilerParse} from './parse'

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
 * Steps 3 to 5: the line alone when the body has nothing visible, else the
 * synthetic parse of line and body with one span over the body.
 */
function prepare(line: string, body: string, mode: SpoilerWriteMode): Prepared {
  const pb = parseSpoilers(body, {unescape: mode === 'strip'})
  const vb = pb.visible
  if (!/\S/u.test(vb)) return {kind: 'line', line}
  const prefix = line ? line + '\n' : ''
  const visible = prefix + vb
  const insertions: SpoilerInsertion[] =
    mode === 'keep'
      ? [
          {at: prefix.length, text: '||\n'},
          ...pb.insertions.map(insertion => ({
            at: insertion.at + prefix.length,
            text: insertion.text,
          })),
          {at: visible.length, text: '\n||'},
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

/**
 * Line and body of a keep-mode CW text, split by its shape: it ends with
 * `\n||`, and starts with `||\n` (no line) or has its first line followed
 * by `||\n`. `undefined` for any other text.
 */
function splitKeepModeCw(
  text: string,
): {line: string; body: string} | undefined {
  if (!text.endsWith('\n||')) return undefined
  const end = text.length - 3
  if (text.startsWith('||\n') && 3 <= end) {
    return {line: '', body: text.slice(3, end)}
  }
  const lineEnd = text.indexOf('\n')
  if (lineEnd <= 0) return undefined
  if (!text.startsWith('||\n', lineEnd + 1)) return undefined
  const bodyStart = lineEnd + 4
  if (bodyStart > end) return undefined
  return {line: text.slice(0, lineEnd), body: text.slice(bodyStart, end)}
}

/**
 * Link, hashtag, spoiler and content warning facets for a served private
 * text written in keep mode with a content warning, without network calls
 * and without mentions (as `detectLocalSpoilerFacets`). Returns `undefined`
 * with spoiler tags off or when the text does not have a keep-mode CW's
 * shape. When the shape is there but the rebuild differs from the text, the
 * whole text after the line is one hidden facet (fail closed).
 */
export function detectLocalContentWarningFacets(
  text: string,
): Facet[] | undefined {
  if (!SPOILER_TAGS) return undefined
  const split = splitKeepModeCw(text)
  if (!split) return undefined
  const prepared = prepare(split.line, split.body, 'keep')
  if (prepared.kind === 'block') {
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
  }
  const start = split.line ? new UnicodeString(split.line + '\n').length : 0
  return [
    {
      index: {byteStart: start, byteEnd: new UnicodeString(text).length},
      features: [spoilerFeature(), contentWarningFeature()],
    },
  ]
}
