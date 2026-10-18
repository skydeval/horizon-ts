/*
 * Writing spoilers (spoilers design, 5): the record's text and facets for
 * public and private posts, the write mode, and the composer's count.
 */

import {type Client} from '@atproto/lex'
import {RichText} from '@bsky/sdk/richtext'

import {shortenLinks, stripInvalidMentions} from '#/lib/strings/rich-text-manip'
import {privateFacetsServed} from '#/horizon/private/server-support'
import {SPOILER_TAGS} from '#/horizon/switches'
import {buildSpoilerRichText, type SpoilerWriteMode} from './build'
import {hasSpoilers, parseSpoilers} from './parse'

export {type SpoilerWriteMode} from './build'

/**
 * The stock `resolveRT` hands this post to `resolveSpoilerRT`: the switch is
 * on and its text holds a spoiler.
 */
export function resolvesSpoilers(richtext: RichText): boolean {
  return SPOILER_TAGS && hasSpoilers(richtext.text)
}

/**
 * How a post's spoilers are written. A private post drops its markers once
 * prism serves facets (`private.embeds`, P-1) as answered in this run (a
 * list read from the device never unlocks a write, 2H design 4.7); until
 * then, and for every public post, they stay in the text. The composer's
 * count reads the same, so it matches what is published.
 */
export function spoilerWriteMode(isPrivate: boolean): SpoilerWriteMode {
  return isPrivate && privateFacetsServed({forWrite: true}) ? 'strip' : 'keep'
}

/**
 * The stock `resolveRT` with spoilers: the same trim and newline cleaning,
 * facets detected (and mentions resolved through the AppView) on the text
 * without markers, links shortened, unresolved mentions removed, and the
 * spoilers laid out as facets. With the switch off or no spoiler, the result
 * is the stock one.
 */
export async function resolveSpoilerRT(
  appviewClient: Client,
  richtext: RichText,
  mode: SpoilerWriteMode,
): Promise<RichText> {
  const trimmed = richtext.text
    // As stock: trim leading whitespace-only lines and trailing whitespace.
    .replace(/^(\s*\n)+/, '')
    .trimEnd()
  const cleaned = new RichText({text: trimmed}, {cleanNewlines: true}).text
  const parse = SPOILER_TAGS
    ? parseSpoilers(cleaned, {unescape: mode === 'strip'})
    : undefined

  if (!parse?.spans.length) {
    let rt = new RichText({text: cleaned})
    await rt.detectFacets(appviewClient)
    rt = shortenLinks(rt)
    rt = stripInvalidMentions(rt)
    return rt
  }

  const rt = new RichText({text: parse.visible})
  await rt.detectFacets(appviewClient)
  return buildSpoilerRichText(parse, rt, {mode, shorten: true})
}

/**
 * The length the composer counts and checks for a post: without its markers
 * when they will be stripped, with them when kept, links shortened as stock.
 * With the switch off or no spoiler, the stock stored length.
 */
export function composeGraphemeLength(
  post: {richtext: RichText; shortenedGraphemeLength: number},
  isPrivate: boolean,
): number {
  if (!SPOILER_TAGS || !hasSpoilers(post.richtext.text)) {
    return post.shortenedGraphemeLength
  }
  const mode = spoilerWriteMode(isPrivate)
  const parse = parseSpoilers(post.richtext.text, {unescape: mode === 'strip'})
  const rt = new RichText({text: parse.visible})
  rt.detectFacetsWithoutResolution()
  return buildSpoilerRichText(parse, rt, {mode, shorten: true}).graphemeLength
}
