import {StyleSheet, View} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {themes} from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {
  horizonInnerHeaderSticky,
  horizonTabBarBg,
  LENS_MIN_ALPHA,
  lensGlass,
  lensOverlays,
  windowActive,
  windowOverlays,
} from '#/horizon/backdrops/frame'
import {FrameLens} from '#/horizon/backdrops/FrameLens'
import {FrameWindow} from '#/horizon/backdrops/FrameWindow'
import {
  colorsUnderGlass,
  composite,
  contrast,
  GLASS,
} from '#/horizon/backdrops/glass'
import {
  INSET_READING_CARD_AVAILABLE,
  insetReadingCardOn,
} from '#/horizon/backdrops/inset'
import {ReadingSurface} from '#/horizon/backdrops/ReadingSurface.web'
import {BACKDROP_DEFS, registryDef} from '#/horizon/backdrops/registry'
import {type ThemeName} from '#/horizon/backdrops/types'

let mockInset = false

jest.mock('#/horizon/switches', () => ({
  BACKDROPS: true,
  COMPACT_FRAME_WINDOWS: false,
  APPEARANCE_SYNC: true,
}))
jest.mock('#/env', () => ({
  ...jest.requireActual<Record<string, unknown>>('#/env'),
  IS_WEB: true,
}))
jest.mock('#/alf', () => ({
  atoms: {
    fixed: {position: 'fixed'},
    inset_0: {top: 0, right: 0, bottom: 0, left: 0},
    scrollbar_offset: {transform: []},
    rounded_sm: {borderRadius: 8},
  },
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
  useBreakpoints: () => ({gtMobile: false}),
  useLayoutBreakpoints: () => ({centerColumnOffset: false}),
  web: (value: unknown) => value,
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
jest.mock('#/horizon/backdrops/ModeTrigger', () => ({
  FooterModeTrigger: () => null,
  HomeHeaderModeTrigger: () => null,
}))
jest.mock('#/horizon/backdrops/inset', () => ({
  ...jest.requireActual<Record<string, unknown>>('#/horizon/backdrops/inset'),
  useInsetReadingCard: () => mockInset,
}))

const THEMES: ThemeName[] = ['light', 'dim', 'dark']

beforeEach(() => {
  mockInset = false
  store.resetAppearanceStoreForTests()
})

function surfaceStyle() {
  const {UNSAFE_getByType} = render(<ReadingSurface />)
  return StyleSheet.flatten(UNSAFE_getByType(View).props.style) as Record<
    string,
    unknown
  >
}

describe('COMPACT_FRAME_WINDOWS off', () => {
  it('compact screens are stock: no window, no lens, stock values', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
    expect(render(<FrameWindow kind="drawer" />).toJSON()).toBeNull()
    act(() => store.setFrameStyle('buttons'))
    expect(render(<FrameLens kind="fab" />).toJSON()).toBeNull()
    expect(
      windowActive({
        def: registryDef('pride.trans')!,
        frameStyle: 'bars',
        kind: 'bottomBar',
        gtMobile: false,
        isWithinDialog: false,
      }),
    ).toBe(false)
    expect(horizonInnerHeaderSticky()).toBe(true)
    const t = themes.light
    expect(horizonTabBarBg(t, true)).toBe(t.atoms.bg)
  })

  it('the reading surface still covers the phone viewport', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(surfaceStyle()).toMatchObject({
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: themes.light.atoms.bg.backgroundColor,
    })
  })
})

describe('the inset reading card (3E)', () => {
  it('is behind its constant, off', () => {
    expect(INSET_READING_CARD_AVAILABLE).toBe(false)
  })

  it('needs the constant, the setting, a backdrop, web and < 800', () => {
    const def = registryDef('pride.trans')!
    const on = {
      def,
      insetCard: true,
      gtMobile: false,
      available: true,
      web: true,
    }
    expect(insetReadingCardOn(on)).toBe(true)
    expect(insetReadingCardOn({...on, available: false})).toBe(false)
    expect(insetReadingCardOn({...on, insetCard: false})).toBe(false)
    expect(insetReadingCardOn({...on, def: null})).toBe(false)
    expect(insetReadingCardOn({...on, web: false})).toBe(false)
    expect(insetReadingCardOn({...on, gtMobile: true})).toBe(false)
    expect(insetReadingCardOn({def, insetCard: true, gtMobile: false})).toBe(
      false,
    )
  })

  it('the surface becomes a card 8px in from each side, radius 16', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    mockInset = true
    const style = surfaceStyle()
    expect(style).toMatchObject({
      position: 'fixed',
      top: 0,
      bottom: 0,
      left: 8,
      right: 8,
      borderRadius: 16,
      backgroundColor: themes.light.atoms.bg.backgroundColor,
    })
  })
})

describe('the glass of windows and lenses', () => {
  it('a window uses the rail glass, then the veil in dark', () => {
    const trans = registryDef('pride.trans')!
    expect(windowOverlays(trans, 'light', false)).toEqual([
      'rgba(255, 255, 255, 0.55)',
    ])
    expect(windowOverlays(trans, 'dark', false)).toEqual([
      'rgba(0, 0, 0, 0.68)',
      'rgba(0, 0, 0, 0.18)',
    ])
    expect(windowOverlays(trans, 'light', true)).toEqual([
      'rgba(255, 255, 255, 0.85)',
    ])
  })

  it('every lens gives its icon 3:1 over every backdrop colour, from 0.20', () => {
    for (const def of BACKDROP_DEFS.slice(1)) {
      for (const theme of THEMES) {
        for (const kind of ['tab', 'headerButton', 'fab'] as const) {
          const {tint, alpha} = lensGlass(def, theme, kind)
          expect(alpha).toBeGreaterThanOrEqual(LENS_MIN_ALPHA)
          const icon =
            kind === 'fab'
              ? {r: 255, g: 255, b: 255}
              : (() => {
                  const hex = themes[theme].atoms.text.color.slice(1)
                  return {
                    r: parseInt(hex.slice(0, 2), 16),
                    g: parseInt(hex.slice(2, 4), 16),
                    b: parseInt(hex.slice(4, 6), 16),
                  }
                })()
          const worst = Math.min(
            ...colorsUnderGlass(def, theme).map(color =>
              contrast(composite(tint, color, alpha), icon),
            ),
          )
          if (alpha < 0.92) expect(worst).toBeGreaterThanOrEqual(3)
          // The smallest such alpha: one step less fails (unless at the floor).
          if (alpha > LENS_MIN_ALPHA && alpha < 0.92) {
            const less = Math.min(
              ...colorsUnderGlass(def, theme).map(color =>
                contrast(composite(tint, color, alpha - 0.01), icon),
              ),
            )
            expect(less).toBeLessThan(3)
          }
          if (kind === 'fab') expect(tint).toEqual({r: 0, g: 0, b: 0})
          else expect(tint).toEqual(GLASS[theme].tint)
        }
      }
    }
  })

  it('lens overlays: the tint, then the veil in dark; reduced floor 0.85', () => {
    const slate = registryDef('solids.slate')!
    const [tint, veil] = lensOverlays(slate, 'dark', 'fab', false)
    expect(tint).toMatch(/^rgba\(0, 0, 0, /)
    expect(veil).toBe('rgba(0, 0, 0, 0.18)')
    expect(lensOverlays(slate, 'light', 'tab', true)).toEqual([
      'rgba(255, 255, 255, 0.85)',
    ])
  })
})
