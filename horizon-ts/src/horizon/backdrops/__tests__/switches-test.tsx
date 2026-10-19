import {Text, View} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {DefaultTheme} from '@react-navigation/native'
import {act, render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {themes} from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {BackdropLayer} from '#/horizon/backdrops/BackdropLayer.web'
import {
  horizonInnerHeaderSticky,
  horizonTabBarBg,
  lensActive,
  windowActive,
} from '#/horizon/backdrops/frame'
import {FrameLens} from '#/horizon/backdrops/FrameLens'
import {FrameWindow} from '#/horizon/backdrops/FrameWindow'
import {
  insetReadingCardOn,
  useInsetReadingGutter,
} from '#/horizon/backdrops/inset'
import {
  horizonContentStyle,
  horizonNavTheme,
  horizonOpaque,
} from '#/horizon/backdrops/nav'
import {RailCard} from '#/horizon/backdrops/RailCard'
import {ReadingSurface} from '#/horizon/backdrops/ReadingSurface.web'
import {registryDef} from '#/horizon/backdrops/registry'

let mockGtMobile = true

jest.mock('#/horizon/switches', () => ({
  BACKDROPS: false,
  COMPACT_FRAME_WINDOWS: true,
  APPEARANCE_SYNC: true,
}))
jest.mock('#/env', () => ({
  ...jest.requireActual<Record<string, unknown>>('#/env'),
  IS_WEB: true,
}))
jest.mock('#/alf', () => ({
  atoms: {
    fixed: {},
    inset_0: {},
    scrollbar_offset: {transform: []},
    rounded_sm: {borderRadius: 8},
  },
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
  useBreakpoints: () => ({gtMobile: mockGtMobile}),
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

beforeEach(() => {
  mockGtMobile = true
  store.resetAppearanceStoreForTests()
  store.selectBackdrop(undefined, 'pride.trans')
})

function Probe() {
  const def = useActiveBackdrop()
  return <Text>{def ? def.id : 'none'}</Text>
}

function GutterProbe() {
  return <Text>{JSON.stringify(useInsetReadingGutter() ?? null)}</Text>
}

describe('BACKDROPS off (T16)', () => {
  const t = themes.light

  it('every value hook returns its stock value', () => {
    expect(horizonContentStyle(t)).toBe(t.atoms.bg)
    expect(horizonNavTheme(DefaultTheme)).toBe(DefaultTheme)
    expect(horizonOpaque(t)).toBeUndefined()
    expect(horizonInnerHeaderSticky()).toBe(true)
    expect(horizonTabBarBg(t, true)).toBe(t.atoms.bg)
    expect(horizonTabBarBg(t, undefined)).toBe(t.atoms.bg)
  })

  it('no backdrop is active; the components render nothing or stock', () => {
    expect(render(<Probe />).getByText('none')).toBeTruthy()
    expect(render(<BackdropLayer active />).toJSON()).toBeNull()
    expect(render(<ReadingSurface />).toJSON()).toBeNull()

    const fragment = render(
      <RailCard>
        <Text>child</Text>
      </RailCard>,
    ).toJSON()
    expect(fragment).toMatchObject({type: 'Text'})

    const stock = render(
      <RailCard style={{padding: 3}}>
        <Text>child</Text>
      </RailCard>,
    )
    expect(stock.UNSAFE_getByType(View).props.style).toEqual({padding: 3})
  })

  it('no window, lens or inset card, in either phone frame', () => {
    mockGtMobile = false
    const trans = registryDef('pride.trans')!
    const base = {def: trans, gtMobile: false, isWithinDialog: false}
    for (const frameStyle of ['bars', 'buttons'] as const) {
      act(() => store.setFrameStyle(frameStyle))
      expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
      expect(render(<FrameWindow kind="header" />).toJSON()).toBeNull()
      expect(render(<FrameWindow kind="drawer" />).toJSON()).toBeNull()
      expect(render(<FrameWindow kind="homeHeader" />).toJSON()).toBeNull()
      expect(render(<FrameLens kind="tab" />).toJSON()).toBeNull()
      expect(render(<FrameLens kind="headerButton" />).toJSON()).toBeNull()
      expect(render(<FrameLens kind="fab" />).toJSON()).toBeNull()
      expect(windowActive({...base, frameStyle, kind: 'bottomBar'})).toBe(false)
      expect(lensActive({...base, frameStyle, kind: 'tab'})).toBe(false)
    }
    act(() => store.setInsetCard(true))
    expect(render(<GutterProbe />).getByText('null')).toBeTruthy()
    expect(
      insetReadingCardOn({
        def: trans,
        insetCard: true,
        gtMobile: false,
        available: true,
        web: true,
      }),
    ).toBe(false)
  })
})
