/*
 * Phase 3 batch A: the new Bars (bare windows, the items' shades) and the
 * performance fixes that are not the tracker (the fixed layer, the cache,
 * the stable def). The tracker is in `frame-window-test.tsx`.
 */

import {Text, View} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render, renderHook} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {stableDef, useActiveBackdrop} from '#/horizon/backdrops/active'
import {BackdropLayer} from '#/horizon/backdrops/BackdropLayer.web'
import {
  BarShade,
  BarSlot,
  useBarTextShade,
} from '#/horizon/backdrops/BarShade.web'
import {compileBackdrop, compileKey} from '#/horizon/backdrops/compile'
import {cssLayers} from '#/horizon/backdrops/css'
import {
  barShadesOn,
  barShadeVars,
  fixedLayerDrawn,
  haloAlpha,
  haloVar,
  SHADE_KINDS,
  SHADE_TARGET,
  shadeAlpha,
  shadeFill,
  shadeItemColors,
  type ShadeKind,
  shadeVar,
  type WindowKind,
  windowMode,
  windowOverlays,
  windowRange,
} from '#/horizon/backdrops/frame'
import {FRAME_STYLES} from '#/horizon/backdrops/frame-style'
import {
  composite,
  contrast,
  GLASS,
  type GradientRange,
  MAX_GLASS_ALPHA,
  sampledColors,
} from '#/horizon/backdrops/glass'
import {BACKDROP_DEFS, registryDef} from '#/horizon/backdrops/registry'
import {DEFAULT_SOFTNESS, softnessAmount} from '#/horizon/backdrops/softness'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

let mockTheme: ThemeName = 'light'
let mockGtMobile = false
let mockWithinDialog = false
let mockReduced = true
const mockFrame = {width: 390, height: 844}

jest.mock('#/horizon/backdrops/glass', () => ({
  ...jest.requireActual<Record<string, unknown>>('#/horizon/backdrops/glass'),
  prefersReducedTransparency: () => mockReduced,
}))

jest.mock('#/horizon/switches', () => ({
  BACKDROPS: true,
  COMPACT_FRAME_WINDOWS: true,
  APPEARANCE_SYNC: true,
}))
jest.mock('#/env', () => ({
  ...jest.requireActual<Record<string, unknown>>('#/env'),
  IS_WEB: true,
}))
jest.mock('#/alf', () => ({
  atoms: {rounded_sm: {borderRadius: 8}, overflow_hidden: {}},
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes[mockTheme],
  useBreakpoints: () => ({gtMobile: mockGtMobile}),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined, hasSession: false}),
}))
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => undefined,
  writeDeviceJson: () => {},
  subscribeDeviceJson: () => () => {},
}))
jest.mock('#/components/Dialog/context', () => ({
  useDialogContext: () => ({isWithinDialog: mockWithinDialog}),
}))
jest.mock('#/horizon/backdrops/viewport', () => ({
  useViewportFrame: () => mockFrame,
}))

const THEMES: ThemeName[] = ['light', 'dim', 'dark']
const DEFS = BACKDROP_DEFS.filter(def => def.id !== 'none')
const trans = registryDef('pride.trans')!

function softened(def: BackdropDef, theme: ThemeName): BackdropDef {
  const soften = softnessAmount(DEFAULT_SOFTNESS, theme)
  return soften > 0 ? {...def, soften} : def
}

type Json = {
  type: string
  props: {style?: Record<string, unknown>}
  children: (Json | string)[] | null
}

function divs(json: unknown): Json[] {
  const out: Json[] = []
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const n = node as Json
    if (n.type === 'div') out.push(n)
    n.children?.forEach(walk)
  }
  walk(json)
  return out
}

beforeEach(() => {
  // The box look; the halo tests turn it off.
  mockReduced = true
  mockTheme = 'light'
  mockGtMobile = false
  mockWithinDialog = false
  store.resetAppearanceStoreForTests()
})

