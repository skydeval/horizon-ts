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
  it('C1: a line and a body, keep: the markers hug the body', async () => {
    const rt = await write('it was a lot', 'cw blood', 'keep')
    expect(rt.text).toBe('cw blood\n||it was a lot||')
    expect(rows(rt)).toEqual([
      [9, 11, 'marker'],
      [11, 23, 'spoiler+cw'],
      [23, 25, 'marker'],
    ])
    expect(rt.graphemeLength).toBe(25)
  })

  it('the reported post: "memes be here" and "spoiler memes"', async () => {
    const keep = await write('spoiler memes', 'memes be here', 'keep')
    expect(keep.text).toBe('memes be here\n||spoiler memes||')
    expect(rows(keep)).toEqual([
      [14, 16, 'marker'],
      [16, 29, 'spoiler+cw'],
      [29, 31, 'marker'],
    ])
    const strip = await write('spoiler memes', 'memes be here', 'strip')
    expect(strip.text).toBe('memes be here\nspoiler memes')
    expect(rows(strip)).toEqual([[14, 27, 'spoiler+cw']])
  })

  it('a body of several lines, with and without a line, keep', async () => {
    expect((await write('first line\nsecond line', 'line', 'keep')).text).toBe(
      'line\n||first line\nsecond line||',
    )
    expect((await write('body', '', 'keep')).text).toBe('||body||')
  })

  it('blank lines before the body and line breaks after it are dropped', async () => {
    const rt = await write('\n \n\nbody\n\n', 'cw', 'keep')
    expect(rt.text).toBe('cw\n||body||')
    expect((await write('\n \n\nbody\n\n', 'cw', 'strip')).text).toBe(
      'cw\nbody',
    )
  })

  it('a body that is its own block spoiler keeps its markers inside', async () => {
    const rt = await write('||\nsecret\n||', 'cw', 'keep')
    expect(rt.text).toBe('cw\n||||\nsecret\n||||')
    expect(rows(rt)).toEqual([
      [3, 5, 'marker'],
      [5, 8, 'marker'],
      [8, 14, 'spoiler+cw'],
      [14, 17, 'marker'],
      [17, 19, 'marker'],
    ])
  })

  it('a body the markers cannot hug keeps them on their own lines', async () => {
    // A combining mark would join the opening `|` into one grapheme.
    const combining = await write('\u0301x', 'cw', 'keep')
    expect(combining.text).toBe('cw\n||\n\u0301x\n||')
    // A closing `\` would escape the closing marker for a pairing reader.
    const backslash = await write('a \\', 'cw', 'keep')
    expect(backslash.text).toBe('cw\n||\na \\\n||')
    expect(rows(backslash)).toEqual([
      [3, 6, 'marker'],
      [6, 9, 'spoiler+cw'],
      [9, 12, 'marker'],
    ])
  })

  it('C2: a line and a body, strip', async () => {
    const rt = await write('it was a lot', 'cw blood', 'strip')
    expect(rt.text).toBe('cw blood\nit was a lot')
    expect(rows(rt)).toEqual([[9, 21, 'spoiler+cw']])
    expect(rt.graphemeLength).toBe(21)
  })

  it('C3: no line, a body with its own spoiler, keep', async () => {
    const rt = await write('the end: ||he dies||', '', 'keep')
    expect(rt.text).toBe('||the end: ||he dies||||')
    expect(rows(rt)).toEqual([
      [0, 2, 'marker'],
      [2, 11, 'spoiler+cw'],
      [11, 13, 'marker'],
      [13, 20, 'spoiler+cw'],
      [20, 22, 'marker'],
      [22, 24, 'marker'],
    ])
    expect(rt.graphemeLength).toBe(24)
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
    expect(keep.text).toBe('see example.com\n||x||')
  })

  it('a mention in the line is resolved', async () => {
    const rt = await write('x', 'cw @alice.test', 'keep')
    expect(rt.text).toBe('cw @alice.test\n||x||')
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
    expect(rt.text).toBe('a || b >!c!<\n||body||')
    expect(rows(rt)).toEqual([
      [13, 15, 'marker'],
      [15, 19, 'spoiler+cw'],
      [19, 21, 'marker'],
    ])
  })

  it('the alias in the body is converted first', async () => {
    const rt = await write('the end: >!he dies!<', '', 'keep')
    expect(rt.text).toBe('||the end: ||he dies||||')
  })

  it('escapes in the body stay in keep mode and go in strip mode', async () => {
    expect((await write('a \\|| b', 'cw', 'keep')).text).toBe(
      'cw\n||a \\|| b||',
    )
    expect((await write('a \\|| b', 'cw', 'strip')).text).toBe('cw\na || b')
  })

  it('multi-byte text keeps byte offsets on grapheme boundaries', async () => {
    const rt = await write('caf\u00e9 \u{1F600}', '\u00e9t\u00e9', 'keep')
    expect(rt.text).toBe('\u00e9t\u00e9\n||caf\u00e9 \u{1F600}||')
    expect(rows(rt)).toEqual([
      [6, 8, 'marker'],
      [8, 18, 'spoiler+cw'],
      [18, 20, 'marker'],
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

  it('C1 counts 25 public and 21 private once facets are served', () => {
    const snap = snapWith('p1', 'cw blood')
    expect(composeGraphemeLength(post('it was a lot', 'p1'), false, snap)).toBe(
      25,
    )
    expect(composeGraphemeLength(post('it was a lot', 'p1'), true, snap)).toBe(
      25,
    )
    setFacetsServed(true)
    expect(spoilerWriteMode(true)).toBe('strip')
    expect(composeGraphemeLength(post('it was a lot', 'p1'), true, snap)).toBe(
      21,
    )
  })

  it('C3 counts 24, C4 16', () => {
    const snap = snapWith('p1', '')
    const text = 'the end: ||he dies||'
    expect(composeGraphemeLength(post(text, 'p1'), false, snap)).toBe(24)
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
      13,
      20,
      'spoiler+cw',
    ])
  })

  it('the bodies the markers cannot hug give back the writer facets', async () => {
    for (const body of ['\u0301x', 'a \\', '||\nsecret\n||', '||x|| y ||z||']) {
      const {rt, local} = await roundTrip(body, 'cw')
      expect(local).toEqual(rt.facets)
    }
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
    expect(rows(rt)).toContainEqual([9, 22, 'link+spoiler+cw'])
  })

  /*
   * Posts written before the markers hugged the body (each alone on its
   * line) are still read by shape, with the facets their writer stored.
   */
  it('the earlier shape: C1, C3 and a line holding ||', () => {
    const c1 = detectLocalContentWarningFacets('cw blood\n||\nit was a lot\n||')
    expect(rows(new RichText({text: '', facets: c1}))).toEqual([
      [9, 12, 'marker'],
      [12, 24, 'spoiler+cw'],
      [24, 27, 'marker'],
    ])
    const c3 = detectLocalContentWarningFacets('||\nthe end: ||he dies||\n||')
    expect(rows(new RichText({text: '', facets: c3}))).toEqual([
      [0, 3, 'marker'],
      [3, 12, 'spoiler+cw'],
      [12, 14, 'marker'],
      [14, 21, 'spoiler+cw'],
      [21, 23, 'marker'],
      [23, 26, 'marker'],
    ])
    const line = detectLocalContentWarningFacets('a || b\n||\nthe body\n||')
    expect(rows(new RichText({text: '', facets: line}))).toEqual([
      [7, 10, 'marker'],
      [10, 18, 'spoiler+cw'],
      [18, 21, 'marker'],
    ])
  })

  it('a line starting with || reads as part of the body (more hidden)', () => {
    const text = '||x\n||body||'
    expect(detectLocalContentWarningFacets(text)).toEqual([
      {
        index: {byteStart: 0, byteEnd: 2},
        features: [{$type: SPOILER_MARKER_FEATURE}],
      },
      {
        index: {byteStart: 2, byteEnd: 10},
        features: [{$type: SPOILER_FEATURE}, {$type: CONTENT_WARNING_FEATURE}],
      },
      {
        index: {byteStart: 10, byteEnd: 12},
        features: [{$type: SPOILER_MARKER_FEATURE}],
      },
    ])
  })

  it('a text without the shape gives undefined', () => {
    expect(detectLocalContentWarningFacets('just text')).toBeUndefined()
    expect(detectLocalContentWarningFacets('a ||b||')).toBeUndefined()
    expect(detectLocalContentWarningFacets('line\nbody\n||')).toBeUndefined()
    expect(detectLocalContentWarningFacets('cw\n||a||b')).toBeUndefined()
    expect(detectLocalContentWarningFacets('cw\nthe ||body||')).toBeUndefined()
  })

  it('a shape whose rebuild differs is one hidden facet after the line', () => {
    const hidden = (byteStart: number, byteEnd: number) => [
      {
        index: {byteStart, byteEnd},
        features: [{$type: SPOILER_FEATURE}, {$type: CONTENT_WARNING_FEATURE}],
      },
    ]
    expect(detectLocalContentWarningFacets('cw\n||\n \n||')).toEqual(
      hidden(3, 10),
    )
    expect(detectLocalContentWarningFacets('cw\n|| ||')).toEqual(hidden(3, 8))
    expect(detectLocalContentWarningFacets('||||')).toEqual(hidden(0, 4))
  })

  it('gives undefined with spoiler tags off', async () => {
    const {rt} = await roundTrip('it was a lot', 'cw blood')
    mockSpoilerTags = false
    expect(detectLocalContentWarningFacets(rt.text)).toBeUndefined()
  })
})
