import {LinearGradient, RadialGradient, Rect, Stop} from 'react-native-svg'
import {describe, expect, it} from '@jest/globals'
import {render} from '@testing-library/react-native'

import {compileBackdrop, type ResolvedLinear} from '#/horizon/backdrops/compile'
import {CompiledSvg} from '#/horizon/backdrops/CompiledSvg'
import {registryDef} from '#/horizon/backdrops/registry'

describe('CompiledSvg (T6)', () => {
  const frame = {width: 200, height: 100}
  const compiled = compileBackdrop(
    registryDef('pride.trans')!,
    'light',
    frame,
    'spec',
  )!

  it('renders one rect per layer with user-space gradients', () => {
    const {UNSAFE_getAllByType} = render(
      <CompiledSvg compiled={compiled} frame={frame} />,
    )
    expect(UNSAFE_getAllByType(Rect)).toHaveLength(2)
    const [linear] = UNSAFE_getAllByType(LinearGradient)
    const [radial] = UNSAFE_getAllByType(RadialGradient)
    expect(linear.props.gradientUnits).toBe('userSpaceOnUse')
    expect(radial.props.gradientUnits).toBe('userSpaceOnUse')
    const layer = compiled.layers[0] as ResolvedLinear
    expect(linear.props.x1).toBe(layer.x1)
    expect(linear.props.y2).toBe(layer.y2)
    const stops = UNSAFE_getAllByType(Stop)
    expect(stops).toHaveLength(11 + 3)
    expect(stops[0].props.stopOpacity).toBe(1)
    expect(stops[11].props.stopOpacity).toBe(0.12)
  })

  it('adds one rect per overlay', () => {
    const {UNSAFE_getAllByType} = render(
      <CompiledSvg
        compiled={compiled}
        overlays={['rgba(255, 255, 255, 0.55)', 'rgba(0, 0, 0, 0.18)']}
        frame={frame}
        offset={{x: -10, y: -20}}
      />,
    )
    const rects = UNSAFE_getAllByType(Rect)
    expect(rects).toHaveLength(4)
    // Overlays are listed top first and drawn bottom first.
    expect(rects[3].props.fill).toBe('rgba(255, 255, 255, 0.55)')
  })
})
