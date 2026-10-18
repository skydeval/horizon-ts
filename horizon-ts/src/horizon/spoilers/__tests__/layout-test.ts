import {beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockSpoilerTags = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {SPOILER_TAGS: {get: () => mockSpoilerTags, enumerable: true}},
  ),
)

import {type Facet, RichText} from '@bsky/sdk/richtext'
import {i18n} from '@lingui/core'

import {type app} from '#/lexicons'
import {buildSpoilerRichText} from '../build'
import {
  buildSpoilerLayout,
  rendersSpoilers,
  type SpoilerLayout,
  type SpoilerPart,
  suffixInLastRun,
} from '../layout'
import {SPOILER_FEATURE, SPOILER_MARKER_FEATURE} from '../nsid'
import {parseSpoilers} from '../parse'
import {spoilerSafeText} from '../plain'

i18n.loadAndActivate({locale: 'en', messages: {}})

beforeEach(() => {
  mockSpoilerTags = true
})

const SP = SPOILER_FEATURE
const MK = SPOILER_MARKER_FEATURE
const LINK = 'app.bsky.richtext.facet#link'

function facet(start: number, end: number, ...types: string[]): Facet {
  return {
    index: {byteStart: start, byteEnd: end},
    features: types.map(type =>
      type === LINK ? {$type: LINK, uri: 'https://example.com'} : {$type: type},
    ) as Facet['features'],
  }
}

function rt(text: string, ...facets: Facet[]) {
  return new RichText({text, facets})
}

/** A text as Horizon writes it publicly (keep mode, links and tags only). */
function written(text: string) {
  const parse = parseSpoilers(text, {unescape: false})
  const detected = new RichText({text: parse.visible})
  detected.detectFacetsWithoutResolution()
  return buildSpoilerRichText(parse, detected, {mode: 'keep', shorten: false})
}

function parts(list: SpoilerPart[]) {
  return list.map(part =>
    part.kind === 'plain'
      ? part.richText.text
      : {spoiler: part.id, text: part.richText.text},
  )
}

function drawn(layout: SpoilerLayout) {
  return layout.items.map(item =>
    item.kind === 'run'
      ? {
          run: parts(item.parts),
          ...(item.arrowFor !== undefined
            ? {arrow: item.arrowFor, tail: parts(item.tail)}
            : {}),
        }
      : {drawer: item.id, label: item.label, text: parts(item.parts)},
  )
}

const inline = {compact: false}

describe('rendersSpoilers', () => {
  it('needs a spoiler facet and the switch', () => {
    expect(rendersSpoilers(written('a ||b|| c'))).toBe(true)
    expect(rendersSpoilers(written('a || b'))).toBe(false)
    expect(rendersSpoilers(rt('plain'))).toBe(false)
    mockSpoilerTags = false
    expect(rendersSpoilers(written('a ||b|| c'))).toBe(false)
  })
})

