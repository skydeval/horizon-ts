import {Text} from 'react-native'
import {afterEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import {DEFAULT_APPEARANCE} from '#/horizon/appearance/model'
import {
  PICKER_ORDER,
  PICKER_SECTIONS,
} from '#/horizon/appearance/settings/picker'
import {compileBackdrop, paintedLayers} from '#/horizon/backdrops/compile'
import {cssBackground} from '#/horizon/backdrops/css'
import {glassAlpha, sampledColors} from '#/horizon/backdrops/glass'
import {
  msToNextHour,
  resetHourForTests,
  useHour,
} from '#/horizon/backdrops/hour'
import {
  BACKDROP_DEFS,
  BACKDROP_SKIES_AUTO,
  customDef,
  registryDef,
  resolveBackdrop,
  skyForHour,
} from '#/horizon/backdrops/registry'
import {type BackdropDef} from '#/horizon/backdrops/types'

let mockGrainTile: string | null = null
jest.mock('#/horizon/backdrops/grain', () => ({
  GRAIN_TILE: 128,
  grainTileUrl: () => mockGrainTile,
}))

const FRAME = {width: 1440, height: 900}

function inCollection(collection: BackdropDef['collection']) {
  return BACKDROP_DEFS.filter(def => def.collection === collection)
}

afterEach(() => {
  mockGrainTile = null
  jest.useRealTimers()
  resetHourForTests()
})

describe('Skies (item 3)', () => {
  const skies = inCollection('skies').filter(d => d.id !== BACKDROP_SKIES_AUTO)

  it('dawn, daylight, golden hour, dusk, twilight, night, aurora', () => {
    expect(skies.map(def => def.id)).toEqual([
      'skies.dawn',
      'skies.day',
      'skies.golden',
      'skies.dusk',
      'skies.twilight',
      'skies.night',
      'skies.aurora',
    ])
  })

  it('a soft vertical gradient and a low glow, in both looks', () => {
    for (const def of skies) {
      const [base, glow] = def.layers!
      expect(base).toMatchObject({
        kind: 'linear',
        direction: {kind: 'angle', deg: 180},
      })
      expect(glow).toMatchObject({kind: 'radial', cx: 0.5})
      if (glow.kind === 'radial') expect(glow.cy).toBeGreaterThan(1)
      for (const look of ['seen', 'spec'] as const) {
        const compiled = compileBackdrop(def, 'light', FRAME, look)!
        expect(compiled.layers.map(l => l.kind)).toEqual(
          def.layers!.map(l => l.kind),
        )
      }
    }
  })

  it('Time of day: one sky per hour, never aurora, never animated', () => {
    const byHour = Array.from({length: 24}, (_v, h) => skyForHour(h).id)
    expect(byHour[3]).toBe('skies.night')
    expect(byHour[5]).toBe('skies.dawn')
    expect(byHour[12]).toBe('skies.day')
    expect(byHour[16]).toBe('skies.golden')
    expect(byHour[18]).toBe('skies.dusk')
    expect(byHour[21]).toBe('skies.twilight')
    expect(byHour[23]).toBe('skies.night')
    expect(byHour).not.toContain('skies.aurora')
    const auto = {...DEFAULT_APPEARANCE, backdrop: BACKDROP_SKIES_AUTO}
    expect(resolveBackdrop(auto, 6)!.id).toBe('skies.dawn')
    expect(resolveBackdrop(auto, 19)!.id).toBe('skies.dusk')
    expect(registryDef(BACKDROP_SKIES_AUTO)!.collection).toBe('skies')
  })
})

function HourProbe({follow}: {follow: boolean}) {
  return <Text>{String(useHour(follow))}</Text>
}

describe('the hour clock', () => {
  it('waits for the next hour, a second late', () => {
    const now = new Date(2026, 9, 20, 17, 59, 30)
    expect(msToNextHour(now)).toBe(31_000)
  })

  it('switches once when the hour changes, and only while followed', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(2026, 9, 20, 17, 59, 0))
    resetHourForTests()
    const off = render(<HourProbe follow={false} />)
    expect(jest.getTimerCount()).toBe(0)
    off.unmount()

    let renders = 0
    function Counting() {
      renders++
      return <HourProbe follow />
    }
    const {getByText, unmount} = render(<Counting />)
    expect(getByText('17')).toBeTruthy()
    expect(jest.getTimerCount()).toBe(1)
    act(() => {
      jest.advanceTimersByTime(30_000)
    })
    expect(getByText('17')).toBeTruthy()
    act(() => {
      jest.advanceTimersByTime(31_000)
    })
    expect(getByText('18')).toBeTruthy()
    // Re-armed for the next hour; nothing ticks in between.
    expect(jest.getTimerCount()).toBe(1)
    const before = renders
    act(() => {
      jest.advanceTimersByTime(30 * 60_000)
    })
    expect(renders).toBe(before)
    unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('Colour blobs (item 4)', () => {
  const blobs = inCollection('blobs')

  it('a base under three or more pools of colour', () => {
    expect(blobs.length).toBeGreaterThanOrEqual(5)
    for (const def of blobs) {
      const [base, ...pools] = def.layers!
      expect(base.kind).toBe('linear')
      expect(pools.length).toBeGreaterThanOrEqual(3)
      for (const pool of pools) {
        expect(pool.kind).toBe('radial')
        // Each pool fades to nothing at its edge.
        expect(pool.stops[pool.stops.length - 1].alpha).toBe(0)
      }
    }
  })

  it('the glass sees the pools as well as the base', () => {
    const peach = registryDef('blobs.peach')!
    const linearOnly = {...peach, layers: [peach.layers![0]]}
    expect(sampledColors(peach, 'light').length).toBeGreaterThan(
      sampledColors(linearOnly, 'light').length,
    )
    expect(glassAlpha(peach, 'light')).toBeGreaterThanOrEqual(
      glassAlpha(linearOnly, 'light'),
    )
  })
})

describe('Nature (item 5)', () => {
  it('six palettes in the soft diagonal look', () => {
    const nature = inCollection('nature')
    expect(nature.map(def => def.id)).toEqual([
      'nature.ocean',
      'nature.forest',
      'nature.desert',
      'nature.sakura',
      'nature.moss',
    ])
    for (const def of nature) {
      expect(def.layers).toBeUndefined()
      const layer = compileBackdrop(def, 'light', FRAME)!.layers[0]
      // 'seen': corner to corner.
      expect(layer).toMatchObject({kind: 'linear', x1: 0, y1: 0, x2: 1440})
    }
  })
})

describe('the picker (items 3 to 5)', () => {
  it('sections in order, every entry once, None first alone', () => {
    expect(PICKER_SECTIONS.map(s => s.collection)).toEqual(PICKER_ORDER)
    expect(PICKER_SECTIONS[0].defs.map(d => d.id)).toEqual(['none'])
    const ids = PICKER_SECTIONS.flatMap(s => s.defs.map(d => d.id))
    expect(ids).toEqual(BACKDROP_DEFS.map(d => d.id))
  })
})

describe('Grain (item 6)', () => {
  const trans = registryDef('pride.trans')!

  it('a top texture layer, only when set, in the compile key', () => {
    expect(compileBackdrop(trans, 'light', FRAME)!.texture).toBeUndefined()
    const grained = compileBackdrop({...trans, grain: true}, 'light', FRAME)!
    expect(grained.texture).toEqual([{kind: 'grain'}])
    expect(grained).not.toBe(compileBackdrop(trans, 'light', FRAME))
    expect(paintedLayers(grained).map(l => l.kind)).toEqual(['linear', 'grain'])
  })

  it('a repeated static tile, the same layer count without a canvas', () => {
    const def = {...trans, grain: true}
    const compiled = compileBackdrop(def, 'light', FRAME)!
    const none = cssBackground(compiled, ['rgba(0, 0, 0, 0.5)'], FRAME, {
      x: 0,
      y: 0,
    })
    expect(none.backgroundImage).toMatch(/, none, linear-gradient\(/)
    mockGrainTile = 'data:image/png;base64,AAAA'
    const css = cssBackground(compiled, ['rgba(0, 0, 0, 0.5)'], FRAME, {
      x: -10,
      y: -20,
    })
    expect(css.backgroundImage).toContain(
      'url("data:image/png;base64,AAAA"), linear-gradient(',
    )
    expect(css.backgroundSize.split(', ')).toEqual([
      '100% 100%',
      '128px 128px',
      '1440px 900px',
    ])
    expect(css.backgroundRepeat).toBe('no-repeat, repeat, no-repeat')
    // The tile moves with the window like the gradient.
    expect(css.backgroundPosition).toBe('0px 0px, -10px -20px, -10px -20px')
    // No filters anywhere.
    expect(JSON.stringify(css)).not.toMatch(/filter/i)
  })
})

describe('Quiet patterns (item 7)', () => {
  const base = {mode: 'solid' as const, a: '#F0E8DD', b: '#F0E8DD'}

  it('dots, grid and lines over a one-tone, in low contrast', () => {
    const dots = compileBackdrop(
      customDef({...base, pattern: 'dots'}),
      'light',
      FRAME,
    )!
    expect(dots.texture).toEqual([
      expect.objectContaining({kind: 'pattern', shape: 'dots', size: 18}),
    ])
    const grid = compileBackdrop(
      customDef({...base, pattern: 'grid'}),
      'light',
      FRAME,
    )!
    expect(grid.texture!.map(l => l.kind === 'pattern' && l.shape)).toEqual([
      'hlines',
      'vlines',
    ])
    const lines = compileBackdrop(
      customDef({...base, pattern: 'lines'}),
      'light',
      FRAME,
    )!
    for (const compiled of [dots, grid, lines]) {
      for (const layer of compiled.texture!) {
        if (layer.kind !== 'pattern') continue
        // Black over a light base, at most 0.13 alpha.
        expect([layer.r, layer.g, layer.b]).toEqual([0, 0, 0])
        expect(layer.a).toBeLessThanOrEqual(0.13)
      }
    }
    // White over a dark base, fainter still.
    const dark = compileBackdrop(
      customDef({mode: 'solid', a: '#1F2937', b: '#1F2937', pattern: 'dots'}),
      'light',
      FRAME,
    )!.texture![0]
    expect(dark).toMatchObject({r: 255, g: 255, b: 255})
    if (dark.kind === 'pattern') expect(dark.a).toBeLessThan(0.13)
  })

  it('tiles from the frame origin as CSS', () => {
    const compiled = compileBackdrop(
      customDef({...base, pattern: 'grid'}),
      'light',
      FRAME,
    )!
    const css = cssBackground(compiled, [], FRAME, {x: 0, y: 0})
    expect(css.backgroundImage.split('), ').length).toBe(3)
    expect(css.backgroundSize).toBe('24px 24px, 24px 24px, 1440px 900px')
    expect(css.backgroundRepeat).toBe('repeat, repeat, no-repeat')
    const lines = cssBackground(
      compileBackdrop(customDef({...base, pattern: 'lines'}), 'light', FRAME)!,
      [],
      FRAME,
      {x: 0, y: 0},
    )
    expect(lines.backgroundImage).toMatch(/^repeating-linear-gradient\(45deg/)
  })

  it('a plain backdrop keeps its single no-repeat', () => {
    const css = cssBackground(
      compileBackdrop(registryDef('pride.trans')!, 'light', FRAME)!,
      [],
      FRAME,
      {x: 0, y: 0},
    )
    expect(css.backgroundRepeat).toBe('no-repeat')
  })
})
