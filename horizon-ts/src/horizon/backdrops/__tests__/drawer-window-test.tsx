/*
 * The app's drawer window lays out while slid off-screen, so it is not
 * measured: it paints the backdrop as seen from the screen's top left,
 * where it opens (skydeval: no backdrop in the app's drawer, 2026-10-29).
 */

import {type Text} from 'react-native'
import {describe, expect, it, jest} from '@jest/globals'
import {render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {BackdropWindow} from '#/horizon/backdrops/BackdropWindow'
import {FILL_SHAPE} from '#/horizon/backdrops/frame'
import {registryDef} from '#/horizon/backdrops/registry'

jest.mock('#/alf', () => ({
  atoms: {overflow_hidden: {overflow: 'hidden'}},
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
}))
jest.mock('#/horizon/backdrops/ModeTrigger', () => ({
  FooterModeTrigger: () => null,
  HomeHeaderModeTrigger: () => null,
}))
jest.mock('#/horizon/backdrops/viewport', () => ({
  useViewportFrame: () => ({width: 400, height: 800}),
}))
jest.mock('#/horizon/backdrops/CompiledSvg', () => ({
  CompiledSvg: ({offset}: {offset: {x: number; y: number}}) => {
    const {Text: MockText} = jest.requireActual<{Text: typeof Text}>(
      'react-native',
    )
    return (
      <MockText testID="painted">{`${offset.x + 0},${offset.y + 0}`}</MockText>
    )
  },
}))

describe("the app's drawer window", () => {
  const trans = registryDef('pride.trans')!

  it('paints from the top left at once, without a measurement', () => {
    const {getByTestId} = render(
      <BackdropWindow
        def={trans}
        overlays={[]}
        shape={FILL_SHAPE}
        followsAnimations
      />,
    )
    expect(getByTestId('painted').props.children).toBe('0,0')
  })

  it('other windows wait for their measurement', () => {
    const {queryByTestId} = render(
      <BackdropWindow def={trans} overlays={[]} shape={FILL_SHAPE} />,
    )
    expect(queryByTestId('painted')).toBeNull()
  })
})