describe('Bars: the windows are bare (batch A, item 1)', () => {
  it('a bare window lays no glass', () => {
    for (const theme of THEMES) {
      expect(windowOverlays(trans, theme, 'bare', false)).toEqual([])
      expect(windowOverlays(trans, theme, 'bare', true)).toEqual([])
    }
  })

  it('shades render with Bars, a backdrop, on web, outside dialogs', () => {
    const base = {
      def: trans,
      frameStyle: 'bars' as const,
      kind: 'tab' as ShadeKind,
      gtMobile: false,
      isWithinDialog: false,
      web: true,
    }
    expect(barShadesOn(base)).toBe(true)
    expect(barShadesOn({...base, def: null})).toBe(false)
    expect(barShadesOn({...base, web: false})).toBe(false)
    expect(barShadesOn({...base, isWithinDialog: true})).toBe(false)
    for (const frameStyle of FRAME_STYLES) {
      if (frameStyle === 'bars' || frameStyle === 'headerBand') continue
      expect(barShadesOn({...base, frameStyle})).toBe(false)
    }
    // From 800 up only the signed-out bar's logo group (a window to 1300).
    expect(barShadesOn({...base, gtMobile: true})).toBe(false)
    expect(barShadesOn({...base, gtMobile: true, kind: 'brand'})).toBe(true)
  })
})

describe('Header goes bare like Bars (round 2 list, item 4)', () => {
  const base = {
    def: trans,
    frameStyle: 'headerBand' as const,
    gtMobile: false,
    isWithinDialog: false,
    web: true,
  }

  it('the top bars are bare windows, the bottom bar stock, the drawer glass', () => {
    const mode = (kind: WindowKind, web = true) =>
      windowMode({...base, kind, web})
    expect(mode('homeHeader')).toBe('bare')
    expect(mode('header')).toBe('bare')
    expect(mode('bottomBar')).toBeNull()
    expect(mode('drawer')).toBe('full')
    // Native keeps the glass, as with Bars.
    expect(mode('homeHeader', false)).toBe('full')
    // No glass over the backdrop, as with Bars.
    expect(windowOverlays(trans, 'dark', 'bare', false)).toEqual([])
  })

  it('the top bars items get shades, the bottom bar items do not', () => {
    for (const kind of [
      'button',
      'title',
      'subtitle',
      'label',
      'logo',
    ] as const) {
      expect(barShadesOn({...base, kind})).toBe(true)
      expect(barShadesOn({...base, kind, gtMobile: true})).toBe(false)
      expect(barShadesOn({...base, kind, isWithinDialog: true})).toBe(false)
    }
    expect(barShadesOn({...base, kind: 'tab'})).toBe(false)
    expect(barShadesOn({...base, kind: 'brand'})).toBe(false)
    expect(barShadesOn({...base, kind: 'brand', gtMobile: true})).toBe(false)
  })

  it('the shade components render for the top bars only', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    act(() => store.setFrameStyle('headerBand'))
    expect(render(<BarShade kind="title" />).toJSON()).not.toBeNull()
    expect(render(<BarShade kind="logo" />).toJSON()).not.toBeNull()
    expect(render(<BarShade kind="tab" />).toJSON()).toBeNull()
    expect(render(<BarShade kind="brand" />).toJSON()).toBeNull()
    expect(
      divs(
        render(
          <BarSlot>
            <View />
          </BarSlot>,
        ).toJSON(),
      ),
    ).toHaveLength(1)
  })

  it('vibrant at softness 0, duller as softness rises', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    act(() => store.setFrameStyle('headerBand'))
    mockTheme = 'dark'
    act(() => store.setBackdropSoftness('dark', 0))
    const raw = renderHook(() => useActiveBackdrop()).result.current
    expect(raw?.soften ?? 0).toBe(0)
    act(() => store.setBackdropSoftness('dark', 60))
    const soft = renderHook(() => useActiveBackdrop()).result.current
    expect(soft?.soften).toBeGreaterThan(0)
    // The header strip of the softened backdrop is duller: lower saturation.
    const range: GradientRange = [0, 0.2]
    const chroma = (def: BackdropDef) =>
      Math.max(
        ...sampledColors(def, 'dark', undefined, range).map(
          c => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b),
        ),
      )
    expect(chroma(soft!)).toBeLessThan(chroma(raw!))
  })
})

