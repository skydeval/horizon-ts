import {describe, expect, it} from '@jest/globals'

import {
  badgesToShow,
  gradientVector,
  markFontSize,
  outlineGeometry,
  parseBadgeCatalog,
  parseSubjectBadges,
} from '../badges'

const PRISM = 'https://prism.example'

/* prism's live answer, 2026-11-24, plus a designed badge with a dark look */
const ANSWER = {
  badges: [
    {
      id: 'dev',
      name: 'Developer',
      description: 'Builds Horizon',
      color: '#10B981',
      default: false,
      order: 2,
      design: {shape: 'check', fill: {kind: 'solid', color: '#10B981'}},
    },
    {
      id: 'verified',
      name: 'Verified',
      description: 'Verified by trusted verifiers.',
      color: '#1D9BF0',
      default: true,
      order: 0,
      design: {
        shape: 'seal',
        fill: {kind: 'gradient', from: '#000000', to: '#FFFFFF', angle: 90},
        mark: {kind: 'check', color: '#FFFFFF'},
        outline: {color: '#111111', width: 4},
        dark: {mark: {kind: 'text', value: 'HZ', color: '#000000'}},
      },
    },
    {id: 'plain', name: 'Plain', color: '#8B5CF6', order: 1},
    {id: 'verified', name: 'Duplicate', order: 3},
    {
      id: 'pic',
      name: 'Picture',
      order: 4,
      design: {
        shape: 'image',
        fill: {kind: 'solid', color: '#000000'},
        image: 'https://elsewhere.example/x.png',
      },
    },
    {name: 'No id'},
  ],
}

describe('badge catalogue', () => {
  const catalog = parseBadgeCatalog(ANSWER, PRISM)

  it('keeps prism’s order, one entry per id', () => {
    expect(catalog.map(b => b.id)).toEqual(['verified', 'plain', 'dev', 'pic'])
    expect(catalog[0].isDefault).toBe(true)
  })

  it('reads the design and lays the dark overrides over it', () => {
    const [verified] = catalog
    expect(verified.design.shape).toBe('seal')
    expect(verified.design.mark).toEqual({kind: 'check', color: '#FFFFFF'})
    expect(verified.dark.mark).toEqual({
      kind: 'text',
      value: 'HZ',
      color: '#000000',
    })
    expect(verified.dark.outline).toEqual(verified.design.outline)
    expect(verified.dark.fill).toEqual(verified.design.fill)
  })

  it('falls back to a check in the badge’s colour', () => {
    const plain = catalog.find(b => b.id === 'plain')!
    expect(plain.design).toEqual({
      shape: 'check',
      fill: {kind: 'solid', color: '#8B5CF6'},
    })
  })

  it('draws images only from prism', () => {
    const pic = catalog.find(b => b.id === 'pic')!
    expect(pic.design.shape).toBe('check')
    const own = parseBadgeCatalog(
      {
        badges: [
          {
            id: 'p',
            name: 'P',
            design: {
              shape: 'image',
              fill: {kind: 'solid', color: '#000000'},
              image: '/badges/abc.png',
            },
          },
        ],
      },
      PRISM,
    )
    expect(own[0].design.image).toBe('https://prism.example/badges/abc.png')
  })

  it('reads nothing from a malformed answer', () => {
    expect(parseBadgeCatalog(null, PRISM)).toEqual([])
    expect(parseBadgeCatalog({badges: 'x'}, PRISM)).toEqual([])
  })
})

describe('badges an account holds', () => {
  const catalog = parseBadgeCatalog(ANSWER, PRISM)
  const held = parseSubjectBadges({
    subjects: [
      {
        did: 'did:plc:a',
        badges: [
          {id: 'dev', issuer: 'did:web:v', uri: 'at://1', isValid: true},
          {id: 'verified', issuer: 'did:web:v', uri: 'at://2', isValid: false},
          {id: 'verified', issuer: 'did:web:w', uri: 'at://3', isValid: true},
          {id: 'gone', issuer: 'did:web:v', uri: 'at://4', isValid: true},
          {id: 'dev'},
        ],
      },
      {did: 'did:plc:b'},
    ],
  })

  it('shows valid awards only, in catalogue order, unknown ids dropped', () => {
    const shown = badgesToShow(held.get('did:plc:a'), catalog)
    expect(shown.map(s => s.badge.id)).toEqual(['verified', 'dev'])
    expect(shown[0].awards.map(a => a.uri)).toEqual(['at://3'])
  })

  it('shows nothing while either read is missing', () => {
    expect(badgesToShow(undefined, catalog)).toEqual([])
    expect(badgesToShow(held.get('did:plc:a'), undefined)).toEqual([])
    expect(held.has('did:plc:b')).toBe(false)
  })
})

describe('drawing rule', () => {
  it('runs the gradient by its angle', () => {
    expect(gradientVector(0)).toEqual({x1: 0, y1: 0.5, x2: 1, y2: 0.5})
    expect(gradientVector(90)).toEqual({x1: 0.5, y1: 0, x2: 0.5, y2: 1})
  })

  it('keeps the outline inside the box', () => {
    // width 4 = 2px at 16px = 3 units in the 24-unit box
    expect(outlineGeometry(4)).toEqual({scale: 0.875, strokeWidth: 3.428571})
  })

  it('sizes text marks by length', () => {
    expect(markFontSize('★')).toBe(20)
    expect(markFontSize('HZ')).toBe(15)
  })
})
