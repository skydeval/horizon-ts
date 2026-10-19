import {describe, expect, it} from '@jest/globals'

import {compileBackdrop, type RGB} from '#/horizon/backdrops/compile'
import {BACKDROP_DEFS, registryDef} from '#/horizon/backdrops/registry'
import {isPaleSwatch, swatchDef} from '#/horizon/backdrops/swatch'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

const PALE = [
  'materials.paper',
  'materials.glass',
  'materials.granite',
  'materials.fabric',
  'materials.clay',
  'materials.fog',
  'materials.inkwash',
  'solids.mist',
]

function toLab({r, g, b}: RGB) {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const R = lin(r)
  const G = lin(g)
  const B = lin(b)
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return {
    L: 116 * f(Y) - 16,
    A: 500 * (f(X) - f(Y)),
    B: 200 * (f(Y) - f(Z)),
  }
}

/* The seen gradient sampled at 21 evenly spaced positions. */
function samples(def: BackdropDef, theme: ThemeName): RGB[] {
  const stops = compileBackdrop(swatchDef(def, theme), theme, {
    width: 36,
    height: 36,
  })!.layers[0].stops
  const out: RGB[] = []
  for (let i = 0; i <= 20; i++) {
    const p = i / 20
    let j = 0
    while (j < stops.length - 2 && stops[j + 1].pos < p) j++
    const s = stops[j]
    const e = stops[j + 1]
    const f = e.pos === s.pos ? 0 : (p - s.pos) / (e.pos - s.pos)
    out.push({
      r: s.r + (e.r - s.r) * f,
      g: s.g + (e.g - s.g) * f,
      b: s.b + (e.b - s.b) * f,
    })
  }
  return out
}

function distance(x: BackdropDef, y: BackdropDef, theme: ThemeName) {
  const a = samples(x, theme)
  const b = samples(y, theme)
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const p = toLab(a[i])
    const q = toLab(b[i])
    sum += Math.hypot(p.L - q.L, p.A - q.A, p.B - q.B)
  }
  return sum / a.length
}

describe('swatches (T8)', () => {
  it('the pale set is the 7 materials and Mist, in dim and dark only', () => {
    for (const theme of ['dim', 'dark'] as const) {
      const pale = BACKDROP_DEFS.filter(def => isPaleSwatch(def, theme)).map(
        def => def.id,
      )
      expect(pale).toEqual(PALE)
    }
    expect(BACKDROP_DEFS.some(def => isPaleSwatch(def, 'light'))).toBe(false)
  })

  it('stretches only the swatch of a pale def', () => {
    const paper = registryDef('materials.paper')!
    expect(swatchDef(paper, 'light')).toBe(paper)
    expect(swatchDef(paper, 'dark').stripes[0]).toBe('#EDE3D1')
    const trans = registryDef('pride.trans')!
    expect(swatchDef(trans, 'dark')).toBe(trans)
  })

  it('keeps the pale swatches at least 5.0 apart in dim and dark', () => {
    const pale = PALE.map(id => registryDef(id)!)
    for (const theme of ['dim', 'dark'] as const) {
      for (let i = 0; i < pale.length; i++) {
        for (let j = i + 1; j < pale.length; j++) {
          expect(distance(pale[i], pale[j], theme)).toBeGreaterThanOrEqual(5)
        }
      }
    }
  })
})
