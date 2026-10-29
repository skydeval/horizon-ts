/*
 * Live fix batch 1: the phone frame styles (Edges, Gutter, Header; Header
 * bare since the round 2 list, which also retired Buttons and its lenses)
 * and the backdrop softness of dim and dark.
 */

import {createContext as mockCreateContext} from 'react'
import {View} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {compileBackdrop, type RGB, rgbToHsl} from '#/horizon/backdrops/compile'
import {
  EDGE_BAND,
  type WindowKind,
  windowMode,
  windowOverlays,
} from '#/horizon/backdrops/frame'
import {
  FRAME_STYLES,
  type FrameStyle,
  parseFrameStyle,
} from '#/horizon/backdrops/frame-style'
import {FrameWindow} from '#/horizon/backdrops/FrameWindow'
import {insetReadingCardOn, sidesStripsOn} from '#/horizon/backdrops/inset'
import {registryDef} from '#/horizon/backdrops/registry'
import {
  DEFAULT_SOFTNESS,
  softenRgb,
  softnessAmount,
} from '#/horizon/backdrops/softness'
import {type ThemeName} from '#/horizon/backdrops/types'

let mockTheme: ThemeName = 'light'
const mockFrame = {width: 390, height: 844}

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
  useBreakpoints: () => ({gtMobile: false}),
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
  useDialogContext: () => ({isWithinDialog: false}),
}))
jest.mock('#/lib/hooks/useHideBottomBarBorder', () => ({
  useHideBottomBarBorder: () => false,
}))
jest.mock('#/horizon/backdrops/ModeTrigger', () => ({
  FooterModeTrigger: () => null,
  HomeHeaderModeTrigger: () => null,
}))
jest.mock('@react-navigation/native', () => ({
  NavigationContainerRefContext: mockCreateContext(undefined),
}))
// The web painter, as the web bundle resolves it.
jest.mock('#/horizon/backdrops/BackdropWindow', () =>
  jest.requireActual('#/horizon/backdrops/BackdropWindow.web'),
)
jest.mock('#/horizon/backdrops/viewport', () => ({
  useViewportFrame: () => mockFrame,
}))

const trans = registryDef('pride.trans')!

beforeEach(() => {
  mockTheme = 'light'
  store.resetAppearanceStoreForTests()
})

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

describe('Buttons is retired (round 2 list, item 3)', () => {
  it('the picker offers four styles; a stored Buttons reads as Bars', () => {
    expect(FRAME_STYLES).toEqual(['bars', 'edges', 'gutter', 'headerBand'])
    expect(parseFrameStyle('buttons')).toBe('bars')
    expect(parseFrameStyle('buttons', true)).toBe('bars')
  })
})

describe('phone frame styles (live fix 1)', () => {
  const base = {def: trans, gtMobile: false, isWithinDialog: false}
  const mode = (frameStyle: FrameStyle, kind: WindowKind) =>
    windowMode({...base, frameStyle, kind})

  it('which pieces each style draws, and how', () => {
    const table = Object.fromEntries(
      FRAME_STYLES.map(style => [
        style,
        (['homeHeader', 'header', 'bottomBar', 'drawer'] as const).map(kind =>
          mode(style, kind),
        ),
      ]),
    )
    expect(table).toEqual({
      bars: ['bare', 'bare', 'bare', 'full'],
      edges: ['edge', 'edge', 'edge', 'full'],
      gutter: [null, null, null, 'full'],
      headerBand: ['bare', 'bare', null, 'full'],
    })
    // Bare in the app too, which draws its own halo (BarHalo)
    expect(
      windowMode({...base, frameStyle: 'bars', kind: 'bottomBar', web: false}),
    ).toBe('bare')
    // In the app every screen's header is a window: bare for Bars and
    // Header, the band for Edges
    expect(
      windowMode({...base, frameStyle: 'bars', kind: 'header', web: false}),
    ).toBe('bare')
    expect(
      windowMode({
        ...base,
        frameStyle: 'headerBand',
        kind: 'header',
        web: false,
      }),
    ).toBe('bare')
    expect(
      windowMode({...base, frameStyle: 'edges', kind: 'header', web: false}),
    ).toBe('edge')
    // On web, headers stay part of the opaque column at 800 and up.
    expect(
      windowMode({
        ...base,
        frameStyle: 'edges',
        kind: 'header',
        gtMobile: true,
      }),
    ).toBeNull()
  })

  it('Edges: a 4px band, no glass, along the header and the bottom bar', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    act(() => store.setFrameStyle('edges'))
    const [header, headerBackdrop] = divs(
      render(<FrameWindow kind="header" />).toJSON(),
    )
    expect(header.props.style).toMatchObject({
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: EDGE_BAND,
      zIndex: -1,
    })
    expect(headerBackdrop.props.style?.backgroundSize).toBe('390px 844px')
    expect(header.props.style?.top).toBeUndefined()
    const barDivs = divs(render(<FrameWindow kind="bottomBar" />).toJSON())
    const [bar] = barDivs
    expect(bar.props.style?.top).toBeLessThan(0)
    expect(Number(bar.props.style?.height)).toBeGreaterThan(EDGE_BAND)
    expect(bar.props.style?.bottom).toBeUndefined()
    // The clip and the backdrop only: no glass layer.
    expect(barDivs).toHaveLength(2)
    expect(windowOverlays(trans, 'dark', 'edge', false)).toEqual([])
  })

  it('Header: the top bars bare like Bars, the tab bar stock', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    act(() => store.setFrameStyle('headerBand'))
    const [, backdrop, ...rest] = divs(
      render(<FrameWindow kind="homeHeader" />).toJSON(),
    )
    // The clip and the backdrop only: no glass layer.
    expect(rest).toEqual([])
    expect(String(backdrop.props.style?.backgroundImage)).toMatch(
      /^linear-gradient\(\d/,
    )
    expect(render(<FrameWindow kind="header" />).toJSON()).not.toBeNull()
    expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
  })

  it('Gutter: the inset card below 800 on web, stock bars', () => {
    const on = {def: trans, frameStyle: 'gutter' as const, gtMobile: false}
    expect(insetReadingCardOn({...on, web: true})).toBe(true)
    expect(insetReadingCardOn({...on, web: false})).toBe(false)
    expect(insetReadingCardOn({...on, web: true, gtMobile: true})).toBe(false)
    expect(insetReadingCardOn({...on, web: true, def: null})).toBe(false)
    for (const style of FRAME_STYLES) {
      if (style === 'gutter') continue
      expect(insetReadingCardOn({...on, web: true, frameStyle: style})).toBe(
        false,
      )
    }
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    act(() => store.setFrameStyle('gutter'))
    expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
    expect(render(<FrameWindow kind="drawer" />).toJSON()).not.toBeNull()
  })

  it('Sides in the app: strips instead of the card, below 800 only', () => {
    const on = {def: trans, frameStyle: 'gutter' as const, gtMobile: false}
    expect(sidesStripsOn({...on, web: false})).toBe(true)
    // Web draws the card instead
    expect(sidesStripsOn({...on, web: true})).toBe(false)
    expect(sidesStripsOn({...on, web: false, gtMobile: true})).toBe(false)
    expect(sidesStripsOn({...on, web: false, def: null})).toBe(false)
    for (const style of FRAME_STYLES) {
      if (style === 'gutter') continue
      expect(sidesStripsOn({...on, web: false, frameStyle: style})).toBe(false)
    }
  })
})

