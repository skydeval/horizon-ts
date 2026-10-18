import {describe, expect, it} from '@jest/globals'

import {hasSpoilers, parseSpoilers, type SpoilerInsertion} from '../parse'

type Expected = {
  visible: string
  spans: [number, number][]
  insertions: [number, SpoilerInsertion['text']][]
}

/**
 * Section 4.2 of the spoilers design: each row's text, then its parse with
 * `unescape: true` (strip) and, where it differs, `unescape: false` (keep).
 */
const ROWS: [string, string, Expected, Expected?][] = [
  [
    '1',
    'a ||b|| c',
    {
      visible: 'a b c',
      spans: [[2, 3]],
      insertions: [
        [2, '||'],
        [3, '||'],
      ],
    },
  ],
  [
    '2',
    '||b||',
    {
      visible: 'b',
      spans: [[0, 1]],
      insertions: [
        [0, '||'],
        [1, '||'],
      ],
    },
  ],
  ['3', 'x||', {visible: 'x||', spans: [], insertions: []}],
  [
    '4',
    '||a|| ||b',
    {
      visible: 'a ||b',
      spans: [[0, 1]],
      insertions: [
        [0, '||'],
        [1, '||'],
      ],
    },
  ],
  ['5', '||||', {visible: '||||', spans: [], insertions: []}],
  ['6', '|| ||', {visible: '|| ||', spans: [], insertions: []}],
  [
    '7',
    '|||a|||',
    {
      visible: '|a|',
      spans: [[0, 2]],
      insertions: [
        [0, '||'],
        [2, '||'],
      ],
    },
  ],
  [
    '8',
    '\\|\\|a\\|\\|',
    {visible: '||a||', spans: [], insertions: []},
    {visible: '\\|\\|a\\|\\|', spans: [], insertions: []},
  ],
  [
    '9',
    '||a ||b|| c||',
    {
      visible: 'a b c',
      spans: [
        [0, 2],
        [3, 5],
      ],
      insertions: [
        [0, '||'],
        [2, '||'],
        [3, '||'],
        [5, '||'],
      ],
    },
  ],
  [
    '10',
    'Intro\n||\nSecret line\n||\nOutro',
    {
      visible: 'Intro\nSecret line\nOutro',
      spans: [[6, 17]],
      insertions: [
        [6, '||\n'],
        [17, '\n||'],
      ],
    },
  ],
  [
    '11',
    '||Whole line||\nmore',
    {
      visible: 'Whole line\nmore',
      spans: [[0, 10]],
      insertions: [
        [0, '||'],
        [10, '||'],
      ],
    },
  ],
  [
    '12',
    'text ||a\nb|| more',
    {
      visible: 'text a\nb more',
      spans: [[5, 8]],
      insertions: [
        [5, '||'],
        [8, '||'],
      ],
    },
  ],
  [
    '13',
    '||a||||b||',
    {
      visible: 'ab',
      spans: [[0, 2]],
      insertions: [
        [0, '||'],
        [1, '||'],
        [1, '||'],
        [2, '||'],
      ],
    },
  ],
  [
    '14',
    '||a\\|\\|b||',
    {
      visible: 'a||b',
      spans: [[0, 4]],
      insertions: [
        [0, '||'],
        [4, '||'],
      ],
    },
    {
      visible: 'a\\|\\|b',
      spans: [[0, 6]],
      insertions: [
        [0, '||'],
        [6, '||'],
      ],
    },
  ],
  [
    '15',
    'e||\u{301}x||',
    {visible: 'e||\u{301}x||', spans: [], insertions: []},
  ],
  [
    '15a',
    '\u{1F1FA}||\u{1F1F8}||',
    {
      visible: '\u{1F1FA}\u{1F1F8}',
      spans: [[0, 4]],
      insertions: [
        [2, '||'],
        [4, '||'],
      ],
    },
  ],
  [
    '16',
    '\u{e9} ||\u{65e5}\u{672c}|| \u{1F600}',
    {
      visible: '\u{e9} \u{65e5}\u{672c} \u{1F600}',
      spans: [[2, 4]],
      insertions: [
        [2, '||'],
        [4, '||'],
      ],
    },
  ],
]

function shape(expected: Expected) {
  return {
    visible: expected.visible,
    spans: expected.spans.map(([start, end]) => ({start, end})),
    insertions: expected.insertions.map(([at, text]) => ({at, text})),
  }
}

describe('parseSpoilers (T1)', () => {
  it.each(ROWS.map(([name, text, strip, keep]) => ({name, text, strip, keep})))(
    'example $name, strip and keep',
    ({text, strip, keep}) => {
      expect(parseSpoilers(text, {unescape: true})).toEqual(shape(strip))
      expect(parseSpoilers(text, {unescape: false})).toEqual(
        shape(keep ?? strip),
      )
    },
  )

  it('leaves an odd last marker as text', () => {
    expect(parseSpoilers('||a||b||', {unescape: true})).toEqual({
      visible: 'ab||',
      spans: [{start: 0, end: 1}],
      insertions: [
        {at: 0, text: '||'},
        {at: 1, text: '||'},
      ],
    })
  })

  it('a pair holding only a line break is text', () => {
    expect(parseSpoilers('||\n||', {unescape: true}).spans).toEqual([])
  })

  it('takes a closing marker alone at the end of the text with its line', () => {
    expect(parseSpoilers('a\n||\nb\n||', {unescape: false})).toEqual({
      visible: 'a\nb',
      spans: [{start: 2, end: 3}],
      insertions: [
        {at: 2, text: '||\n'},
        {at: 3, text: '\n||'},
      ],
    })
  })

  it('keeps consecutive spoilers on adjacent lines apart', () => {
    const parse = parseSpoilers('||\nx\n||\n||\ny\n||', {unescape: false})
    expect(parse.visible).toBe('x\ny')
    expect(parse.spans).toEqual([
      {start: 0, end: 1},
      {start: 2, end: 3},
    ])
  })

  it('snaps a span over a ZWJ sequence that the markers split', () => {
    const parse = parseSpoilers('\u{1F468}\u{200d}||\u{1F469}||', {
      unescape: true,
    })
    expect(parse.visible).toBe('\u{1F468}\u{200d}\u{1F469}')
    expect(parse.spans).toEqual([{start: 0, end: 5}])
  })

  it('does not count a marker that ends inside a combining mark', () => {
    const parse = parseSpoilers('a ||x||\u{301}', {unescape: true})
    expect(parse.spans).toEqual([])
    expect(parse.visible).toBe('a ||x||\u{301}')
  })

  it('parses a 3000-byte text', () => {
    const text = '||a|| '.repeat(500)
    expect(text.length).toBe(3000)
    const parse = parseSpoilers(text, {unescape: false})
    expect(parse.spans).toHaveLength(500)
    expect(parse.visible).toBe('a '.repeat(500))
  })

  it('hasSpoilers', () => {
    expect(hasSpoilers('a ||b|| c')).toBe(true)
    expect(hasSpoilers('a || b')).toBe(false)
    expect(hasSpoilers('|| ||')).toBe(false)
    expect(hasSpoilers('plain')).toBe(false)
  })
})
