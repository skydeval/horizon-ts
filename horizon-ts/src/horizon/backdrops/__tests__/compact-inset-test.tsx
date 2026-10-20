import {StyleSheet, View} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {themes} from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {
  horizonInnerHeaderSticky,
  horizonTabBarBg,
  windowActive,
} from '#/horizon/backdrops/frame'
import {FrameLens} from '#/horizon/backdrops/FrameLens'
import {FrameWindow} from '#/horizon/backdrops/FrameWindow'
import {insetReadingCardOn} from '#/horizon/backdrops/inset'
import {ReadingSurface} from '#/horizon/backdrops/ReadingSurface.web'
import {registryDef} from '#/horizon/backdrops/registry'

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

beforeEach(() => {
  mockInset = false
  store.resetAppearanceStoreForTests()
})

/** The surface's views' styles, in order. */
function surfaceStyles() {
  const {UNSAFE_getAllByType} = render(<ReadingSurface />)
  return UNSAFE_getAllByType(View).map(
    view => StyleSheet.flatten(view.props.style) as Record<string, unknown>,
  )
}

function surfaceStyle() {
  return surfaceStyles()[0]
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

describe('the Gutter frame (3E) with the compact frame off', () => {
  it('is not drawn, even with Gutter picked', () => {
    const def = registryDef('pride.trans')!
    expect(
      insetReadingCardOn({def, frameStyle: 'gutter', gtMobile: false}),
    ).toBe(false)
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

  it('an opaque core clear of the corners lets the compositor cull (round 2)', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    mockInset = true
    const [card, core, ...rest] = surfaceStyles()
    expect(rest).toEqual([])
    // Inside the card: the same sides, in from the top and bottom by the
    // radius, so it never reaches a rounded corner; the card's colour.
    expect(core).toEqual({
      position: 'fixed',
      top: card.borderRadius,
      bottom: card.borderRadius,
      left: card.left,
      right: card.right,
      backgroundColor: card.backgroundColor,
    })
    expect(core.borderRadius).toBeUndefined()
  })

  it('no core without the inset card', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(surfaceStyles()).toHaveLength(1)
  })
})
