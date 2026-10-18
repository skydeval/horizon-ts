import {beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockContentWarnings = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {CONTENT_WARNINGS: {get: () => mockContentWarnings, enumerable: true}},
  ),
)

import {type Facet, RichText} from '@bsky/sdk/richtext'
import {i18n} from '@lingui/core'

import {type app} from '#/lexicons'
import {detectLocalContentWarningFacets} from '../content-warning'
import {
  buildSpoilerLayout,
  type SpoilerLayout,
  type SpoilerPart,
  visibleSpoilerText,
} from '../layout'
import {
  CONTENT_WARNING_FEATURE,
  isContentWarningFeature,
  SPOILER_FEATURE,
} from '../nsid'
import {spoilerSafeText} from '../plain'

i18n.loadAndActivate({locale: 'en', messages: {}})

beforeEach(() => {
  mockContentWarnings = true
})

/** A keep-mode CW text with the facets its writer stores. */
function keep(text: string): RichText {
  const facets = detectLocalContentWarningFacets(text)
  if (!facets) throw new Error('not a CW text')
  return new RichText({text, facets})
}

function facet(start: number, end: number, ...types: string[]): Facet {
  return {
    index: {byteStart: start, byteEnd: end},
    features: types.map(type => ({$type: type})) as Facet['features'],
  }
}

const C1 = 'cw blood\n||\nit was a lot\n||'
const C2 = new RichText({
  text: 'cw blood\nit was a lot',
  facets: [facet(9, 21, SPOILER_FEATURE, CONTENT_WARNING_FEATURE)],
})
const C3 = '||\nthe end: ||he dies||\n||'
const C4 = new RichText({
  text: 'the end: he dies',
  facets: [facet(0, 16, SPOILER_FEATURE, CONTENT_WARNING_FEATURE)],
})

function part(p: SpoilerPart) {
  return p.kind === 'plain'
    ? {plain: p.richText.text}
    : {spoiler: p.richText.text, cw: p.cw}
}

function summary(layout: SpoilerLayout) {
  return layout.items.map(item =>
    item.kind === 'run'
      ? {
          run: item.parts.map(part),
          arrowFor: item.arrowFor,
          tail: item.tail.map(part),
        }
      : {
          drawer: item.parts.map(part),
          id: item.id,
          label: item.label,
          cw: item.cw,
        },
  )
}

function allParts(layout: SpoilerLayout): SpoilerPart[] {
  return layout.items.flatMap(item =>
    item.kind === 'run' ? [...item.parts, ...item.tail] : item.parts,
  )
}

describe('CW layout (T6)', () => {
  const lineAndBody = [
    {
      run: [{plain: 'cw blood'}],
      arrowFor: 0,
      tail: [],
    },
    {drawer: [{plain: 'it was a lot'}], id: 0, label: false, cw: true},
  ]

  it('C1 keep: the line with an arrow, then a CW drawer', () => {
    const layout = buildSpoilerLayout(keep(C1), {compact: false})
    expect(layout.column).toBe(true)
    expect(summary(layout)).toEqual(lineAndBody)
  })

  it('C2 strip: the same', () => {
    expect(summary(buildSpoilerLayout(C2, {compact: false}))).toEqual(
      lineAndBody,
    )
  })

  it('a two-line body with no line: a "Content warning" label row', () => {
    const layout = buildSpoilerLayout(keep('||\nline one\nline two\n||'), {
      compact: false,
    })
    expect(summary(layout)).toEqual([
      {
        drawer: [{plain: 'line one\nline two'}],
        id: 0,
        label: true,
        cw: true,
      },
    ])
  })

  it('C3 keep and C4 strip: one inline CW cover over the whole body', () => {
    const expected = [
      {run: [{spoiler: 'the end: he dies', cw: true}], tail: []},
    ]
    expect(summary(buildSpoilerLayout(keep(C3), {compact: false}))).toEqual(
      expected,
    )
    expect(summary(buildSpoilerLayout(C4, {compact: false}))).toEqual(expected)
  })

  it('compact and flattened C1: an inline CW cover, no marker drawn', () => {
    const compact = buildSpoilerLayout(keep(C1), {compact: true})
    expect(summary(compact)).toEqual([
      {
        // The CW line is a part of its own (2J follow-up, cw-line-test.ts).
        run: [
          {plain: 'cw blood'},
          {plain: '\n'},
          {spoiler: 'it was a lot', cw: true},
        ],
        tail: [],
      },
    ])
    const written = keep(C1)
    const flattened = new RichText({
      text: written.text.replace(/\n/g, ' '),
      facets: written.facets,
    })
    const layout = buildSpoilerLayout(flattened, {compact: false})
    expect(layout.column).toBe(false)
    const drawn = allParts(layout).map(p => p.richText.text)
    expect(drawn.join('')).not.toContain('||')
    expect(allParts(layout).some(p => p.kind === 'spoiler' && p.cw)).toBe(true)
  })

  it('facets from a pre-2J writer (spoiler only) give no CW', () => {
    const old = new RichText({
      text: 'cw blood\nit was a lot',
      facets: [facet(9, 21, SPOILER_FEATURE)],
    })
    const layout = buildSpoilerLayout(old, {compact: false})
    expect(layout.items[1]).toMatchObject({kind: 'drawer', cw: false})
  })

  it('#contentWarning never survives onto a rendered facet', () => {
    const text = 'see example.com\n||\nx #tag example.com\n||'
    const written = keep(text)
    expect(
      written.facets?.some(f => f.features.some(isContentWarningFeature)),
    ).toBe(true)
    const {facets} = visibleSpoilerText(written)
    expect(facets.some(f => f.features.some(isContentWarningFeature))).toBe(
      false,
    )
    for (const layout of [
      buildSpoilerLayout(written, {compact: false}),
      buildSpoilerLayout(written, {compact: true}),
    ]) {
      for (const p of allParts(layout)) {
        expect(
          (p.richText.facets ?? []).some(f =>
            f.features.some(isContentWarningFeature),
          ),
        ).toBe(false)
      }
    }
  })

  it('with CONTENT_WARNINGS off a CW body is one plain spoiler', () => {
    mockContentWarnings = false
    const layout = buildSpoilerLayout(keep(C1), {compact: false})
    expect(layout.items[1]).toMatchObject({kind: 'drawer', cw: false})
    expect(
      allParts(buildSpoilerLayout(keep(C3), {compact: false})),
    ).toMatchObject([{kind: 'spoiler', cw: false}])
  })

  it('spoilerSafeText of C1 names the content warning', () => {
    const written = keep(C1)
    const record = {
      $type: 'app.bsky.feed.post',
      text: written.text,
      facets: written.facets,
      createdAt: '2026-10-18T12:00:00.000Z',
    } as app.bsky.feed.post.Main
    expect(spoilerSafeText(record)).toBe('CW: cw blood\n[content warning]')
    mockContentWarnings = false
    expect(spoilerSafeText(record)).toBe('cw blood\n[spoiler]')
  })
})