describe('backdrop softness (live fix 1)', () => {
  const RED: RGB = {r: 228, g: 3, b: 3}
  const PASTEL: RGB = {r: 255, g: 226, b: 255}
  const BLACK: RGB = {r: 0, g: 0, b: 0}

  it('light and 0 keep the full colours', () => {
    expect(softenRgb(RED, 'light', 1)).toEqual(RED)
    expect(softenRgb(RED, 'dark', 0)).toEqual(RED)
    expect(softnessAmount({dim: 40, dark: 50}, 'light')).toBe(0)
    expect(softnessAmount({dim: 40, dark: 50}, 'dark')).toBe(0.5)
  })

  it('calms without darkening: hue kept, saturation and brightness down', () => {
    for (const theme of ['dim', 'dark'] as const) {
      const amount = DEFAULT_SOFTNESS[theme] / 100
      const red = softenRgb(RED, theme, amount)
      const before = rgbToHsl(RED)
      const after = rgbToHsl(red)
      const turn = Math.abs(after.h - before.h) % 360
      expect(Math.min(turn, 360 - turn)).toBeLessThan(6)
      expect(after.s).toBeLessThan(before.s)
      expect(after.s).toBeGreaterThan(0.4)
      const pastel = softenRgb(PASTEL, theme, amount)
      expect(pastel.r + pastel.g + pastel.b).toBeLessThan(
        PASTEL.r + PASTEL.g + PASTEL.b,
      )
      // Modestly: a bright pastel stays light, a black lifts a little.
      expect(Math.min(pastel.r, pastel.g, pastel.b)).toBeGreaterThan(170)
      const black = softenRgb(BLACK, theme, amount)
      expect(black.r).toBeGreaterThan(0)
      expect(black.r).toBeLessThan(40)
    }
    // Stronger is softer.
    const half = rgbToHsl(softenRgb(RED, 'dark', 0.5))
    const full = rgbToHsl(softenRgb(RED, 'dark', 1))
    expect(full.s).toBeLessThan(half.s)
  })

  it('the compiler treats every stop and the base, flags included', () => {
    const plain = compileBackdrop(trans, 'dark', mockFrame)!
    const soft = compileBackdrop({...trans, soften: 0.5}, 'dark', mockFrame)!
    expect(soft.layers[0].stops[0]).toMatchObject(
      softenRgb(plain.layers[0].stops[0], 'dark', 0.5),
    )
    expect(soft.base).toEqual(softenRgb(plain.base, 'dark', 0.5))
    // Light ignores it.
    expect(
      compileBackdrop({...trans, soften: 0.5}, 'light', mockFrame),
    ).toEqual(compileBackdrop(trans, 'light', mockFrame))
  })

  function Probe() {
    const def = useActiveBackdrop()
    return <View testID={`soften-${def?.soften ?? 0}`} />
  }

  it('the active def carries the softness of this device for the theme', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(render(<Probe />).getByTestId('soften-0')).toBeTruthy()
    mockTheme = 'dark'
    expect(render(<Probe />).getByTestId('soften-0.5')).toBeTruthy()
    mockTheme = 'dim'
    expect(render(<Probe />).getByTestId('soften-0.4')).toBeTruthy()
    act(() => store.setBackdropSoftness('dim', 0))
    expect(render(<Probe />).getByTestId('soften-0')).toBeTruthy()
  })
})
