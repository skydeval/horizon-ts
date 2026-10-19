import {describe, expect, it} from '@jest/globals'

import {DEFAULT_APPEARANCE} from '#/horizon/appearance/model'
import {
  BACKDROP_DEFS,
  customDef,
  registryDef,
  resolveBackdrop,
} from '#/horizon/backdrops/registry'

/* The 3.1 table: id, collection, stripes, angle, bloom. */
const TABLE: [string, string, string, number, number][] = [
  ['none', 'system', '', 0, 0],
  ['pride.lesbian', 'pride', 'D52D00 FF9A56 FFFFFF D162A4 A30262', 165, 0.16],
  ['pride.trans', 'pride', '5BCEFA F5A9B8 FFFFFF F5A9B8 5BCEFA', 165, 0.12],
  ['pride.bi', 'pride', 'D60270 D60270 9B4F96 0038A8 0038A8', 150, 0.12],
  [
    'pride.rainbow',
    'pride',
    'E40303 FF8C00 FFED00 008026 004DFF 750787',
    135,
    0.1,
  ],
  ['pride.gay', 'pride', '078D70 26CEAA 98E8C1 7BADE2 3D1A78', 165, 0.12],
  ['pride.pan', 'pride', 'FF218C FFD800 21B1FF', 150, 0.1],
  ['pride.ace', 'pride', '000000 A3A3A3 FFFFFF 800080', 165, 0.08],
  ['pride.aromantic', 'pride', '3DA542 A7D379 FFFFFF A9A9A9 000000', 165, 0.1],
  ['pride.nonbinary', 'pride', 'FCF434 FFFFFF 9C59D1 2C2C2C', 155, 0.1],
  ['pride.intersex', 'pride', 'FFD800 FFD800 7902AA', 140, 0.2],
  ['pride.disability', 'pride', 'CF7280 EEDC82 7BCF9B 5FA6D6 3F3F3F', 160, 0.1],
  [
    'pride.neurodiversity',
    'pride',
    'FFD700 FF8C00 FF69B4 6A5ACD 00CED1',
    145,
    0.12,
  ],
  [
    'materials.paper',
    'materials',
    'F6F1E8 F2F3F0 F6F1E8 EFE6DA F6F1E8 E6D8C8',
    20,
    0.14,
  ],
  [
    'materials.glass',
    'materials',
    'EAF2FF DDF7F2 EAF2FF EEE8FF EAF2FF FFFFFF EAF2FF CFE0FF',
    70,
    0.12,
  ],
  [
    'materials.granite',
    'materials',
    'ECEDEF D9DBE0 D9DBE0 DED8D2 D9DBE0 D3D9E6 BFC4CF',
    6,
    0.1,
  ],
  [
    'materials.fabric',
    'materials',
    'F1EAE3 E9DDD3 F1EAE3 E6D7CC F1EAE3 DCD0C7',
    38,
    0.13,
  ],
  [
    'materials.clay',
    'materials',
    'F3E6DE EAD4C7 F3E6DE E6C4B3 F3E6DE DDB2A1',
    18,
    0.12,
  ],
  [
    'materials.fog',
    'materials',
    'F4F6F8 EEF1F4 F4F6F8 E9EDF2 F4F6F8 E4E9EF',
    92,
    0.09,
  ],
  [
    'materials.inkwash',
    'materials',
    'EEF2F7 DDE5F1 EEF2F7 CBD7E8 EEF2F7 B8C6DA',
    120,
    0.1,
  ],
  ['solids.slate', 'solids', '1F2937 1F2937', 180, 0.1],
  ['solids.mist', 'solids', 'E9EEF5 E9EEF5', 180, 0.08],
  ['solids.red', 'solids', 'B4534B B4534B', 180, 0.1],
  ['solids.orange', 'solids', 'C26A3B C26A3B', 180, 0.1],
  ['solids.yellow', 'solids', 'B79B2A B79B2A', 180, 0.12],
  ['solids.green', 'solids', '2F7D5C 2F7D5C', 180, 0.1],
  ['solids.blue', 'solids', '2F5F9E 2F5F9E', 180, 0.1],
  ['solids.indigo', 'solids', '3A3F8F 3A3F8F', 180, 0.1],
  ['solids.violet', 'solids', '6B4A8E 6B4A8E', 180, 0.1],
]