describe('the shades keep their item at 3:1 (batch A, item 1)', () => {
  it('every kind, backdrop and theme, over the whole backdrop', () => {
    for (const def of DEFS) {
      for (const theme of THEMES) {
        const d = softened(def, theme)
        const under = sampledColors(d, theme)
        for (const kind of SHADE_KINDS) {
          const alpha = shadeAlpha(d, theme, kind)
          expect(alpha).toBeGreaterThanOrEqual(0)
          expect(alpha).toBeLessThanOrEqual(MAX_GLASS_ALPHA)
          if (alpha >= MAX_GLASS_ALPHA) continue
          for (const item of shadeItemColors(theme, kind)) {
            const worst = Math.min(
              ...under.map(color =>
                contrast(composite(GLASS[theme].tint, color, alpha), item),
              ),
            )
            expect(worst).toBeGreaterThanOrEqual(SHADE_TARGET)
          }
        }
      }
    }
  })

  it('the smallest such alpha: one step less misses 3:1', () => {
    const d = softened(trans, 'dark')
    const under = sampledColors(d, 'dark')
    const alpha = shadeAlpha(d, 'dark', 'button')
    expect(alpha).toBeGreaterThan(0)
    const [icon] = shadeItemColors('dark', 'button')
    const worst = Math.min(
      ...under.map(color =>
        contrast(composite(GLASS.dark.tint, color, alpha - 0.01), icon),
      ),
    )
    expect(worst).toBeLessThan(SHADE_TARGET)
  })

  it('a window sees only its part of the gradient, so never more shade', () => {
    const d = softened(trans, 'dark')
    const header = windowRange(d, 'dark', mockFrame, {
      left: 0,
      top: 0,
      width: 390,
      height: 95,
    })
    const bar = windowRange(d, 'dark', mockFrame, {
      left: 0,
      top: 790,
      width: 390,
      height: 54,
    })
    expect(header[0]).toBe(0)
    expect(header[1]).toBeLessThan(0.3)
    expect(bar[0]).toBeGreaterThan(0.7)
    expect(bar[1]).toBe(1)
    // Widened to 0.02 steps.
    for (const t of [...header, ...bar]) {
      expect(Math.round(t * 50)).toBeCloseTo(t * 50, 6)
    }
    expect(
      windowRange(d, 'dark', mockFrame, {
        left: 0,
        top: 0,
        width: 390,
        height: 844,
      }),
    ).toEqual([0, 1])
    for (const kind of SHADE_KINDS) {
      expect(shadeAlpha(d, 'dark', kind, header)).toBeLessThanOrEqual(
        shadeAlpha(d, 'dark', kind),
      )
    }
    // Trans's white stripe is mid-screen: the header needs less shade.
    expect(shadeAlpha(d, 'dark', 'title', header)).toBeLessThan(
      shadeAlpha(d, 'dark', 'title'),
    )
  })

  it('a range samples inside it and at its ends', () => {
    const all = sampledColors(trans, 'light')
    expect(sampledColors(trans, 'light', undefined, [0, 1])).toEqual(all)
    const part: GradientRange = [0.1, 0.3]
    const some = sampledColors(trans, 'light', undefined, part)
    expect(some.length).toBeLessThan(all.length)
    expect(some.length).toBeGreaterThan(2)
  })

  it('one stable set of variables per def, theme, range and flag', () => {
    const vars = barShadeVars(trans, 'dark', [0, 0.2], false)
    expect(barShadeVars(trans, 'dark', [0, 0.2], false)).toBe(vars)
    expect(Object.keys(vars).sort()).toEqual(
      [...SHADE_KINDS.map(shadeVar), ...SHADE_KINDS.map(haloVar)].sort(),
    )
    for (const value of Object.values(vars)) {
      expect(value).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/)
    }
    const reduced = barShadeVars(trans, 'dark', [0, 0.2], true)
    for (const kind of SHADE_KINDS) {
      const value = reduced[shadeVar(kind)]
      const alpha = Number(/, ([\d.]+)\)$/.exec(value)![1])
      expect(alpha).toBeGreaterThanOrEqual(0.85)
    }
  })
})

