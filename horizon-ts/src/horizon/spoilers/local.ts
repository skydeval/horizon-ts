/*
 * The spoiler branch of local detection on a served private post that has
 * no facets (spoilers design, 6.1): until prism serves facets (P-1), a
 * private post is written with its markers kept, so the reader parses them.
 */

import {type Facet, RichText, UnicodeString} from '@bsky/sdk/richtext'

import {SPOILER_TAGS} from '#/horizon/switches'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {buildSpoilerRichText} from './build'
import {spoilerFeature} from './nsid'
import {hasSpoilers, parseSpoilers} from './parse'

/**
 * Link, hashtag and spoiler facets for a served private text written in
 * keep mode, without network calls and without mentions (P2 6.1.2). Returns
 * `undefined` with the switch off or when the text has no spoiler, so the
 * caller detects links and hashtags as before.
 */
export function detectLocalSpoilerFacets(text: string): Facet[] | undefined {
  if (!SPOILER_TAGS || !hasSpoilers(text)) return undefined
  const parse = parseSpoilers(text, {unescape: false})
  const detected = new RichText({text: parse.visible})
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
  const built = buildSpoilerRichText(parse, detected, {
    mode: 'keep',
    shorten: false,
  })
  if (built.text !== text) {
    // Never reached: keep mode without shortening rebuilds the text exactly.
    const length = new UnicodeString(text).length
    return [
      {index: {byteStart: 0, byteEnd: length}, features: [spoilerFeature()]},
    ]
  }
  return built.facets
}