/* The 3.1 tuning table: light s/b, dim s/b, dark s/b. */
const TUNING: Record<string, number[]> = {
  'pride.lesbian': [1.0, 1.02, 1.0, 0.98, 1.02, 0.92],
  'materials.paper': [0.92, 1.03, 0.9, 0.99, 0.88, 0.92],
  'materials.glass': [0.94, 1.02, 0.92, 0.98, 0.9, 0.9],
  'materials.granite': [0.85, 1.02, 0.82, 0.98, 0.8, 0.9],
  'materials.fabric': [0.92, 1.02, 0.9, 0.98, 0.88, 0.9],
  'materials.clay': [0.96, 1.02, 0.94, 0.98, 0.92, 0.9],
  'materials.fog': [0.7, 1.04, 0.68, 1.0, 0.66, 0.92],
  'materials.inkwash': [0.86, 1.01, 0.84, 0.97, 0.82, 0.89],
  'solids.slate': [0.85, 1.02, 0.85, 1.0, 0.85, 0.95],
  'solids.mist': [0.75, 1.03, 0.74, 1.0, 0.72, 0.93],
  'solids.red': [0.92, 1.02, 0.9, 0.99, 0.88, 0.92],
  'solids.orange': [0.92, 1.02, 0.9, 0.99, 0.88, 0.92],
  'solids.yellow': [0.86, 1.02, 0.84, 0.99, 0.82, 0.92],
  'solids.green': [0.92, 1.01, 0.9, 0.98, 0.88, 0.9],
  'solids.blue': [0.92, 1.01, 0.9, 0.98, 0.88, 0.9],
  'solids.indigo': [0.9, 1.01, 0.88, 0.98, 0.86, 0.9],
  'solids.violet': [0.9, 1.01, 0.88, 0.98, 0.86, 0.9],
}

describe('BACKDROP_DEFS', () => {
  it('has the 29 entries in the 3.1 order', () => {
    expect(BACKDROP_DEFS.map(def => def.id)).toEqual(TABLE.map(row => row[0]))
  })

  it.each(TABLE)(
    '%s matches the 3.1 table',
    (id, collection, stripes, angle, bloom) => {
      const def = registryDef(id)!
      expect(def.collection).toBe(collection)
      expect(def.stripes).toEqual(
        stripes ? stripes.split(' ').map(hex => `#${hex}`) : [],
      )
      for (const color of def.stripes) expect(color).toBe(color.toUpperCase())
      if (id !== 'none') {
        expect(def.stripe).toEqual({
          angleDeg: angle,
          edgeEpsilon: 0.002,
          softenEdges: true,
        })
        expect(def.bloomOpacity).toBe(bloom)
      }
    },
  )

  it('ports the tuning exactly', () => {
    for (const def of BACKDROP_DEFS) {
      if (def.id === 'none') continue
      const row = TUNING[def.id] ?? [1, 1, 1, 1, 1, 1]
      expect(def.tuning).toEqual({
        light: {saturation: row[0], brightness: row[1]},
        dim: {saturation: row[2], brightness: row[3]},
        dark: {saturation: row[4], brightness: row[5]},
      })
    }
  })

  it('locks colours on exactly the 12 pride flags', () => {
    const locked = BACKDROP_DEFS.filter(def => def.lockColors).map(d => d.id)
    expect(locked).toHaveLength(12)
    expect(locked.every(id => id.startsWith('pride.'))).toBe(true)
  })

  it('names are Lingui descriptors with the backdrop context', () => {
    for (const def of BACKDROP_DEFS) {
      expect(typeof def.name.id).toBe('string')
      expect(def.name.message).toBeTruthy()
    }
    expect(registryDef('pride.trans')!.name.message).toBe('Trans Pride')
  })
})

describe('customDef', () => {
  it('solid repeats the colour; two-tone uses both', () => {
    expect(
      customDef({mode: 'solid', a: '#112233', b: '#445566'}).stripes,
    ).toEqual(['#112233', '#112233'])
    const twoTone = customDef({mode: 'twoTone', a: '#112233', b: '#445566'})
    expect(twoTone.stripes).toEqual(['#112233', '#445566'])
    expect(twoTone.stripe.angleDeg).toBe(180)
    expect(twoTone.bloomOpacity).toBe(0.1)
    expect(twoTone.lockColors).toBe(false)
    expect(twoTone.tuning).toBeUndefined()
  })
})

describe('resolveBackdrop', () => {
  it('none and unknown ids draw nothing; custom is built from the config', () => {
    expect(resolveBackdrop(DEFAULT_APPEARANCE)).toBeNull()
    expect(
      resolveBackdrop({...DEFAULT_APPEARANCE, backdrop: 'future.thing'}),
    ).toBeNull()
    expect(
      resolveBackdrop({...DEFAULT_APPEARANCE, backdrop: 'pride.ace'})?.id,
    ).toBe('pride.ace')
    expect(
      resolveBackdrop({...DEFAULT_APPEARANCE, backdrop: 'custom'})?.stripes,
    ).toEqual(['#FFE2FF', '#CCFFFF'])
  })
})
