import {describe, expect, it} from '@jest/globals'

import {DEFAULT_CUSTOM} from '#/horizon/appearance/model'
import {
  colorsUnderGlass,
  composite,
  contrast,
  GLASS,
  glassAlpha,
  glassFor,
  luminance,
  MAX_GLASS_ALPHA,
  smallestAlpha,
} from '#/horizon/backdrops/glass'
import {
  BACKDROP_DEFS,
  customDef,
  registryDef,
  REMOVED_SOLIDS,
} from '#/horizon/backdrops/registry'
import {DEFAULT_SOFTNESS} from '#/horizon/backdrops/softness'

/*
 * The 7.3 table, look 'seen': light, dim, dark, with no softness. Live fix
 * batch 1 dropped the dark veil, so the dark column is new; light and dim
 * are 7.3's.
 */
const TABLE: Record<string, [number, number, number]> = {
  'pride.lesbian': [0.71, 0.81, 0.74],
  'pride.trans': [0.55, 0.81, 0.74],
  'pride.bi': [0.7, 0.43, 0.38],
  'pride.rainbow': [0.71, 0.78, 0.71],
  'pride.gay': [0.71, 0.77, 0.69],
  'pride.pan': [0.61, 0.76, 0.69],
  'pride.ace': [0.76, 0.81, 0.74],
  'pride.aromantic': [0.76, 0.81, 0.74],
  'pride.nonbinary': [0.71, 0.81, 0.74],
  'pride.intersex': [0.71, 0.76, 0.69],
  'pride.disability': [0.68, 0.77, 0.69],
  'pride.neurodiversity': [0.6, 0.76, 0.69],
  'materials.paper': [0.55, 0.8, 0.72],
  'materials.glass': [0.55, 0.81, 0.74],
  'materials.granite': [0.55, 0.79, 0.72],
  'materials.fabric': [0.55, 0.79, 0.71],
  'materials.clay': [0.55, 0.79, 0.71],
  'materials.fog': [0.55, 0.8, 0.73],
  'materials.inkwash': [0.55, 0.8, 0.72],
  'solids.slate': [0.72, 0.38, 0.38],
  'solids.mist': [0.55, 0.79, 0.72],
  'solids.red': [0.59, 0.46, 0.4],
  'solids.orange': [0.55, 0.55, 0.47],
  'solids.yellow': [0.55, 0.65, 0.57],
  'solids.green': [0.59, 0.47, 0.39],
  'solids.blue': [0.63, 0.38, 0.38],
  'solids.indigo': [0.67, 0.38, 0.38],
  'solids.violet': [0.64, 0.38, 0.38],
}

describe('glass (T7)', () => {
  it('the themes glass matches ALF', () => {
    expect(GLASS.dim.tint).toEqual({r: 0x15, g: 0x1d, b: 0x28})
    expect(GLASS.light.text).toEqual({r: 0x40, g: 0x51, b: 0x68})
    expect(GLASS.dim.text).toEqual({r: 0xab, g: 0xb8, b: 0xc9})
    expect(GLASS.dark.text).toEqual({r: 0xa5, g: 0xb2, b: 0xc5})
  })

  it('reproduces the 7.3 alpha table', () => {
    /*
     * Change list 2: the removed solids' rows now hold for the custom
     * one-tone each is read as, so their glass is unchanged; the defs
     * added since have no rows here (their 4.5:1 is checked below).
     */
    for (const [id, row] of Object.entries(TABLE)) {
      const solid = REMOVED_SOLIDS[id]
      const def =
        registryDef(id) ?? customDef({mode: 'solid', a: solid, b: solid})
      expect(def).toBeTruthy()
      expect([
        glassAlpha(def, 'light'),
        glassAlpha(def, 'dim'),
        glassAlpha(def, 'dark'),
      ]).toEqual(row)
    }
    const custom = customDef(DEFAULT_CUSTOM)
    expect([
      glassAlpha(custom, 'light'),
      glassAlpha(custom, 'dim'),
      glassAlpha(custom, 'dark'),
    ]).toEqual([0.55, 0.8, 0.73])
  })

  it('rail text keeps 4.5:1 over the softened colours, at every softness', () => {
    const defs = [
      ...BACKDROP_DEFS.filter(def => def.id !== 'none'),
      customDef(DEFAULT_CUSTOM),
    ]
    for (const theme of ['dim', 'dark'] as const) {
      for (const soften of [DEFAULT_SOFTNESS[theme] / 100, 1]) {
        for (const base of defs) {
          const def = {...base, soften}
          const alpha = glassAlpha(def, theme)
          if (alpha >= MAX_GLASS_ALPHA) continue
          const worst = Math.min(
            ...colorsUnderGlass(def, theme).map(color =>
              contrast(
                composite(GLASS[theme].tint, color, alpha),
                GLASS[theme].text,
              ),
            ),
          )
          expect(worst).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
    // The glass sees the treated colours: the cache tells softness apart.
    const trans = registryDef('pride.trans')!
    expect(colorsUnderGlass({...trans, soften: 0.5}, 'dark')[0]).not.toEqual(
      colorsUnderGlass(trans, 'dark')[0],
    )
  })

  it('reduced transparency floors the alpha at 0.85', () => {
    const trans = registryDef('pride.trans')!
    expect(glassFor(trans, 'light', true)).toEqual({
      color: 'rgba(255, 255, 255, 0.85)',
      alpha: 0.85,
    })
    expect(glassFor(trans, 'light', false)).toEqual({
      color: 'rgba(255, 255, 255, 0.55)',
      alpha: 0.55,
    })
    const ace = registryDef('pride.ace')!
    expect(glassFor(ace, 'dim', true).alpha).toBe(0.85)
  })

  it('compositing and contrast helpers', () => {
    expect(
      composite({r: 255, g: 255, b: 255}, {r: 0, g: 0, b: 0}, 0.5),
    ).toEqual({
      r: 128,
      g: 128,
      b: 128,
    })
    expect(luminance({r: 255, g: 255, b: 255})).toBeCloseTo(1, 10)
    expect(contrast({r: 255, g: 255, b: 255}, {r: 0, g: 0, b: 0})).toBeCloseTo(
      21,
      10,
    )
    expect(
      contrast({r: 0x77, g: 0x77, b: 0x77}, {r: 255, g: 255, b: 255}),
    ).toBeCloseTo(4.48, 2)
  })

  it('smallestAlpha at 3:1 with a floor of 0.20', () => {
    const white = {r: 255, g: 255, b: 255}
    const black = {r: 0, g: 0, b: 0}
    // A white icon over black glass on white needs about 0.42.
    const alpha = smallestAlpha({
      under: [white],
      tint: black,
      text: white,
      target: 3,
      min: 0.2,
    })
    expect(
      contrast(composite(black, white, alpha), white),
    ).toBeGreaterThanOrEqual(3)
    expect(contrast(composite(black, white, alpha - 0.01), white)).toBeLessThan(
      3,
    )
    expect(
      smallestAlpha({
        under: [black],
        tint: black,
        text: white,
        target: 3,
        min: 0.2,
      }),
    ).toBe(0.2)
  })
})
