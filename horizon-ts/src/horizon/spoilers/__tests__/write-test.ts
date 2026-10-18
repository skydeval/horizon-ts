import {beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockSpoilerTags = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {SPOILER_TAGS: {get: () => mockSpoilerTags, enumerable: true}},
  ),
)
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))

// The stock `resolveRT`'s module, with its heavy collaborators replaced.
jest.mock('#/horizon/private/api/writes', () => ({postPrivate: jest.fn()}))
jest.mock('#/state/gallery', () => ({compressImage: jest.fn()}))
jest.mock('#/state/queries/resolve-link', () => ({
  fetchResolveGifQuery: jest.fn(),
  fetchResolveLinkQuery: jest.fn(),
}))
jest.mock('#/state/queries/threadgate', () => ({
  createThreadgateRecord: jest.fn(),
  threadgateAllowUISettingToAllowRecordValue: jest.fn(),
}))
jest.mock('#/lib/at-card', () => ({withCreator: jest.fn()}))
jest.mock('#/lib/api/upload-blob', () => ({uploadBlob: jest.fn()}))

import {type Client} from '@atproto/lex'
import {RichText} from '@bsky/sdk/richtext'
import {splitGraphemes} from 'unicode-segmenter/grapheme'

import {resolveRT} from '#/lib/api/index'
import {
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  loadPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {buildSpoilerRichText} from '../build'
import {SPOILER_FEATURE, SPOILER_MARKER_FEATURE} from '../nsid'
import {parseSpoilers} from '../parse'
import {
  composeGraphemeLength,
  resolveSpoilerRT,
  resolvesSpoilers,
  spoilerWriteMode,
} from '../write'

const ALICE = 'did:plc:alice'
const READER = 'did:plc:spoilerreaderaaaaaaaaaaa'

/** prism's `private.embeds` answered in this run, or not listed. */
function setFacetsServed(on: boolean) {
  resetPrismFeatures()
  answerPrismFeatures(READER, on ? ['private', 'private.embeds'] : ['private'])
}

/**
 * A handle resolver in place of the AppView client: `alice.test` resolves,
 * nothing else does.
 */
const appview = {
  resolve: (handle: string) =>
    Promise.resolve(handle === 'alice.test' ? ALICE : undefined),
} as unknown as Client

beforeEach(() => {
  mockSpoilerTags = true
  publishCurrentClients({did: READER} as unknown as CurrentClients)
  setFacetsServed(false)
})

const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length

/** `[start, end, ...feature types]` per facet. */
function summary(rt: RichText) {
  return (rt.facets ?? []).map(f => [
    f.index.byteStart,
    f.index.byteEnd,
    ...f.features.map(x => (x as {$type: string}).$type),
  ])
}

const SP = SPOILER_FEATURE
const MK = SPOILER_MARKER_FEATURE

/**
 * Section 5.4 item 3: sorted, non-overlapping, non-empty facets; the ends of
 * every spoiler piece and marker on grapheme boundaries of the stored text;
 * no marker in strip mode.
 */
function expectLayoutInvariants(rt: RichText, mode: 'keep' | 'strip') {
  const boundaries = new Set<number>([0])
  let at = 0
  for (const g of splitGraphemes(rt.text)) {
    at += bytes(g)
    boundaries.add(at)
  }
  let previousEnd = 0
  for (const facet of rt.facets ?? []) {
    const {byteStart, byteEnd} = facet.index
    expect(byteStart).toBeLessThan(byteEnd)
    expect(byteStart).toBeGreaterThanOrEqual(previousEnd)
    previousEnd = byteEnd
    const types = facet.features.map(x => (x as {$type: string}).$type)
    if (types.length === 1 && (types[0] === SP || types[0] === MK)) {
      expect(boundaries.has(byteStart)).toBe(true)
      expect(boundaries.has(byteEnd)).toBe(true)
    }
    if (mode === 'strip') expect(types).not.toContain(MK)
    if (types.includes(MK)) {
      expect(['||', '||\n', '\n||']).toContain(
        rt.unicodeText.slice(byteStart, byteEnd),
      )
    }
  }
}

async function both(text: string) {
  const keep = await resolveSpoilerRT(appview, new RichText({text}), 'keep')
  const strip = await resolveSpoilerRT(appview, new RichText({text}), 'strip')
  expectLayoutInvariants(keep, 'keep')
  expectLayoutInvariants(strip, 'strip')
  return {keep, strip}
}

describe('resolveSpoilerRT (T2)', () => {
  it('example 1', async () => {
    const {keep, strip} = await both('a ||b|| c')
    expect(keep.text).toBe('a ||b|| c')
    expect(summary(keep)).toEqual([
      [2, 4, MK],
      [4, 5, SP],
      [5, 7, MK],
    ])
    expect(strip.text).toBe('a b c')
    expect(summary(strip)).toEqual([[2, 3, SP]])
  })

  it('example 10', async () => {
    const text = 'Intro\n||\nSecret line\n||\nOutro'
    const {keep, strip} = await both(text)
    expect(keep.text).toBe(text)
    expect(summary(keep)).toEqual([
      [6, 9, MK],
      [9, 20, SP],
      [20, 23, MK],
    ])
    expect(strip.text).toBe('Intro\nSecret line\nOutro')
    expect(summary(strip)).toEqual([[6, 17, SP]])
  })

  it('example 13', async () => {
    const {keep, strip} = await both('||a||||b||')
    expect(summary(keep)).toEqual([
      [0, 2, MK],
      [2, 3, SP],
      [3, 5, MK],
      [5, 7, MK],
      [7, 8, SP],
      [8, 10, MK],
    ])
    expect(strip.text).toBe('ab')
    expect(summary(strip)).toEqual([[0, 2, SP]])
  })

  it('example 14', async () => {
    const {keep, strip} = await both('||a\\|\\|b||')
    expect(keep.text).toBe('||a\\|\\|b||')
    expect(summary(keep)).toEqual([
      [0, 2, MK],
      [2, 8, SP],
      [8, 10, MK],
    ])
    expect(strip.text).toBe('a||b')
    expect(summary(strip)).toEqual([[0, 4, SP]])
  })

  it('example 15a', async () => {
    const text = '\u{1F1FA}||\u{1F1F8}||'
    const {keep, strip} = await both(text)
    expect(keep.text).toBe(text)
    expect(summary(keep)).toEqual([
      [0, 4, SP],
      [4, 6, MK],
      [6, 10, SP],
      [10, 12, MK],
    ])
    expect(strip.text).toBe('\u{1F1FA}\u{1F1F8}')
    expect(summary(strip)).toEqual([[0, 8, SP]])
  })

  it('example 16, byte offsets on multi-byte text', async () => {
    const text = '\u{e9} ||\u{65e5}\u{672c}|| \u{1F600}'
    const {keep, strip} = await both(text)
    expect(keep.text).toBe(text)
    expect(summary(keep)).toEqual([
      [3, 5, MK],
      [5, 11, SP],
      [11, 13, MK],
    ])
    expect(summary(strip)).toEqual([[3, 9, SP]])
  })

  it('a link, a mention and a tag inside a spoiler carry the spoiler feature', async () => {
    const text = '||@alice.test https://example.com #tag||'
    const {keep, strip} = await both(text)
    expect(strip.text).toBe('@alice.test example.com #tag')
    expect(summary(strip)).toEqual([
      [0, 11, 'app.bsky.richtext.facet#mention', SP],
      [11, 12, SP],
      [12, 23, 'app.bsky.richtext.facet#link', SP],
      [23, 24, SP],
      [24, 28, 'app.bsky.richtext.facet#tag', SP],
    ])
    const mention = strip.facets?.[0].features[0] as {did: string}
    expect(mention.did).toBe(ALICE)
    expect(keep.text).toBe('||@alice.test example.com #tag||')
    expect(summary(keep)).toEqual([
      [0, 2, MK],
      [2, 13, 'app.bsky.richtext.facet#mention', SP],
      [13, 14, SP],
      [14, 25, 'app.bsky.richtext.facet#link', SP],
      [25, 26, SP],
      [26, 30, 'app.bsky.richtext.facet#tag', SP],
      [30, 32, MK],
    ])
  })

  it('drops a link that a spoiler edge crosses', async () => {
    const {keep, strip} = await both('||https://exa||mple.com')
    expect(strip.text).toBe('https://example.com')
    expect(summary(strip)).toEqual([[0, 11, SP]])
    expect(summary(keep)).toEqual([
      [0, 2, MK],
      [2, 13, SP],
      [13, 15, MK],
    ])
  })

  it('shortens a long link inside a spoiler and covers the shortened text', async () => {
    const {keep, strip} = await both(
      'see ||https://example.com/a-long-path-here|| ok',
    )
    expect(strip.text).toBe('see example.com/a-long-path-... ok')
    expect('example.com/a-long-path-...').toHaveLength(27)
    expect(summary(strip)).toEqual([
      [4, 31, 'app.bsky.richtext.facet#link', SP],
    ])
    const link = strip.facets?.[0].features[0] as {uri: string}
    expect(link.uri).toBe('https://example.com/a-long-path-here')
    expect(keep.text).toBe('see ||example.com/a-long-path-...|| ok')
    expect(summary(keep)).toEqual([
      [4, 6, MK],
      [6, 33, 'app.bsky.richtext.facet#link', SP],
      [33, 35, MK],
    ])
  })

  it('moves a spoiler after a shortened link', async () => {
    const {strip} = await both('https://example.com/a-long-path-here ||x||')
    expect(strip.text).toBe('example.com/a-long-path-... x')
    expect(summary(strip)).toEqual([
      [0, 27, 'app.bsky.richtext.facet#link'],
      [28, 29, SP],
    ])
  })

  it('removes an unresolved mention inside a spoiler and keeps the spoiler', async () => {
    const {strip} = await both('||@nobody.test hi||')
    expect(strip.text).toBe('@nobody.test hi')
    expect(summary(strip)).toEqual([[0, 15, SP]])
  })

  it('keep mode without a shortened link returns the cleaned input text', async () => {
    const text = 'one ||two|| three\n||\nfour\n||'
    const {keep} = await both(text)
    expect(keep.text).toBe(text)
  })

  it('trims and cleans newlines as stock', async () => {
    const {keep, strip} = await both('\n\n  \nhello ||x||\n\n\n\nend  ')
    expect(keep.text).toBe('hello ||x||\n\nend')
    expect(strip.text).toBe('hello x\n\nend')
  })

  it('equals the stock resolveRT with no spoilers', async () => {
    for (const text of [
      'hello @alice.test see https://example.com/a-long-path-here #tag',
      'a || b and \\|',
      '\n\nx\n\n\n\ny ',
    ]) {
      const stock = await resolveRT(appview, new RichText({text}))
      for (const mode of ['keep', 'strip'] as const) {
        const ours = await resolveSpoilerRT(appview, new RichText({text}), mode)
        expect(ours).toEqual(stock)
      }
    }
  })

  it('equals the stock resolveRT with the switch off', async () => {
    mockSpoilerTags = false
    const text = 'a ||b|| @alice.test https://example.com/a-long-path-here'
    const stock = await resolveRT(appview, new RichText({text}))
    expect(stock.text).toBe('a ||b|| @alice.test example.com/a-long-path-...')
    for (const mode of ['keep', 'strip'] as const) {
      const ours = await resolveSpoilerRT(appview, new RichText({text}), mode)
      expect(ours).toEqual(stock)
    }
  })

  it('the stock resolveRT hands a spoiler post to the keep pipeline', async () => {
    const rt = await resolveRT(appview, new RichText({text: 'a ||b|| c'}))
    expect(summary(rt)).toEqual([
      [2, 4, MK],
      [4, 5, SP],
      [5, 7, MK],
    ])
    expect(resolvesSpoilers(new RichText({text: 'a || b'}))).toBe(false)
    mockSpoilerTags = false
    expect(resolvesSpoilers(new RichText({text: 'a ||b|| c'}))).toBe(false)
  })

  it('buildSpoilerRichText keeps facets it is given outside spoilers', () => {
    const parse = parseSpoilers('#one ||two||', {unescape: false})
    const detected = new RichText({text: parse.visible})
    detected.detectFacetsWithoutResolution()
    const built = buildSpoilerRichText(parse, detected, {
      mode: 'keep',
      shorten: false,
    })
    expect(built.text).toBe('#one ||two||')
    expect(summary(built)).toEqual([
      [0, 4, 'app.bsky.richtext.facet#tag'],
      [5, 7, MK],
      [7, 10, SP],
      [10, 12, MK],
    ])
  })
})

describe('spoilerWriteMode', () => {
  it('strips private markers only once prism serves facets', () => {
    expect(spoilerWriteMode(true)).toBe('keep')
    expect(spoilerWriteMode(false)).toBe('keep')
    setFacetsServed(true)
    expect(spoilerWriteMode(true)).toBe('strip')
    expect(spoilerWriteMode(false)).toBe('keep')
  })

  it('keeps the markers while the list is only read from the device', () => {
    resetPrismFeatures()
    loadPrismFeatures(READER, ['private', 'private.embeds'])
    expect(spoilerWriteMode(true)).toBe('keep')
  })
})

describe('composeGraphemeLength (T3)', () => {
  const post = (text: string) => ({
    richtext: new RichText({text}),
    shortenedGraphemeLength: 999,
  })

  it('example 1: 5 private once facets are served, 9 before and public', () => {
    setFacetsServed(true)
    expect(composeGraphemeLength(post('a ||b|| c'), true)).toBe(5)
    expect(composeGraphemeLength(post('a ||b|| c'), false)).toBe(9)
    setFacetsServed(false)
    expect(composeGraphemeLength(post('a ||b|| c'), true)).toBe(9)
  })

  it('counts a link shortened', () => {
    expect(
      composeGraphemeLength(
        post('||https://example.com/a-long-path-here||'),
        false,
      ),
    ).toBe(31)
  })

  it('returns the stored length with the switch off or no spoilers', () => {
    expect(composeGraphemeLength(post('a || b'), true)).toBe(999)
    mockSpoilerTags = false
    expect(composeGraphemeLength(post('a ||b|| c'), true)).toBe(999)
  })
})
