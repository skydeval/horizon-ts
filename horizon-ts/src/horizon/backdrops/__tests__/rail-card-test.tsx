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
// The web painter and frame, as the web bundle resolves them.
jest.mock('#/horizon/backdrops/BackdropWindow', () =>
  jest.requireActual('#/horizon/backdrops/BackdropWindow.web'),
)
jest.mock('#/horizon/backdrops/viewport', () => ({
  useViewportFrame: () => ({width: 1440, height: 900}),
}))

const BORDER = themes.light.atoms.border_contrast_low.borderColor

function rendered(variant?: 'rail' | 'nav' | 'navMinimal', style?: object) {
  const {UNSAFE_getAllByType} = render(
    <RailCard variant={variant} style={style}>
      <Text>child</Text>
    </RailCard>,
  )
  return StyleSheet.flatten(UNSAFE_getAllByType(View)[0].props.style) as Record<
    string,
    unknown
  >
}

type Json = {
  type: string
  props: {style?: Record<string, unknown>}
  children: (Json | string)[] | null
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

  it('active: the rail card over a stock style, never blurred (7a)', () => {
    store.selectBackdrop(undefined, 'pride.trans')
    const style = rendered('rail', {paddingTop: 2, gap: 2})
    expect(style).toEqual({
      gap: 2,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: BORDER,
      backgroundColor: 'rgba(255, 255, 255, 0.55)',
    })
    expect(style.backdropFilter).toBeUndefined()
    expect(style.WebkitBackdropFilter).toBeUndefined()
    mockGtMobile = false
    expect(rendered('rail').backdropFilter).toBeUndefined()
  })

  it('paints the backdrop into the card under the glass (7a)', () => {
    store.selectBackdrop(undefined, 'pride.trans')
    const json = render(
      <RailCard>
        <Text>child</Text>
      </RailCard>,
    ).toJSON() as Json
    const [paint, child] = json.children as Json[]
    // The web painter, first: clipped to the card inside its border.
    expect(paint.type).toBe('div')
    expect(paint.props.style).toMatchObject({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: 15,
      zIndex: -1,
      overflow: 'hidden',
    })
    const [inner, glass] = paint.children as Json[]
    expect(String(inner.props.style?.backgroundImage)).toMatch(
      /^linear-gradient\(/,
    )
    expect(String(glass.props.style?.backgroundImage)).toBe(
      'linear-gradient(rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.55))',
    )
    expect(child.type).toBe('Text')
  })

  it('the nav variants keep the stock content width', () => {
    const ace = registryDef('pride.ace')!
    const opts = {borderColor: BORDER, reduced: false}
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

  it('reduced transparency: the glass at 0.85', () => {
    const trans = registryDef('pride.trans')!
    const reduced = railCardStyle('rail', trans, 'light', {
      borderColor: BORDER,
      reduced: true,
    })
    expect(reduced.style.backgroundColor).toBe('rgba(255, 255, 255, 0.85)')
    expect(reduced.glass).toBe('rgba(255, 255, 255, 0.85)')
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
