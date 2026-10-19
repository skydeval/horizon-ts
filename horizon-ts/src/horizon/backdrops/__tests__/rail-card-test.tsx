import {StyleSheet, Text, View} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {DefaultTheme} from '@react-navigation/native'
import {act, render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {themes} from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {horizonContentStyle, horizonNavTheme} from '#/horizon/backdrops/nav'
import {RailCard, railCardStyle} from '#/horizon/backdrops/RailCard'
import {registryDef} from '#/horizon/backdrops/registry'
import {useShellBackdrop} from '#/horizon/backdrops/shell'

let mockGtMobile = true
jest.mock('#/alf', () => ({
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
  useBreakpoints: () => ({gtMobile: mockGtMobile}),
  web: (value: unknown) => value,
}))
jest.mock('#/env', () => ({
  ...jest.requireActual<Record<string, unknown>>('#/env'),
  IS_WEB: true,
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
}))
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => undefined,
  writeDeviceJson: () => {},
  subscribeDeviceJson: () => () => {},
}))

const BORDER = themes.light.atoms.border_contrast_low.borderColor

function rendered(variant?: 'rail' | 'nav' | 'navMinimal', style?: object) {
  const {UNSAFE_getByType} = render(
    <RailCard variant={variant} style={style}>
      <Text>child</Text>
    </RailCard>,
  )
  return StyleSheet.flatten(UNSAFE_getByType(View).props.style) as Record<
    string,
    unknown
  >
}

function ShellProbe({status}: {status?: string}) {
  return <Text>{String(useShellBackdrop(status).active)}</Text>
}

beforeEach(() => {
  mockGtMobile = true
  store.resetAppearanceStoreForTests()
})

describe('RailCard (T17)', () => {
  it('inactive renders the stock tree', () => {
    const fragment = render(
      <RailCard>
        <Text>child</Text>
      </RailCard>,
    ).toJSON()
    expect(fragment).toMatchObject({type: 'Text'})
    expect(rendered('rail', {padding: 3})).toEqual({padding: 3})
  })

  it('active: the rail card over a stock style, blurred at gtMobile', () => {
    store.selectBackdrop(undefined, 'pride.trans')
    expect(rendered('rail', {paddingTop: 2, gap: 2})).toEqual({
      gap: 2,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: BORDER,
      backgroundColor: 'rgba(255, 255, 255, 0.55)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
    })
    mockGtMobile = false
    expect(rendered('rail').backdropFilter).toBeUndefined()
  })

  it('the nav variants keep the stock content width', () => {
    const ace = registryDef('pride.ace')!
    const opts = {borderColor: BORDER, gtMobile: true, reduced: false}
    expect(railCardStyle('nav', ace, 'light', opts).style).toEqual({
      marginLeft: -9,
      marginRight: -9,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 12,
      paddingBottom: 12,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: BORDER,
      backgroundColor: 'rgba(255, 255, 255, 0.76)',
    })
    expect(railCardStyle('navMinimal', ace, 'dark', opts).style).toMatchObject({
      marginLeft: -13,
      marginRight: -13,
      paddingLeft: 12,
      paddingRight: 12,
      backgroundColor: 'rgba(0, 0, 0, 0.74)',
    })
  })

  it('blur only at gtMobile; reduced transparency: 0.85 and no blur', () => {
    const trans = registryDef('pride.trans')!
    const base = {borderColor: BORDER, reduced: false}
    expect(
      railCardStyle('rail', trans, 'light', {...base, gtMobile: true}).blur,
    ).toBe(true)
    expect(
      railCardStyle('rail', trans, 'light', {...base, gtMobile: false}).blur,
    ).toBe(false)
    const reduced = railCardStyle('rail', trans, 'light', {
      borderColor: BORDER,
      gtMobile: true,
      reduced: true,
    })
    expect(reduced.blur).toBe(false)
    expect(reduced.style.backgroundColor).toBe('rgba(255, 255, 255, 0.85)')
  })
})

describe('shell and navigation hooks, active', () => {
  it('the shell draws only for a live account with a backdrop', () => {
    expect(render(<ShellProbe />).getByText('false')).toBeTruthy()
    act(() => store.selectBackdrop(undefined, 'solids.blue'))
    expect(render(<ShellProbe />).getByText('true')).toBeTruthy()
    expect(
      render(<ShellProbe status="takendown" />).getByText('false'),
    ).toBeTruthy()
    expect(
      render(<ShellProbe status="deactivated" />).getByText('false'),
    ).toBeTruthy()
  })

  it('web screens and the navigation theme are transparent', () => {
    expect(horizonContentStyle(themes.light)).toEqual({
      backgroundColor: 'transparent',
    })
    const theme = horizonNavTheme(DefaultTheme)
    expect(theme.colors.background).toBe('transparent')
    expect(theme.colors.card).toBe(DefaultTheme.colors.card)
    expect(horizonNavTheme(DefaultTheme)).toBe(theme)
  })
})