describe('buildSpoilerLayout (T5)', () => {
  it('hides markers and covers the spoiler (example 1, public)', () => {
    const layout = buildSpoilerLayout(written('a ||b|| c'), inline)
    expect(layout.column).toBe(false)
    expect(drawn(layout)).toEqual([
      {run: ['a ', {spoiler: 0, text: 'b'}, ' c']},
    ])
  })

  it('hides a marker facet only over marker bytes', () => {
    const layout = buildSpoilerLayout(
      rt('x ab yz', facet(2, 4, MK), facet(5, 7, SP)),
      inline,
    )
    expect(drawn(layout)).toEqual([{run: ['x ab ', {spoiler: 0, text: 'yz'}]}])
  })

  it('shows a marker facet that carries another feature', () => {
    const layout = buildSpoilerLayout(
      rt('||a', facet(0, 2, MK, LINK), facet(2, 3, SP)),
      inline,
    )
    expect(drawn(layout)).toEqual([{run: ['||', {spoiler: 0, text: 'a'}]}])
  })

  it('ignores a facet out of range or off a code point boundary', () => {
    const text = '\u{e9} x'
    const layout = buildSpoilerLayout(
      rt(text, facet(1, 2, SP), facet(3, 4, SP), facet(3, 99, SP)),
      inline,
    )
    expect(drawn(layout)).toEqual([{run: ['\u{e9} ', {spoiler: 0, text: 'x'}]}])
  })

  it('drops a spoiler over whitespace only', () => {
    const layout = buildSpoilerLayout(rt('a   b', facet(1, 4, SP)), inline)
    expect(drawn(layout)).toEqual([{run: ['a   b']}])
  })

  it('merges overlapping spoilers and drops a facet a spoiler edge crosses', () => {
    const layout = buildSpoilerLayout(
      rt('abcdefgh', facet(0, 3, SP), facet(2, 5, SP), facet(4, 7, LINK)),
      inline,
    )
    expect(drawn(layout)).toEqual([{run: [{spoiler: 0, text: 'abcde'}, 'fgh']}])
    const plain = layout.items[0]
    expect(plain.kind === 'run' && plain.parts[1].richText.facets).toBe(
      undefined,
    )
  })

  it('keeps a link inside a spoiler on its part', () => {
    const layout = buildSpoilerLayout(
      written('see ||https://example.com||'),
      inline,
    )
    const run = layout.items[0]
    if (run.kind !== 'run') throw new Error('expected a run')
    const cover = run.parts[1]
    expect(cover.kind).toBe('spoiler')
    expect(cover.richText.text).toBe('https://example.com')
    expect(cover.richText.facets).toEqual([
      {
        index: {byteStart: 0, byteEnd: 19},
        features: [{$type: LINK, uri: 'https://example.com'}],
      },
    ])
  })

  it('example 2 is inline: the text has no line break', () => {
    expect(drawn(buildSpoilerLayout(written('||b||'), inline))).toEqual([
      {run: [{spoiler: 0, text: 'b'}]},
    ])
  })

  it('example 10 is a drawer under the line above it', () => {
    const layout = buildSpoilerLayout(
      written('Intro\n||\nSecret line\n||\nOutro'),
      inline,
    )
    expect(layout.column).toBe(true)
    expect(drawn(layout)).toEqual([
      {run: ['Intro'], arrow: 0, tail: []},
      {drawer: 0, label: false, text: ['Secret line']},
      {run: ['Outro']},
    ])
    expect(suffixInLastRun(layout)).toBe(true)
  })

  it('example 11 opens from a label row', () => {
    expect(
      drawn(buildSpoilerLayout(written('||Whole line||\nmore'), inline)),
    ).toEqual([{drawer: 0, label: true, text: ['Whole line']}, {run: ['more']}])
  })

  it('example 12 is inline across a line break', () => {
    expect(
      drawn(buildSpoilerLayout(written('text ||a\nb|| more'), inline)),
    ).toEqual([{run: ['text ', {spoiler: 0, text: 'a\nb'}, ' more']}])
  })

  it('example 10 with its line breaks flattened is one inline cover', () => {
    const original = written('Intro\n||\nSecret line\n||\nOutro')
    const flattened = new RichText({
      text: original.text.replace(/[\r\n\t]/g, ' '),
      facets: original.facets,
    })
    expect(drawn(buildSpoilerLayout(flattened, inline))).toEqual([
      {run: ['Intro ', {spoiler: 0, text: 'Secret line'}, ' Outro']},
    ])
  })

  it('a compact rendering draws blocks inline', () => {
    expect(
      drawn(
        buildSpoilerLayout(written('Intro\n||\nSecret line\n||\nOutro'), {
          compact: true,
        }),
      ),
    ).toEqual([
      {run: ['Intro\n', {spoiler: 0, text: 'Secret line'}, '\nOutro']},
    ])
  })

  it('puts the arrow on the last filled line, before blank lines', () => {
    expect(
      drawn(buildSpoilerLayout(written('Intro\n\n||\nSecret\n||'), inline)),
    ).toEqual([
      {run: ['Intro'], arrow: 0, tail: ['\n']},
      {drawer: 0, label: false, text: ['Secret']},
    ])
  })

  it('a first block and the block straight after it each get a label row', () => {
    const layout = buildSpoilerLayout(
      written('||\nx\n||\n||\ny\n||\nafter'),
      inline,
    )
    expect(drawn(layout)).toEqual([
      {drawer: 0, label: true, text: ['x']},
      {drawer: 1, label: true, text: ['y']},
      {run: ['after']},
    ])
  })

  it('touching public pieces render as one spoiler (example 13)', () => {
    expect(drawn(buildSpoilerLayout(written('||a||||b||'), inline))).toEqual([
      {run: [{spoiler: 0, text: 'ab'}]},
    ])
  })

  it('a layout that ends with a drawer takes the suffix after it', () => {
    const layout = buildSpoilerLayout(written('Intro\n||\nSecret\n||'), inline)
    expect(layout.items[layout.items.length - 1].kind).toBe('drawer')
    expect(suffixInLastRun(layout)).toBe(false)
  })
})

describe('spoilerSafeText (T9)', () => {
  const record = (text: string, facets?: Facet[]) =>
    ({text, facets}) as app.bsky.feed.post.Main

  it('is the stock text with the switch off or no spoiler facet', () => {
    expect(spoilerSafeText(record('a || b'))).toBe('a || b')
    const pub = written('a ||b|| c')
    mockSpoilerTags = false
    expect(spoilerSafeText(record(pub.text, pub.facets))).toBe('a ||b|| c')
  })

  it('replaces each spoiler, public and strip', () => {
    const pub = written('a ||b|| c')
    expect(spoilerSafeText(record(pub.text, pub.facets))).toBe('a [spoiler] c')
    expect(spoilerSafeText(record('a b c', [facet(2, 3, SP)]))).toBe(
      'a [spoiler] c',
    )
    const block = written('Intro\n||\nSecret line\n||\nOutro')
    expect(spoilerSafeText(record(block.text, block.facets))).toBe(
      'Intro\n[spoiler]\nOutro',
    )
  })
})