describe('the shades keep the theme`s hue over bright backdrops', () => {
  const chroma = (c: {r: number; g: number; b: number}) =>
    Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)

  it('every kind, backdrop and theme still meets 3:1', () => {
    for (const def of DEFS) {
      for (const theme of THEMES) {
        const d = softened(def, theme)
        const under = sampledColors(d, theme)
        for (const kind of SHADE_KINDS) {
          const fill = shadeFill(d, theme, kind)
          expect(fill.alpha).toBeGreaterThanOrEqual(shadeAlpha(d, theme, kind))
          if (fill.alpha === 0 || fill.alpha >= MAX_GLASS_ALPHA) continue
          for (const item of shadeItemColors(theme, kind)) {
            const worst = Math.min(
              ...under.map(color =>
                contrast(composite(fill.color, color, fill.alpha), item),
              ),
            )
            expect(worst).toBeGreaterThanOrEqual(SHADE_TARGET)
          }
        }
      }
    }
  })

  it('over vivid yellow in dark, a near-neutral chip, not olive', () => {
    // Softness 0, as in the live check: the yellow at full strength.
    for (const id of ['solids.yellow', 'pride.intersex']) {
      const d = registryDef(id)!
      const range: GradientRange = [0, 0.2]
      const under = sampledColors(d, 'dark', undefined, range)
      const mean = {
        r: under.reduce((s, c) => s + c.r, 0) / under.length,
        g: under.reduce((s, c) => s + c.g, 0) / under.length,
        b: under.reduce((s, c) => s + c.b, 0) / under.length,
      }
      for (const kind of ['label', 'title'] as const) {
        const fill = shadeFill(d, 'dark', kind, range)
        expect(fill.alpha).toBeGreaterThan(0)
        const old = composite(
          GLASS.dark.tint,
          mean,
          shadeAlpha(d, 'dark', kind, range),
        )
        const now = composite(fill.color, mean, fill.alpha)
        expect(chroma(now)).toBeLessThan(chroma(old) / 2)
      }
    }
  })
})

describe('the halo look (live check, 2026-10-20)', () => {
  type Node = {type: string; props: Record<string, unknown>}
  const spans = (json: unknown): Node[] => {
    const out: Node[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const n = node as Node & {children?: unknown[]}
      if (n.type === 'span') out.push(n)
      n.children?.forEach(walk)
    }
    walk(json)
    return out
  }

  it('a hidden marker instead of a box, and no box padding on titles', () => {
    mockReduced = false
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    const tab = render(<BarShade kind="tab" />).toJSON()
    expect(divs(tab)).toHaveLength(0)
    expect(spans(tab)).toHaveLength(1)
    expect(spans(tab)[0].props.style).toEqual({display: 'none'})
    const slot = render(
      <BarSlot>
        <View />
      </BarSlot>,
    ).toJSON()
    expect(divs(slot)).toHaveLength(0)
    expect(spans(slot)).toHaveLength(1)
    expect(
      renderHook(() => useBarTextShade('title')).result.current,
    ).toBeUndefined()
    // Off with the other frames, as the boxes are.
    act(() => store.setFrameStyle('edges'))
    expect(render(<BarShade kind="tab" />).toJSON()).toBeNull()
  })

  it('no halo where no shade is needed, denser than the box elsewhere', () => {
    expect(haloAlpha(0)).toBe(0)
    expect(haloAlpha(0.3)).toBeGreaterThan(0.3)
    expect(haloAlpha(0.9)).toBeLessThanOrEqual(0.95)
    const vars = barShadeVars(trans, 'dark', [0, 0.2], false)
    for (const kind of SHADE_KINDS) {
      expect(vars[haloVar(kind)]).toMatch(/^rgba\(0, 0, 0, [\d.]+\)$/)
    }
  })
})

