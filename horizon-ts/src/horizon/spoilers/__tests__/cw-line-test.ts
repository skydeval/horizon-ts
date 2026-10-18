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

import {CW_SELF_LABEL} from '#/horizon/media-spoilers/nsid'
import {type app} from '#/lexicons'
import {detectLocalContentWarningFacets} from '../content-warning'
import {
  contentWarningLineEnd,
  cwLineRunLabel,
  isContentWarningText,
  withContentWarningRecord,
} from '../cw-line'
import {
  buildSpoilerLayout,
  rendersSpoilers,
  type SpoilerLayout,
  type SpoilerPart,
} from '../layout'
import {CONTENT_WARNING_FEATURE, SPOILER_FEATURE} from '../nsid'
import {spoilerSafeText} from '../plain'

i18n.loadAndActivate({locale: 'en', messages: {}})

beforeEach(() => {
  mockContentWarnings = true
})

const encoder = new TextEncoder()

const LABELS = {
  $type: 'com.atproto.label.defs#selfLabels',
  values: [{val: CW_SELF_LABEL}],
}

function record(
  text: string,
  facets?: Facet[],
  labelled = true,
): app.bsky.feed.post.Main {
  return {
    $type: 'app.bsky.feed.post',
    text,
    facets,
    ...(labelled ? {labels: LABELS} : {}),
    createdAt: '2026-10-18T12:00:00.000Z',
  } as app.bsky.feed.post.Main
}

/** The rendering's `RichText`, built from the record as the hooked sites do. */
function fromRecord(r: app.bsky.feed.post.Main): RichText {
  return withContentWarningRecord(
    new RichText({text: r.text, facets: r.facets}),
    r,
  )
}

function facet(start: number, end: number, ...types: string[]): Facet {
  return {
    index: {byteStart: start, byteEnd: end},
    features: types.map(type => ({$type: type})) as Facet['features'],
  }
}

function lines(layout: SpoilerLayout): string[] {
  return layout.items
    .flatMap(item =>
      item.kind === 'run' ? [...item.parts, ...item.tail] : item.parts,
    )
    .filter(
      (p): p is SpoilerPart & {kind: 'plain'} =>
        p.kind === 'plain' && !!p.cwLine,
    )
    .map(p => p.richText.text)
}

const KEEP = 'memery\n||the body||'
/** KEEP as written before the markers hugged the body. */
const KEEP_LINES = 'memery\n||\nthe body\n||'
const STRIP_FACETS = [facet(7, 15, SPOILER_FEATURE, CONTENT_WARNING_FEATURE)]

describe('contentWarningLineEnd', () => {
  const bytes = (s: string) => encoder.encode(s)

  it('a CW span after the line: the line, without its line break', () => {
    expect(
      contentWarningLineEnd(
        bytes('memery\nbody'),
        [{start: 7, end: 11, cw: true}],
        false,
      ),
    ).toBe(6)
  })

  it('a line break flattened to a space still counts', () => {
    expect(
      contentWarningLineEnd(
        bytes('memery body'),
        [{start: 7, end: 11, cw: true}],
        false,
      ),
    ).toBe(6)
  })

  it('no line before the CW span: none', () => {
    expect(
      contentWarningLineEnd(
        bytes('body'),
        [{start: 0, end: 4, cw: true}],
        true,
      ),
    ).toBeUndefined()
  })

  it('a plain spoiler first, or text after the body: none', () => {
    expect(
      contentWarningLineEnd(
        bytes('memery\nbody'),
        [{start: 7, end: 11, cw: false}],
        true,
      ),
    ).toBeUndefined()
    expect(
      contentWarningLineEnd(
        bytes('memery\nbody\nmore'),
        [{start: 7, end: 11, cw: true}],
        false,
      ),
    ).toBeUndefined()
  })

  it('no span: the whole text, only when labelled and one line', () => {
    expect(contentWarningLineEnd(bytes('memery'), [], true)).toBe(6)
    expect(contentWarningLineEnd(bytes('memery'), [], false)).toBeUndefined()
    expect(contentWarningLineEnd(bytes('a\nb'), [], true)).toBeUndefined()
    expect(contentWarningLineEnd(bytes('  '), [], true)).toBeUndefined()
    expect(contentWarningLineEnd(bytes(''), [], true)).toBeUndefined()
  })

  it('counts UTF-8 bytes', () => {
    const cafe = 'caf' + String.fromCodePoint(0xe9)
    expect(contentWarningLineEnd(bytes(cafe), [], true)).toBe(5)
  })
})

