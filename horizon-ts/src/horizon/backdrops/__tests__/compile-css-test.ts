import {describe, expect, it} from '@jest/globals'

import {
  compileBackdrop,
  hexToRgb,
  hslToRgb,
  type ResolvedLinear,
  type ResolvedRadial,
  rgbToHex,
  rgbToHsl,
} from '#/horizon/backdrops/compile'
import {cssBackground, formatNumber} from '#/horizon/backdrops/css'
import {customDef, registryDef} from '#/horizon/backdrops/registry'

const trans = registryDef('pride.trans')!

function linearOf(id: string, w: number, h: number, look: 'seen' | 'spec') {
  return compileBackdrop(
    registryDef(id)!,
    'light',
    {width: w, height: h},
    look,
  )!.layers[0] as ResolvedLinear
}

describe('compileBackdrop (T4)', () => {
  it('corner angles', () => {
    expect(linearOf('pride.trans', 1440, 900, 'seen').cssDeg).toBeCloseTo(
      122.005,
      2,
    )
    expect(linearOf('pride.trans', 36, 36, 'seen').cssDeg).toBeCloseTo(135, 6)
    expect(linearOf('pride.trans', 390, 844, 'seen').cssDeg).toBeCloseTo(
      155.2,
      1,
    )
    expect(linearOf('pride.trans', 1920, 1080, 'seen').cssDeg).toBeCloseTo(
      119.36,
      2,
    )
  })

  it('corner endpoints are the frame corners', () => {
    const layer = linearOf('pride.trans', 1440, 900, 'seen')
    expect([layer.x1, layer.y1, layer.x2, layer.y2]).toEqual([0, 0, 1440, 900])
  })

  it('angle endpoints', () => {
    // A sky's own top-to-bottom layer (the solids, used here before, are gone).
    const layer = linearOf('skies.dusk', 1440, 900, 'spec')
    expect(layer.cssDeg).toBe(180)
    expect(layer.x1).toBeCloseTo(720, 6)
    expect(layer.y1).toBeCloseTo(0, 6)
    expect(layer.x2).toBeCloseTo(720, 6)
    expect(layer.y2).toBeCloseTo(900, 6)
  })

  it('spec tuning changes a material, not a flag', () => {
    const paper = registryDef('materials.paper')!
    const light = compileBackdrop(
      paper,
      'dark',
      {width: 10, height: 10},
      'spec',
    )!
    const raw = hexToRgb(paper.stripes[0])
    const first = light.layers[0].stops[0]
    expect({r: first.r, g: first.g, b: first.b}).not.toEqual(raw)

    const lesbian = registryDef('pride.lesbian')!
    const flag = compileBackdrop(
      lesbian,
      'dark',
      {width: 10, height: 10},
      'spec',
    )!
    const f = flag.layers[0].stops[0]
    expect({r: f.r, g: f.g, b: f.b}).toEqual(hexToRgb(lesbian.stripes[0]))
  })

  it('seen applies no tuning', () => {
    const paper = registryDef('materials.paper')!
    const seen = compileBackdrop(
      paper,
      'dark',
      {width: 10, height: 10},
      'seen',
    )!
    const s = seen.layers[0].stops[0]
    expect({r: s.r, g: s.g, b: s.b}).toEqual(hexToRgb(paper.stripes[0]))
  })

  it('folds opacity into alpha and resolves the radial', () => {
    const compiled = compileBackdrop(
      trans,
      'light',
      {width: 1000, height: 500},
      'spec',
    )!
    expect(compiled.layers).toHaveLength(2)
    const radial = compiled.layers[1] as ResolvedRadial
    expect(radial.kind).toBe('radial')
    expect(radial.cx).toBeCloseTo(280, 6)
    expect(radial.cy).toBeCloseTo(90, 6)
    expect(radial.r).toBeCloseTo(950, 6)
    expect(radial.stops.map(s => s.a)).toEqual([0.12, 0.12, 0.12])
    expect(compiled.layers[0].stops.every(s => s.a === 1)).toBe(true)
  })

  it('base is the last stop of the first linear layer', () => {
    const compiled = compileBackdrop(
      customDef({mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'}),
      'light',
      {width: 1, height: 1},
    )!
    expect(compiled.base).toEqual(hexToRgb('#CCFFFF'))
  })

  it('none compiles to null', () => {
    expect(
      compileBackdrop(registryDef('none')!, 'light', {width: 1, height: 1}),
    ).toBeNull()
  })

  it('HSL round trip', () => {
    for (const hex of ['#5BCEFA', '#D52D00', '#808080', '#000000', '#FFFFFF']) {
      expect(rgbToHex(hslToRgb(rgbToHsl(hexToRgb(hex))))).toBe(hex)
    }
  })
})

describe('cssBackground (T5)', () => {
  const frame = {width: 1440, height: 900}

  it('the trans golden string', () => {
    const compiled = compileBackdrop(trans, 'light', frame, 'seen')!
    const css = cssBackground(compiled, [], frame, {x: 0, y: 0})
    expect(css.backgroundImage).toBe(
      'linear-gradient(122.01deg, #5BCEFA 0%, #5BCEFA 10%, #F5A9B8 20%, #F5A9B8 30%, #FFFFFF 40%, #FFFFFF 50%, #F5A9B8 60%, #F5A9B8 70%, #5BCEFA 80%, #5BCEFA 90%, #5BCEFA 100%)',
    )
    expect(css.backgroundSize).toBe('1440px 900px')
    expect(css.backgroundPosition).toBe('0px 0px')
    expect(css.backgroundRepeat).toBe('no-repeat')
    expect(css.backgroundColor).toBe('#5BCEFA')
  })

  it('overlays first, layers top first, rgba for alpha below 1, offsets', () => {
    const compiled = compileBackdrop(trans, 'light', frame, 'spec')!
    const css = cssBackground(compiled, ['rgba(0, 0, 0, 0.5)'], frame, {
      x: -12.345,
      y: -40,
    })
    const images = css.backgroundImage.split(/, (?=linear|radial)/)
    expect(images[0]).toBe(
      'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))',
    )
    expect(images[1]).toMatch(
      /^radial-gradient\(circle 1368px at 403.2px 162px, rgba\(255, 255, 255, 0.12\) 0%/,
    )
    expect(images[2]).toMatch(
      /^linear-gradient\(165deg, #5BCEFA 0%, #5BCEFA 20.39%/,
    )
    expect(css.backgroundSize).toBe('100% 100%, 1440px 900px, 1440px 900px')
    expect(css.backgroundPosition).toBe(
      '0px 0px, -12.35px -40px, -12.35px -40px',
    )
  })

  it('number formatting', () => {
    expect(formatNumber(122.00538, 2)).toBe('122.01')
    expect(formatNumber(10.000000000000002, 2)).toBe('10')
    expect(formatNumber(-0.0001, 2)).toBe('0')
    expect(formatNumber(0.12345, 3)).toBe('0.123')
  })
})