describe('the shade components on web (batch A, item 1)', () => {
  it('a shade paints its kind`s variable, softly, under its item', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    const [shade] = divs(render(<BarShade kind="tab" />).toJSON())
    expect(shade.props.style).toMatchObject({
      position: 'absolute',
      zIndex: -1,
      pointerEvents: 'none',
      backgroundColor: 'var(--horizon-shade-tab, transparent)',
      maskComposite: 'intersect',
      top: 6,
      left: '50%',
      width: 52,
      height: 40,
    })
    expect(String(shade.props.style?.maskImage)).toContain(
      'linear-gradient(to right, transparent 0px, #000 12px',
    )
    expect(render(<BarShade kind="tab" show={false} />).toJSON()).toBeNull()
  })

  it('no shade with another frame, without a backdrop, or from 800 up', () => {
    expect(render(<BarShade kind="tab" />).toJSON()).toBeNull()
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    mockGtMobile = true
    expect(render(<BarShade kind="title" />).toJSON()).toBeNull()
    expect(render(<BarShade kind="brand" />).toJSON()).not.toBeNull()
    mockGtMobile = false
    act(() => store.setFrameStyle('edges'))
    expect(render(<BarShade kind="tab" />).toJSON()).toBeNull()
    expect(render(<BarShade kind="title" />).toJSON()).toBeNull()
  })

  it('a slot: one shade, none when empty, none twice when nested', () => {
    const slot = (children?: React.ReactNode) =>
      divs(render(<BarSlot>{children}</BarSlot>).toJSON())
    // Inactive: the children only.
    expect(slot(<View />)).toHaveLength(0)
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(slot(<View />)).toHaveLength(1)
    expect(slot()).toHaveLength(0)
    expect(slot(false)).toHaveLength(0)
    expect(
      slot(
        <BarSlot>
          <View />
        </BarSlot>,
      ),
    ).toHaveLength(1)
    const [shade] = slot(<View />)
    expect(shade.props.style?.backgroundColor).toBe(
      'var(--horizon-shade-button, transparent)',
    )
  })

  it('a title hugs its text, the margins keeping it in place', () => {
    const style = () =>
      renderHook(() => useBarTextShade('title')).result.current
    expect(style()).toBeUndefined()
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(style()).toEqual({
      alignSelf: 'flex-start',
      paddingLeft: 12,
      paddingRight: 12,
      marginLeft: -12,
      marginRight: -12,
      paddingTop: 6,
      paddingBottom: 6,
      marginTop: -6,
      marginBottom: -6,
    })
    // A centred title stays centred.
    expect(
      renderHook(() => useBarTextShade('title', {textAlign: 'center'})).result
        .current?.alignSelf,
    ).toBe('center')
    // The title's shade sits inside it, filling its box.
    const [shade] = divs(
      render(
        <Text>
          <BarShade kind="title" />
          Title
        </Text>,
      ).toJSON(),
    )
    expect(shade.props.style).toMatchObject({top: 0, right: 0, left: 0})
  })
})

describe('the fixed layer (7c)', () => {
  it('below 800 only Gutter shows it; from 800 every style', () => {
    for (const frameStyle of FRAME_STYLES) {
      expect(fixedLayerDrawn({frameStyle, gtMobile: true})).toBe(true)
      expect(fixedLayerDrawn({frameStyle, gtMobile: false})).toBe(
        frameStyle === 'gutter',
      )
    }
  })

  it('promoted and contained; not drawn below 800 with Bars', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(render(<BackdropLayer active />).toJSON()).toBeNull()
    act(() => store.setFrameStyle('gutter'))
    const [layer] = divs(render(<BackdropLayer active />).toJSON())
    expect(layer.props.style).toMatchObject({
      position: 'fixed',
      inset: 0,
      willChange: 'transform',
      contain: 'strict',
      backgroundSize: '390px 844px',
    })
    act(() => store.setFrameStyle('bars'))
    mockGtMobile = true
    expect(render(<BackdropLayer active />).toJSON()).not.toBeNull()
  })
})

describe('the compile cache and the stable def (7d)', () => {
  it('the same backdrop, theme, softness and size compile once', () => {
    const a = compileBackdrop(trans, 'dark', mockFrame)
    expect(compileBackdrop(trans, 'dark', {width: 390, height: 844})).toBe(a)
    expect(compileBackdrop({...trans}, 'dark', mockFrame)).toBe(a)
    expect(
      compileBackdrop({...trans, soften: 0.5}, 'dark', mockFrame),
    ).not.toBe(a)
    expect(compileBackdrop(trans, 'dim', mockFrame)).not.toBe(a)
    expect(compileBackdrop(trans, 'dark', {width: 391, height: 844})).not.toBe(
      a,
    )
    expect(cssLayers(a!, mockFrame)).toBe(cssLayers(a!, mockFrame))
  })

  it('the key tells every compiled input apart', () => {
    const key = compileKey(trans)
    expect(compileKey({...trans, soften: 0.4})).not.toBe(key)
    expect(compileKey({...trans, stripes: ['#000000']})).not.toBe(key)
    expect(compileKey({...trans, lockColors: !trans.lockColors})).not.toBe(key)
    expect(compileKey({...trans, bloomOpacity: 0.123})).not.toBe(key)
  })

  it('the active def keeps its identity across renders, softened too', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    mockTheme = 'dark'
    const {result, rerender} = renderHook(() => useActiveBackdrop())
    const first = result.current
    expect(first?.soften).toBeGreaterThan(0)
    rerender({})
    expect(result.current).toBe(first)
    expect(stableDef({...first!})).toBe(first)
  })
})