describe('the CW line in the layout', () => {
  it('keep mode with facets: the line is its own part', () => {
    const facets = detectLocalContentWarningFacets(KEEP)
    const rt = new RichText({text: KEEP, facets})
    expect(lines(buildSpoilerLayout(rt, {compact: false}))).toEqual(['memery'])
    expect(lines(buildSpoilerLayout(rt, {compact: true}))).toEqual(['memery'])
  })

  it('keep mode in the earlier shape: the same line', () => {
    const facets = detectLocalContentWarningFacets(KEEP_LINES)
    const rt = new RichText({text: KEEP_LINES, facets})
    expect(lines(buildSpoilerLayout(rt, {compact: false}))).toEqual(['memery'])
    expect(lines(buildSpoilerLayout(rt, {compact: true}))).toEqual(['memery'])
  })

  it('strip mode with facets, without the label', () => {
    const rt = new RichText({text: 'memery\nthe body', facets: STRIP_FACETS})
    expect(lines(buildSpoilerLayout(rt, {compact: false}))).toEqual(['memery'])
  })

  it('a line and media only: the label marks it', () => {
    const rt = fromRecord(record('memery'))
    expect(isContentWarningText(rt)).toBe(true)
    expect(rendersSpoilers(rt)).toBe(true)
    const layout = buildSpoilerLayout(rt, {compact: false})
    expect(layout.column).toBe(false)
    expect(lines(layout)).toEqual(['memery'])
  })

  it('the same text without the label renders as stock', () => {
    const rt = fromRecord(record('memery', undefined, false))
    expect(isContentWarningText(rt)).toBe(false)
    expect(rendersSpoilers(rt)).toBe(false)
  })

  it('a part built later is not a CW text', () => {
    const rt = fromRecord(record('memery'))
    const layout = buildSpoilerLayout(rt, {compact: false})
    const item = layout.items[0]
    if (item.kind !== 'run') throw new Error('expected a run')
    expect(isContentWarningText(item.parts[0].richText)).toBe(false)
    expect(rendersSpoilers(item.parts[0].richText)).toBe(false)
  })

  it('a body with no line: no CW line', () => {
    const facets = detectLocalContentWarningFacets('||line one\nline two||')
    const rt = fromRecord(record('||line one\nline two||', facets))
    expect(lines(buildSpoilerLayout(rt, {compact: false}))).toEqual([])
  })

  it('the stored text and facets are unchanged', () => {
    const facets = detectLocalContentWarningFacets(KEEP)
    const r = record(KEEP, facets)
    const rt = fromRecord(r)
    buildSpoilerLayout(rt, {compact: false})
    expect(rt.text).toBe(KEEP)
    expect(rt.facets).toEqual(detectLocalContentWarningFacets(KEEP))
    expect(r.text).toBe(KEEP)
    expect(r.facets).toBe(facets)
  })

  it('with CONTENT_WARNINGS off: no CW line, and a lone line is stock', () => {
    mockContentWarnings = false
    const facets = detectLocalContentWarningFacets(KEEP)
    expect(
      lines(
        buildSpoilerLayout(fromRecord(record(KEEP, facets)), {compact: false}),
      ),
    ).toEqual([])
    expect(rendersSpoilers(fromRecord(record('memery')))).toBe(false)
  })
})

describe('spoilerSafeText', () => {
  it('reads "CW: " before the line', () => {
    const facets = detectLocalContentWarningFacets(KEEP)
    expect(spoilerSafeText(record(KEEP, facets))).toBe(
      'CW: memery\n[content warning]',
    )
    expect(spoilerSafeText(record('memery'))).toBe('CW: memery')
  })

  it('reads the stored text with the switch off or without the label', () => {
    expect(spoilerSafeText(record('memery', undefined, false))).toBe('memery')
    mockContentWarnings = false
    expect(spoilerSafeText(record('memery'))).toBe('memery')
  })
})

describe('cwLineRunLabel', () => {
  const plain = (text: string, cwLine?: boolean) => ({
    kind: 'plain' as const,
    richText: {text},
    cwLine,
  })
  const cover = {kind: 'spoiler' as const, richText: {text: 'the body'}}

  it('reads "Content warning:" and the line', () => {
    expect(
      cwLineRunLabel(
        [plain('memery', true)],
        'Content warning:',
        () => undefined,
      ),
    ).toBe('Content warning: memery')
  })

  it('reads a covered part by its cover name', () => {
    expect(
      cwLineRunLabel(
        [plain('memery', true), plain('\n'), cover],
        'Content warning:',
        p => (p.kind === 'spoiler' ? 'Content warning' : undefined),
      ),
    ).toBe('Content warning: memery Content warning')
  })

  it('none for a run without the line', () => {
    expect(
      cwLineRunLabel([plain('memery')], 'Content warning:', () => undefined),
    ).toBeUndefined()
  })
})
