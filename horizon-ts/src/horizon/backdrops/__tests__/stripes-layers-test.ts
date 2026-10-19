import {describe, expect, it} from '@jest/globals'

import {seenLayers, specLayers} from '#/horizon/backdrops/layers'
import {registryDef} from '#/horizon/backdrops/registry'
import {bloomLayer, makeStripedStops} from '#/horizon/backdrops/stripes'
import {type LinearLayer} from '#/horizon/backdrops/types'

const OPTS = {edgeEpsilon: 0.002, softenEdges: true}

describe('makeStripedStops (T2)', () => {
  it('reproduces 1.0 for trans', () => {
    const trans = registryDef('pride.trans')!
    const stops = makeStripedStops(trans.stripes, OPTS)
    expect(stops).toHaveLength(11)
    const expected = [
      0, 0.20388, 0.20788, 0.39996, 0.40396, 0.59604, 0.60004, 0.79212, 0.79612,
      0.998, 1,
    ]
    stops.forEach((stop, i) => expect(stop.pos).toBeCloseTo(expected[i], 5))
    expect(stops.map(s => s.color)).toEqual([
      '#5BCEFA',
      '#5BCEFA',
      '#F5A9B8',
      '#F5A9B8',
      '#FFFFFF',
      '#FFFFFF',
      '#F5A9B8',
      '#F5A9B8',
      '#5BCEFA',
      '#5BCEFA',
      '#5BCEFA',
    ])
  })

  it('does not soften two stripes', () => {
    expect(makeStripedStops(['#000000', '#FFFFFF'], OPTS)).toEqual([
      {color: '#000000', pos: 0},
      {color: '#000000', pos: 0.498},
      {color: '#FFFFFF', pos: 0.502},
      {color: '#FFFFFF', pos: 0.998},
      {color: '#FFFFFF', pos: 1},
    ])
  })

  it('throws for fewer than two stripes', () => {
    expect(() => makeStripedStops(['#000000'], OPTS)).toThrow()
  })

  it('bloomLayer has 1.0 values', () => {
    expect(bloomLayer(0.12)).toEqual({
      kind: 'radial',
      cx: 0.28,
      cy: 0.18,
      r: 0.95,
      opacity: 0.12,
      stops: [
        {color: '#FFFFFF', pos: 0},
        {color: '#FFFFFF', pos: 0.35},
        {color: '#000000', pos: 1},
      ],
    })
  })
})

describe('layers (T3)', () => {
  it('seenLayers: one corner layer, evenly spaced, 2n + 1 colours', () => {
    const ace = registryDef('pride.ace')!
    const layers = seenLayers(ace)
    expect(layers).toHaveLength(1)
    const layer = layers[0] as LinearLayer
    expect(layer.direction).toEqual({kind: 'corner'})
    expect(layer.opacity).toBe(1)
    expect(layer.stops).toHaveLength(9)
    layer.stops.forEach((stop, i) => {
      expect(stop.pos).toBeCloseTo(i / 8, 10)
      expect(stop.alpha).toBe(1)
    })
    expect(layer.stops.map(s => s.color)).toEqual([
      '#000000',
      '#000000',
      '#A3A3A3',
      '#A3A3A3',
      '#FFFFFF',
      '#FFFFFF',
      '#800080',
      '#800080',
      '#800080',
    ])
  })

  it('specLayers: the angle, 1.0 positions and the bloom', () => {
    const trans = registryDef('pride.trans')!
    const [linear, radial] = specLayers(trans)
    expect(linear.kind).toBe('linear')
    expect((linear as LinearLayer).direction).toEqual({kind: 'angle', deg: 165})
    expect(linear.stops[1].pos).toBeCloseTo(0.20388, 5)
    expect(radial).toEqual(bloomLayer(0.12))
  })

  it('none has no layers', () => {
    const none = registryDef('none')!
    expect(seenLayers(none)).toEqual([])
    expect(specLayers(none)).toEqual([])
  })
})
