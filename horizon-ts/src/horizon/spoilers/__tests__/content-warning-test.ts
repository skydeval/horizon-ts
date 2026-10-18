import {beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockSpoilerTags = true
let mockContentWarnings = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {
      SPOILER_TAGS: {get: () => mockSpoilerTags, enumerable: true},
      CONTENT_WARNINGS: {get: () => mockContentWarnings, enumerable: true},
    },
  ),
)
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))

import {type Client} from '@atproto/lex'
import {type Facet, RichText} from '@bsky/sdk/richtext'

import {
  type ComposeSpoilers,
  EMPTY_COMPOSE_SPOILERS,
} from '#/horizon/media-spoilers/compose-store'
import {
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {type SpoilerWriteMode} from '../build'
import {
  contentWarningGraphemeLength,
  detectLocalContentWarningFacets,
  normalizeCwLine,
  resolveContentWarningRT,
} from '../content-warning'
import {
  CONTENT_WARNING_FEATURE,
  SPOILER_FEATURE,
  SPOILER_MARKER_FEATURE,
} from '../nsid'
import {graphemeBoundaries} from '../parse'
import {composeGraphemeLength, spoilerWriteMode} from '../write'

const ALICE = 'did:plc:alice'
const READER = 'did:plc:cwreaderaaaaaaaaaaaaaaaa'

const appview = {
  resolve: (handle: string) =>
    Promise.resolve(handle === 'alice.test' ? ALICE : undefined),
} as unknown as Client

function setFacetsServed(on: boolean) {
  resetPrismFeatures()
  answerPrismFeatures(READER, on ? ['private', 'private.embeds'] : ['private'])
}

beforeEach(() => {
  mockSpoilerTags = true
  mockContentWarnings = true
  publishCurrentClients({did: READER} as unknown as CurrentClients)
  setFacetsServed(false)
})

/** A facet as `[byteStart, byteEnd, kind]`. */
type Row = [number, number, string]

function kind(facet: Facet): string {
  const types = facet.features.map(f => (f as {$type?: string}).$type)
  if (types.includes(SPOILER_MARKER_FEATURE)) return 'marker'
  const hidden = types.includes(SPOILER_FEATURE)
  const cw = types.includes(CONTENT_WARNING_FEATURE)
  const other = types
    .filter(
      t =>
        t !== SPOILER_FEATURE &&
        t !== CONTENT_WARNING_FEATURE &&
        t !== SPOILER_MARKER_FEATURE,
    )
    .map(t => t?.split('#')[1])
  return [...other, hidden ? 'spoiler' : '', cw ? 'cw' : '']
    .filter(Boolean)
    .join('+')
}

function rows(rt: RichText): Row[] {
  return (rt.facets ?? []).map(f => [
    f.index.byteStart,
    f.index.byteEnd,
    kind(f),
  ])
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The spoiler design's 5.4 invariants, and grapheme boundaries. */
function checkInvariants(rt: RichText) {
  const bytes = encoder.encode(rt.text)
  const boundaries = new Set(
    [...graphemeBoundaries(rt.text)].map(
      i => encoder.encode(rt.text.slice(0, i)).length,
    ),
  )
  let previous = 0
  for (const facet of rt.facets ?? []) {
    const {byteStart, byteEnd} = facet.index
    expect(byteStart).toBeGreaterThanOrEqual(previous)
    expect(byteEnd).toBeGreaterThan(byteStart)
    expect(boundaries.has(byteStart)).toBe(true)
    expect(boundaries.has(byteEnd)).toBe(true)
    previous = byteEnd
    if (kind(facet) === 'marker') {
      expect(['||', '||\n', '\n||']).toContain(
        decoder.decode(bytes.slice(byteStart, byteEnd)),
      )
    }
    const types = facet.features.map(f => (f as {$type?: string}).$type)
    if (types.includes(CONTENT_WARNING_FEATURE)) {
      expect(types.indexOf(CONTENT_WARNING_FEATURE)).toBe(
        types.indexOf(SPOILER_FEATURE) + 1,
      )
    }
  }
}

async function write(body: string, line: string, mode: SpoilerWriteMode) {
  const rt = await resolveContentWarningRT(
    appview,
    new RichText({text: body}),
    line,
    mode,
  )
  checkInvariants(rt)
  expect(contentWarningGraphemeLength(body, line, mode)).toBe(rt.graphemeLength)
  return rt
}

describe('resolveContentWarningRT (T3)', () => {
  it('C1: a line and a body, keep', async () => {
    const rt = await write('it was a lot', 'cw blood', 'keep')
    expect(rt.text).toBe('cw blood\n||\nit was a lot\n||')
    expect(rows(rt)).toEqual([
      [9, 12, 'marker'],
      [12, 24, 'spoiler+cw'],
      [24, 27, 'marker'],
    ])
    expect(rt.graphemeLength).toBe(27)
  })

  it('C2: a line and a body, strip', async () => {
    const rt = await write('it was a lot', 'cw blood', 'strip')
    expect(rt.text).toBe('cw blood\nit was a lot')
    expect(rows(rt)).toEqual([[9, 21, 'spoiler+cw']])
    expect(rt.graphemeLength).toBe(21)
  })

  it('C3: no line, a body with its own spoiler, keep', async () => {
    const rt = await write('the end: ||he dies||', '', 'keep')
    expect(rt.text).toBe('||\nthe end: ||he dies||\n||')
    expect(rows(rt)).toEqual([
      [0, 3, 'marker'],
      [3, 12, 'spoiler+cw'],
      [12, 14, 'marker'],
      [14, 21, 'spoiler+cw'],
      [21, 23, 'marker'],
      [23, 26, 'marker'],
    ])
    expect(rt.graphemeLength).toBe(26)
  })

  it('C4: no line, a body with its own spoiler, strip', async () => {
    const rt = await write('the end: ||he dies||', '', 'strip')
    expect(rt.text).toBe('the end: he dies')
    expect(rows(rt)).toEqual([[0, 16, 'spoiler+cw']])
    expect(rt.graphemeLength).toBe(16)
  })

  it('C5: a line and no body, either mode', async () => {
    for (const mode of ['keep', 'strip'] as const) {
      const rt = await write('', 'cw', mode)
      expect(rt.text).toBe('cw')
      expect(rt.facets ?? []).toEqual([])
    }
  })

  it('no line and no body gives an empty text', async () => {
    const rt = await write('   ', '', 'keep')
    expect(rt.text).toBe('')
  })

  it('C6: a link in the line is detected, shortened and outside the span', async () => {
    const rt = await write('x', 'see https://example.com', 'strip')
    expect(rt.text).toBe('see example.com\nx')
    expect(rows(rt)).toEqual([
      [4, 15, 'link'],
      [16, 17, 'spoiler+cw'],
    ])
    const keep = await write('x', 'see https://example.com', 'keep')
    expect(keep.text).toBe('see example.com\n||\nx\n||')
  })

  it('a mention in the line is resolved', async () => {
    const rt = await write('x', 'cw @alice.test', 'keep')
    expect(rt.text).toBe('cw @alice.test\n||\nx\n||')
    const mention = rt.facets?.[0]
    expect(mention?.index).toEqual({byteStart: 3, byteEnd: 14})
    expect(mention?.features[0]).toMatchObject({did: ALICE})
  })

  it('a link and a mention in the body carry the spoiler and CW features', async () => {
    const rt = await write('see https://example.com @alice.test', '', 'strip')
    expect(rt.text).toBe('see example.com @alice.test')
    expect(rows(rt)).toEqual([
      [0, 4, 'spoiler+cw'],
      [4, 15, 'link+spoiler+cw'],
      [15, 16, 'spoiler+cw'],
      [16, 27, 'mention+spoiler+cw'],
    ])
  })

  it('the line is literal: || and >! in it are not parsed', async () => {
    const rt = await write('body', 'a || b >!c!<', 'keep')
    expect(rt.text).toBe('a || b >!c!<\n||\nbody\n||')
    expect(rows(rt)).toEqual([
      [13, 16, 'marker'],
      [16, 20, 'spoiler+cw'],
      [20, 23, 'marker'],
    ])
  })

  it('the alias in the body is converted first', async () => {
    const rt = await write('the end: >!he dies!<', '', 'keep')
    expect(rt.text).toBe('||\nthe end: ||he dies||\n||')
  })

  it('escapes in the body stay in keep mode and go in strip mode', async () => {
    expect((await write('a \\|| b', 'cw', 'keep')).text).toBe(
      'cw\n||\na \\|| b\n||',
    )
    expect((await write('a \\|| b', 'cw', 'strip')).text).toBe('cw\na || b')
  })

  it('multi-byte text keeps byte offsets on grapheme boundaries', async () => {
    const rt = await write('caf\u00e9 \u{1F600}', '\u00e9t\u00e9', 'keep')
    expect(rt.text).toBe('\u00e9t\u00e9\n||\ncaf\u00e9 \u{1F600}\n||')
    expect(rows(rt)).toEqual([
      [6, 9, 'marker'],
      [9, 19, 'spoiler+cw'],
      [19, 22, 'marker'],
    ])
  })

  it('a body of several lines is one span', async () => {
    const rt = await write('one\ntwo', 'cw', 'strip')
    expect(rt.text).toBe('cw\none\ntwo')
    expect(rows(rt)).toEqual([[3, 10, 'spoiler+cw']])
  })
})

describe('normalizeCwLine', () => {
  it('turns line breaks and tabs into spaces and trims', () => {
    expect(normalizeCwLine('  cw\r\n\tblood\n\n')).toBe('cw blood')
  })

  it('cuts to 100 graphemes', () => {
    const long = '\u{1F600}'.repeat(101)
    expect(normalizeCwLine(long)).toBe('\u{1F600}'.repeat(100))
  })
})

describe('composeGraphemeLength with a content warning (T3)', () => {
  function snapWith(postId: string, line: string): ComposeSpoilers {
    return {...EMPTY_COMPOSE_SPOILERS, cw: new Map([[postId, {line}]])}
  }
  function post(text: string, id?: string) {
    const richtext = new RichText({text})
    return {id, richtext, shortenedGraphemeLength: richtext.graphemeLength}
  }

  it('C1 counts 27 public and 21 private once facets are served', () => {
    const snap = snapWith('p1', 'cw blood')
    expect(composeGraphemeLength(post('it was a lot', 'p1'), false, snap)).toBe(
      27,
    )
    expect(composeGraphemeLength(post('it was a lot', 'p1'), true, snap)).toBe(
      27,
    )
    setFacetsServed(true)
    expect(spoilerWriteMode(true)).toBe('strip')
    expect(composeGraphemeLength(post('it was a lot', 'p1'), true, snap)).toBe(
      21,
    )
  })

  it('C3 counts 26, C4 16', () => {
    const snap = snapWith('p1', '')
    const text = 'the end: ||he dies||'
    expect(composeGraphemeLength(post(text, 'p1'), false, snap)).toBe(26)
    setFacetsServed(true)
    expect(composeGraphemeLength(post(text, 'p1'), true, snap)).toBe(16)
  })

  it('another post, no id or no snapshot counts as before', () => {
    const snap = snapWith('p1', 'cw blood')
    expect(composeGraphemeLength(post('hello', 'p2'), false, snap)).toBe(5)
    expect(composeGraphemeLength(post('hello'), false, snap)).toBe(5)
    expect(composeGraphemeLength(post('hello', 'p1'), false)).toBe(5)
  })

  it('counts as before with content warnings or spoiler tags off', () => {
    const snap = snapWith('p1', 'cw blood')
    mockContentWarnings = false
    expect(composeGraphemeLength(post('hello', 'p1'), false, snap)).toBe(5)
    mockContentWarnings = true
    mockSpoilerTags = false
    expect(composeGraphemeLength(post('hello', 'p1'), false, snap)).toBe(5)
  })
})

describe('detectLocalContentWarningFacets (T3)', () => {
  async function roundTrip(body: string, line: string) {
    const rt = await resolveContentWarningRT(
      appview,
      new RichText({text: body}),
      line,
      'keep',
    )
    return {rt, local: detectLocalContentWarningFacets(rt.text)}
  }

  it('C1 keep gives back the writer facets', async () => {
    const {rt, local} = await roundTrip('it was a lot', 'cw blood')
    expect(local).toEqual(rt.facets)
  })

  it('C3 keep keeps "he dies" inside the CW span', async () => {
    const {rt, local} = await roundTrip('the end: ||he dies||', '')
    expect(local).toEqual(rt.facets)
    expect(rows(new RichText({text: rt.text, facets: local}))).toContainEqual([
      14,
      21,
      'spoiler+cw',
    ])
  })

  it('a line holding || gives back the writer facets', async () => {
    const {rt, local} = await roundTrip('the body', 'a || b')
    expect(local).toEqual(rt.facets)
  })

  it('a body holding an unpaired || gives back the writer facets', async () => {
    const {rt, local} = await roundTrip('one || two', 'cw')
    expect(local).toEqual(rt.facets)
  })

  it('a body with a link gives back the writer facets', async () => {
    const {rt, local} = await roundTrip('see example.com/x now', 'cw')
    expect(local).toEqual(rt.facets)
    expect(rows(rt)).toContainEqual([10, 23, 'link+spoiler+cw'])
  })

  it('a text without the shape gives undefined', () => {
    expect(detectLocalContentWarningFacets('just text')).toBeUndefined()
    expect(detectLocalContentWarningFacets('a ||b||')).toBeUndefined()
    expect(detectLocalContentWarningFacets('line\nbody\n||')).toBeUndefined()
  })

  it('a shape whose rebuild differs is one hidden facet after the line', () => {
    const text = 'cw\n||\n \n||'
    expect(detectLocalContentWarningFacets(text)).toEqual([
      {
        index: {byteStart: 3, byteEnd: 10},
        features: [{$type: SPOILER_FEATURE}, {$type: CONTENT_WARNING_FEATURE}],
      },
    ])
  })

  it('gives undefined with spoiler tags off', async () => {
    const {rt} = await roundTrip('it was a lot', 'cw blood')
    mockSpoilerTags = false
    expect(detectLocalContentWarningFacets(rt.text)).toBeUndefined()
  })
})
