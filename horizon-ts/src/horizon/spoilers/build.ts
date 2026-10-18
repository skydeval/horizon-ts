/*
 * The sync core of the spoiler write pipeline (spoilers design, 5.1 steps 5
 * to 8, and 5.4): from the parse of the writer's text and the facets
 * detected on its visible text, the record's text and facets.
 *
 * Every position here is a UTF-8 byte offset, as facets count.
 */

import {type Facet, RichText, UnicodeString} from '@bsky/sdk/richtext'

import {shortenLinks, stripInvalidMentions} from '#/lib/strings/rich-text-manip'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {spoilerFeature, spoilerMarkerFeature} from './nsid'
import {type SpoilerInsertion, type SpoilerParse} from './parse'

/**
 * `keep`: the markers stay in the text and are written as `#spoilerMarker`
 * facets (public posts, and private posts until prism serves facets).
 * `strip`: the markers leave the text (private posts once prism serves
 * facets).
 */
export type SpoilerWriteMode = 'keep' | 'strip'

type ByteRange = {start: number; end: number}
type BytePoint = {at: number; text: SpoilerInsertion['text']}

function isLinkFacet(facet: Facet): boolean {
  return facet.features.some(f => bsky.isType(app.bsky.richtext.facet.link, f))
}

function linkRanges(rt: RichText): ByteRange[] {
  return (rt.facets ?? [])
    .filter(isLinkFacet)
    .map(f => ({start: f.index.byteStart, end: f.index.byteEnd}))
}

function strictlyInside(point: number, facet: Facet): boolean {
  return facet.index.byteStart < point && point < facet.index.byteEnd
}

/**
 * The record's text and facets for a text with spoilers. `detected` is a
 * `RichText` of `parse.visible` with its facets detected (with or without
 * resolution). `shorten` shortens links as the stock write does; the
 * counter shortens, local detection on served text does not.
 */
export function buildSpoilerRichText(
  parse: SpoilerParse,
  detected: RichText,
  {mode, shorten}: {mode: SpoilerWriteMode; shorten: boolean},
): RichText {
  const visible = new UnicodeString(parse.visible)
  let spans: ByteRange[] = parse.spans.map(span => ({
    start: visible.utf16IndexToUtf8Index(span.start),
    end: visible.utf16IndexToUtf8Index(span.end),
  }))
  let points: BytePoint[] =
    mode === 'keep'
      ? parse.insertions.map(insertion => ({
          at: visible.utf16IndexToUtf8Index(insertion.at),
          text: insertion.text,
        }))
      : []

  // 5. A facet with a spoiler edge (or, keeping markers, a marker) inside it.
  const cuts = [
    ...spans.flatMap(span => [span.start, span.end]),
    ...points.map(point => point.at),
  ]
  let rt = detected.clone()
  if (rt.facets) {
    rt.facets = rt.facets.filter(
      facet => !cuts.some(point => strictlyInside(point, facet)),
    )
  }

  // 6. Shorten links, moving the spoiler positions with them.
  if (shorten) {
    const before = linkRanges(rt)
    const shortened = shortenLinks(rt)
    const after = linkRanges(shortened)
    if (before.length === after.length) {
      const remap = (p: number) => {
        let moved = p
        before.forEach((link, i) => {
          if (link.end <= p) {
            moved += after[i].end - after[i].start - (link.end - link.start)
          }
        })
        return moved
      }
      spans = spans.map(span => ({
        start: remap(span.start),
        end: remap(span.end),
      }))
      points = points.map(point => ({at: remap(point.at), text: point.text}))
      rt = shortened
    }
  }

  // 7. As stock.
  rt = stripInvalidMentions(rt)

  // 8. Lay out the facets.
  const kept = [...(rt.facets ?? [])].sort(
    (x, y) => x.index.byteStart - y.index.byteStart,
  )
  const facets: Facet[] = []
  const pieces: ByteRange[] = []
  for (const facet of kept) {
    const span = spans.find(
      s => s.start <= facet.index.byteStart && facet.index.byteEnd <= s.end,
    )
    facets.push(
      span
        ? {...facet, features: [...facet.features, spoilerFeature()]}
        : facet,
    )
  }
  for (const span of spans) {
    let cursor = span.start
    for (const facet of kept) {
      if (facet.index.byteStart < span.start) continue
      if (facet.index.byteEnd > span.end) continue
      if (facet.index.byteStart > cursor) {
        pieces.push({start: cursor, end: facet.index.byteStart})
      }
      cursor = Math.max(cursor, facet.index.byteEnd)
    }
    if (cursor < span.end) pieces.push({start: cursor, end: span.end})
  }

  if (mode === 'strip') {
    for (const piece of pieces) {
      facets.push(spoilerFacet(piece.start, piece.end))
    }
    return new RichText({text: rt.text, facets: sortFacets(facets)})
  }

  // Keep mode: split pieces at markers, then place the markers.
  const split: ByteRange[] = []
  for (const piece of pieces) {
    let start = piece.start
    for (const point of points) {
      if (point.at > start && point.at < piece.end) {
        split.push({start, end: point.at})
        start = point.at
      }
    }
    split.push({start, end: piece.end})
  }
  const mapStart = (b: number) =>
    b + points.reduce((sum, p) => (p.at <= b ? sum + p.text.length : sum), 0)
  const mapEnd = (b: number) =>
    b + points.reduce((sum, p) => (p.at < b ? sum + p.text.length : sum), 0)

  const placed: Facet[] = facets.map(facet => ({
    ...facet,
    index: {
      ...facet.index,
      byteStart: mapStart(facet.index.byteStart),
      byteEnd: mapEnd(facet.index.byteEnd),
    },
  }))
  for (const piece of split) {
    placed.push(spoilerFacet(mapStart(piece.start), mapEnd(piece.end)))
  }
  let text = ''
  let from = 0
  let added = 0
  for (const point of points) {
    text += rt.unicodeText.slice(from, point.at) + point.text
    placed.push({
      index: {
        byteStart: point.at + added,
        byteEnd: point.at + added + point.text.length,
      },
      features: [spoilerMarkerFeature()],
    })
    added += point.text.length
    from = point.at
  }
  text += rt.unicodeText.slice(from, rt.unicodeText.length)
  return new RichText({text, facets: sortFacets(placed)})
}

function spoilerFacet(byteStart: number, byteEnd: number): Facet {
  return {index: {byteStart, byteEnd}, features: [spoilerFeature()]}
}

function sortFacets(facets: Facet[]): Facet[] {
  return facets.sort((x, y) => x.index.byteStart - y.index.byteStart)
}
