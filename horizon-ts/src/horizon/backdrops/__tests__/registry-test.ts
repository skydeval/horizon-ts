import {describe, expect, it} from '@jest/globals'

import {DEFAULT_APPEARANCE} from '#/horizon/appearance/model'
import {
  BACKDROP_DEFS,
  customDef,
  registryDef,
  resolveBackdrop,
} from '#/horizon/backdrops/registry'

/*
 * The 3.1 table: id, collection, stripes, angle, bloom; the solids left in
 * change list 2 (item 9), and the entries it added follow (`ADDED`).
 */
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
]

/*
 * Change list 2: the flags (item 2) and the Nature palettes (item 5), as
 * the 3.1 rows.
 */
const ADDED: [string, string, string, number, number][] = [
  [
    'pride.philly',
    'pride',
    '000000 784F17 E40303 FF8C00 FFED00 008026 004DFF 750787',
    165,
    0.1,
  ],
  [
    'pride.demisexual',
    'pride',
    '000000 FFFFFF FFFFFF 6E0070 D2D2D2 D2D2D2',
    165,
    0.1,
  ],
  [
    'pride.demiromantic',
    'pride',
    '000000 FFFFFF FFFFFF 3DA542 D2D2D2 D2D2D2',
    165,
    0.1,
  ],
  ['pride.aroace', 'pride', 'E28C00 ECCD00 FFFFFF 62AEDC 203856', 165, 0.1],
  ['pride.genderqueer', 'pride', 'B57EDC FFFFFF 4A8123', 165, 0.1],
  [
    'pride.genderfluid',
    'pride',
    'FF76A4 FFFFFF C011D7 000000 2F3CBE',
    165,
    0.1,
  ],
  [
    'pride.agender',
    'pride',
    '000000 BCC4C7 FFFFFF B7F684 FFFFFF BCC4C7 000000',
    165,
    0.1,
  ],
  ['nature.ocean', 'nature', 'D7F0F5 9FD6E2 62B6CC 3B8FB0 2A6D91', 135, 0.1],
  ['nature.forest', 'nature', 'E3EDD9 B5CFA0 7FA872 4F7F52 2F5A3C', 135, 0.1],
  ['nature.desert', 'nature', 'F7E6C8 EDC99A DDA46E C47F52 9C5B3E', 135, 0.1],
  ['nature.sakura', 'nature', 'FFF1F4 FBD5DF F5B3C6 E894AE C97B9A', 135, 0.1],
  ['nature.moss', 'nature', 'E7EBCF C6D09A 9BAE6B 738A4C 4E6436', 135, 0.1],
  /*
   * Change list 3 (items 7 and 8): the flags, stripes top to bottom, as
   * listed in the log.
   */
  [
    'pride.bigender',
    'pride',
    'C479A2 EDA5CD D6C7E8 FFFFFF D6C7E8 9AC7E8 6D82D1',
    165,
    0.1,
  ],
  [
    'pride.transfeminine',
    'pride',
    '73DEFF FFE1ED FFB5D6 FE8CBF FFB5D6 FFE1ED 73DEFF',
    165,
    0.1,
  ],
  [
    'pride.transmasculine',
    'pride',
    'FF8ABD CDF5FE 9AEBFF 74DFFF 9AEBFF CDF5FE FF8ABD',
    165,
    0.1,
  ],
  ['pride.graysexual', 'pride', '740195 B2B2B2 FFFFFF B2B2B2 740195', 165, 0.1],
  [
    'pride.grayromantic',
    'pride',
    '087D16 B2B2B2 FFFFFF B2B2B2 087D16',
    165,
    0.1,
  ],
  ['pride.omnisexual', 'pride', 'FC9CCC FC54BC 240444 645CFC 8CA4FC', 165, 0.1],
  ['pride.polysexual', 'pride', 'F61CB9 07D569 1C92F6', 165, 0.1],
  ['pride.abrosexual', 'pride', '65C286 B4E4CC FFFFFF E796B7 D9446E', 165, 0.1],
  [
    'pride.queer',
    'pride',
    '000000 99D9EA 00A2E8 B5E61D FFFFFF FFC90E FD6666 FFAEC9',
    165,
    0.1,
  ],
]

/* The picker's order after change list 3. */
const ORDER = [
  'none',
  'pride.lesbian',
  'pride.trans',
  'pride.transfeminine',
  'pride.transmasculine',
  'pride.bi',
  'pride.rainbow',
  'pride.philly',
  'pride.queer',
  'pride.gay',
  'pride.pan',
  'pride.omnisexual',
  'pride.polysexual',
  'pride.abrosexual',
  'pride.ace',
  'pride.demisexual',
  'pride.graysexual',
  'pride.aromantic',
  'pride.demiromantic',
  'pride.grayromantic',
  'pride.aroace',
  'pride.nonbinary',
  'pride.genderqueer',
  'pride.genderfluid',
  'pride.bigender',
  'pride.agender',
  'pride.intersex',
  'pride.disability',
  'pride.neurodiversity',
  'materials.paper',
  'materials.glass',
  'materials.granite',
  'materials.fabric',
  'materials.clay',
  'materials.fog',
  'materials.inkwash',
  'calm.hush',
  'calm.sand',
  'calm.sage',
  'calm.stillwater',
  'calm.lilac',
  'calm.slate',
  'calm.charcoal',
  'nature.ocean',
  'nature.forest',
  'nature.desert',
  'nature.sakura',
  'nature.moss',
  'seasonal.auto',
  'seasonal.spring',
  'seasonal.summer',
  'seasonal.autumn',
  'seasonal.winter',
  'skies.auto',
  'skies.dawn',
  'skies.day',
  'skies.golden',
  'skies.dusk',
  'skies.twilight',
  'skies.night',
  'skies.aurora',
  'space.nebula',
  'space.galaxy',
  'space.starfield',
  'gems.amethyst',
  'gems.emerald',
  'gems.sapphire',
  'gems.rosequartz',
  'gems.opal',
  'gems.oilslick',
  'gems.holographic',
  'blobs.peach',
  'blobs.lagoon',
  'blobs.berry',
  'blobs.citrus',
  'blobs.midnight',
  'aesthetics.frutigeraero',
  'aesthetics.vaporwave',
  'aesthetics.synthwave',
  'aesthetics.y2k',
  'aesthetics.cottagecore',
  'aesthetics.darkacademia',
  'aesthetics.pastelgoth',
  'aesthetics.retro70s',
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
}

describe('BACKDROP_DEFS', () => {
  it('has the 3.1 entries, less the solids, and the change list 2 and 3 ones, in order', () => {
    expect(BACKDROP_DEFS.map(def => def.id)).toEqual(ORDER)
    const ids = new Set(BACKDROP_DEFS.map(def => def.id))
    for (const row of [...TABLE, ...ADDED]) expect(ids.has(row[0])).toBe(true)
    expect(BACKDROP_DEFS.some(def => def.id.startsWith('solids.'))).toBe(false)
  })

  it.each([...TABLE, ...ADDED])(
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

  it('locks colours on exactly the 28 pride flags', () => {
    const locked = BACKDROP_DEFS.filter(def => def.lockColors).map(d => d.id)
    expect(locked).toHaveLength(28)
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
