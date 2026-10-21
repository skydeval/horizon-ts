/*
 * Change list 3: the flags (items 7 and 8), Aesthetics (1), Gems (2),
 * Space with the static Starfield (3), Seasonal with "Follow the season"
 * (4), Calm (5) and the custom stripes' drawing (10). The record and editor
 * side of item 10 is in `appearance/__tests__/change-list-3-record-test.ts`.
 */

import {Text} from 'react-native'
import {Circle, Pattern, Rect} from 'react-native-svg'
import {afterEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import {DEFAULT_APPEARANCE} from '#/horizon/appearance/model'
import {
  PICKER_ORDER,
  PICKER_SECTIONS,
} from '#/horizon/appearance/settings/picker'
import {
  compileBackdrop,
  compileKey,
  hexToRgb,
  paintedLayers,
  rgbToHsl,
} from '#/horizon/backdrops/compile'
import {CompiledSvg} from '#/horizon/backdrops/CompiledSvg'
import {cssBackground} from '#/horizon/backdrops/css'
import {SHADE_KINDS, shadeAlpha} from '#/horizon/backdrops/frame'
import {
  contrast,
  glassAlpha,
  MAX_GLASS_ALPHA,
  sampledColors,
} from '#/horizon/backdrops/glass'
import {
  BACKDROP_DEFS,
  BACKDROP_SEASON_AUTO,
  customDef,
  migrateRemovedSolid,
  registryDef,
  resolveBackdrop,
  seasonForMonth,
} from '#/horizon/backdrops/registry'
import {
  msToNextDay,
  resetMonthForTests,
  useMonth,
} from '#/horizon/backdrops/season'
import {DEFAULT_SOFTNESS} from '#/horizon/backdrops/softness'
import {
  STAR_COUNT,
  STAR_MAX_ALPHA,
  STAR_TILE,
  STARS,
  starTileUrl,
} from '#/horizon/backdrops/stars'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

const FRAME = {width: 1440, height: 900}
const THEMES: ThemeName[] = ['light', 'dim', 'dark']

function inCollection(collection: BackdropDef['collection']) {
  return BACKDROP_DEFS.filter(def => def.collection === collection)
}

const NEW_FLAGS = [
  'pride.bigender',
  'pride.transfeminine',
  'pride.transmasculine',
  'pride.graysexual',
  'pride.grayromantic',
  'pride.omnisexual',
  'pride.polysexual',
  'pride.abrosexual',
  'pride.queer',
]

const NEW_COLLECTIONS = [
  'calm',
  'seasonal',
  'space',
  'gems',
  'aesthetics',
] as const

const NEW_DEFS = [
  ...NEW_FLAGS.map(id => registryDef(id)!),
  ...NEW_COLLECTIONS.flatMap(inCollection),
]

afterEach(() => {
  jest.useRealTimers()
  resetMonthForTests()
})

describe('flags (items 7 and 8)', () => {
  it('are locked, flat and striped like the other flags', () => {
    for (const id of NEW_FLAGS) {
      const def = registryDef(id)!
      expect(def.collection).toBe('pride')
      expect(def.lockColors).toBe(true)
      expect(def.layers).toBeUndefined()
      for (const theme of THEMES) {
        expect(def.tuning?.[theme]).toEqual({saturation: 1, brightness: 1})
      }
      // Drawn from their stripes, in order, corner to corner ('seen').
      const layer = compileBackdrop(def, 'light', FRAME)!.layers[0]
      expect(layer.kind).toBe('linear')
      expect(layer.stops[0]).toMatchObject(hexToRgb(def.stripes[0]))
      expect(layer.stops[layer.stops.length - 1]).toMatchObject(
        hexToRgb(def.stripes[def.stripes.length - 1]),
      )
    }
  })

  it('leaves out the emblem flags, aplatonic and any plural flag', () => {
    const ids = BACKDROP_DEFS.map(def => def.id).join(' ')
    for (const word of [
      'sapphic',
      'achillean',
      'polyam',
      'aplatonic',
      'plural',
      'system',
    ]) {
      expect(ids).not.toContain(word)
    }
  })
})

describe('the new collections (items 1 to 5)', () => {
  it('hold the listed backdrops, in order', () => {
    const ids = (c: BackdropDef['collection']) => inCollection(c).map(d => d.id)
    expect(ids('aesthetics')).toEqual([
      'aesthetics.frutigeraero',
      'aesthetics.vaporwave',
      'aesthetics.synthwave',
      'aesthetics.y2k',
      'aesthetics.cottagecore',
      'aesthetics.darkacademia',
      'aesthetics.pastelgoth',
      'aesthetics.retro70s',
    ])
    expect(ids('gems')).toEqual([
      'gems.amethyst',
      'gems.emerald',
      'gems.sapphire',
      'gems.rosequartz',
      'gems.opal',
      'gems.oilslick',
      'gems.holographic',
    ])
    expect(ids('space')).toEqual([
      'space.nebula',
      'space.galaxy',
      'space.starfield',
    ])
    expect(ids('seasonal')).toEqual([
      'seasonal.auto',
      'seasonal.spring',
      'seasonal.summer',
      'seasonal.autumn',
      'seasonal.winter',
    ])
    expect(ids('calm').length).toBeGreaterThanOrEqual(5)
  })

  it('every name is a Lingui descriptor, every id once', () => {
    for (const def of NEW_DEFS) expect(def.name.message).toBeTruthy()
    const all = BACKDROP_DEFS.map(def => def.id)
    expect(new Set(all).size).toBe(all.length)
  })

  it('the shifting gems are several pools of colour', () => {
    for (const id of ['gems.opal', 'gems.oilslick', 'gems.holographic']) {
      const pools = registryDef(id)!.layers!.filter(l => l.kind === 'radial')
      expect(pools.length).toBeGreaterThanOrEqual(4)
      const hues = new Set(
        pools.map(p => Math.round(rgbToHsl(hexToRgb(p.stops[0].color)).h / 40)),
      )
      expect(hues.size).toBeGreaterThanOrEqual(4)
    }
  })

  it('Retro 70s is stacked bands with hard edges, top to bottom', () => {
    const [bands] = registryDef('aesthetics.retro70s')!.layers!
    expect(bands).toMatchObject({kind: 'linear', direction: {deg: 180}})
    // Two stops at each of the four inner edges, 0.004 apart.
    const stops = bands.stops
    expect(stops).toHaveLength(11)
    expect(stops[2].pos - stops[1].pos).toBeCloseTo(0.004, 6)
    expect(stops[0].color).toBe('#F2C14E')
    expect(stops[stops.length - 1].color).toBe('#5C3520')
  })

  it('the picker shows them in sections, in its order', () => {
    expect(PICKER_ORDER).toEqual([
      'system',
      'pride',
      'materials',
      'calm',
      'nature',
      'seasonal',
      'skies',
      'space',
      'gems',
      'blobs',
      'aesthetics',
    ])
    expect(PICKER_SECTIONS.map(s => s.collection)).toEqual(PICKER_ORDER)
    const ids = PICKER_SECTIONS.flatMap(s => s.defs.map(d => d.id))
    expect(ids).toEqual(BACKDROP_DEFS.map(d => d.id))
  })
})

/* Light has no softness; dim and dark at none, the default and full. */
function softenings(theme: ThemeName): number[] {
  return theme === 'light' ? [0] : [0, DEFAULT_SOFTNESS[theme] / 100, 1]
}

describe('every new backdrop reads in light, dim and dark', () => {
  it('compiles in each theme, at no, default and full softness', () => {
    for (const def of NEW_DEFS) {
      for (const theme of THEMES) {
        for (const soften of softenings(theme)) {
          const d = soften > 0 ? {...def, soften} : def
          const compiled = compileBackdrop(d, theme, FRAME)
          expect(compiled).not.toBeNull()
          expect(compiled!.layers.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('never needs the strongest glass or shade: text keeps its contrast with room', () => {
    for (const def of NEW_DEFS) {
      for (const theme of THEMES) {
        for (const soften of softenings(theme)) {
          const d = soften > 0 ? {...def, soften} : def
          const alpha = glassAlpha(d, theme)
          if (alpha >= MAX_GLASS_ALPHA) {
            throw new Error(`${def.id} ${theme} ${soften}: glass at the cap`)
          }
          for (const kind of SHADE_KINDS) {
            expect(shadeAlpha(d, theme, kind)).toBeLessThan(MAX_GLASS_ALPHA)
          }
        }
      }
    }
  })
})

describe('Calm (item 5)', () => {
  const calm = inCollection('calm')

  it('low contrast and low saturation inside each backdrop', () => {
    for (const def of calm) {
      expect(def.layers).toHaveLength(1)
      const colors = def.layers![0].stops.map(s => hexToRgb(s.color))
      for (const x of colors) {
        // Chroma, not HSL saturation, which runs high for pale colours.
        const chroma = Math.max(x.r, x.g, x.b) - Math.min(x.r, x.g, x.b)
        expect(chroma).toBeLessThanOrEqual(20)
        for (const y of colors) expect(contrast(x, y)).toBeLessThan(1.15)
      }
    }
  })

  it('offers light and dark ones, of their own colours', () => {
    const lightness = calm.map(
      def => rgbToHsl(hexToRgb(def.layers![0].stops[1].color)).l,
    )
    expect(lightness.some(l => l > 0.8)).toBe(true)
    expect(lightness.some(l => l < 0.25)).toBe(true)
    // Not copies of any other backdrop's colours.
    const others = new Set(
      BACKDROP_DEFS.filter(d => d.collection !== 'calm').flatMap(
        d => d.stripes,
      ),
    )
    for (const def of calm) {
      for (const color of def.stripes) expect(others.has(color)).toBe(false)
    }
  })
})

describe('Follow the season (item 4)', () => {
  it('four meteorological seasons, northern months by default', () => {
    const north = Array.from({length: 12}, (_v, m) => seasonForMonth(m).id)
    expect(north).toEqual([
      'seasonal.winter',
      'seasonal.winter',
      'seasonal.spring',
      'seasonal.spring',
      'seasonal.spring',
      'seasonal.summer',
      'seasonal.summer',
      'seasonal.summer',
      'seasonal.autumn',
      'seasonal.autumn',
      'seasonal.autumn',
      'seasonal.winter',
    ])
    const south = Array.from(
      {length: 12},
      (_v, m) => seasonForMonth(m, true).id,
    )
    expect(south).toEqual([
      'seasonal.summer',
      'seasonal.summer',
      'seasonal.autumn',
      'seasonal.autumn',
      'seasonal.autumn',
      'seasonal.winter',
      'seasonal.winter',
      'seasonal.winter',
      'seasonal.spring',
      'seasonal.spring',
      'seasonal.spring',
      'seasonal.summer',
    ])
  })

  it('old ids read as the four seasons, keeping a backdrop', () => {
    const read = (backdrop: string) =>
      migrateRemovedSolid({...DEFAULT_APPEARANCE, backdrop}).backdrop
    expect(read('seasonal.spooky')).toBe('seasonal.autumn')
    expect(read('seasonal.hallows')).toBe('seasonal.autumn')
    expect(read('seasonal.christmas')).toBe('seasonal.winter')
    expect(read('nature.autumn')).toBe('seasonal.autumn')
    for (const id of [
      'seasonal.spooky',
      'seasonal.hallows',
      'seasonal.christmas',
      'nature.autumn',
    ]) {
      expect(registryDef(id)).toBeUndefined()
    }
    expect(registryDef('seasonal.autumn')!.name.message).toBe('Autumn')
  })

  it('resolves by the month given, the auto entry in Seasonal', () => {
    const auto = {...DEFAULT_APPEARANCE, backdrop: BACKDROP_SEASON_AUTO}
    expect(resolveBackdrop(auto, 12, {month: 9, southern: false})!.id).toBe(
      'seasonal.autumn',
    )
    expect(resolveBackdrop(auto, 12, {month: 9, southern: true})!.id).toBe(
      'seasonal.spring',
    )
    expect(registryDef(BACKDROP_SEASON_AUTO)!.collection).toBe('seasonal')
    // Picking a season directly ignores the date.
    expect(
      resolveBackdrop(
        {...DEFAULT_APPEARANCE, backdrop: 'seasonal.winter'},
        12,
        {month: 6, southern: false},
      )!.id,
    ).toBe('seasonal.winter')
  })
})

function MonthProbe({follow}: {follow: boolean}) {
  return <Text>{String(useMonth(follow))}</Text>
}

describe('the month clock', () => {
  it('waits for the next local midnight, a second late', () => {
    expect(msToNextDay(new Date(2026, 9, 31, 23, 59, 30))).toBe(31_000)
  })

  it('switches once when the month changes, only while followed', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(2026, 9, 30, 23, 0, 0))
    resetMonthForTests()
    const off = render(<MonthProbe follow={false} />)
    expect(jest.getTimerCount()).toBe(0)
    off.unmount()

    let renders = 0
    function Counting() {
      renders++
      return <MonthProbe follow />
    }
    const {getByText, unmount} = render(<Counting />)
    expect(getByText('9')).toBeTruthy()
    expect(jest.getTimerCount()).toBe(1)
    // Midnight into the 31st: the same month, no render.
    let before = renders
    act(() => {
      jest.advanceTimersByTime(60 * 60_000 + 1000)
    })
    expect(renders).toBe(before)
    expect(jest.getTimerCount()).toBe(1)
    // Midnight into November: one switch.
    act(() => {
      jest.advanceTimersByTime(24 * 60 * 60_000)
    })
    expect(getByText('10')).toBeTruthy()
    before = renders
    act(() => {
      jest.advanceTimersByTime(12 * 60 * 60_000)
    })
    expect(renders).toBe(before)
    unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('Starfield (item 3)', () => {
  const starfield = registryDef('space.starfield')!

  it('a fixed set of stars inside one tile', () => {
    expect(STARS).toHaveLength(STAR_COUNT)
    for (const star of STARS) {
      expect(star.x - star.r).toBeGreaterThanOrEqual(0)
      expect(star.y - star.r).toBeGreaterThanOrEqual(0)
      expect(star.x + star.r).toBeLessThanOrEqual(STAR_TILE)
      expect(star.y + star.r).toBeLessThanOrEqual(STAR_TILE)
      expect(star.a).toBeGreaterThan(0)
      expect(star.a).toBeLessThanOrEqual(STAR_MAX_ALPHA)
    }
    // The same tile every time: built once, kept.
    expect(starTileUrl()).toBe(starTileUrl())
    expect(starTileUrl()).toMatch(/^data:image\/svg\+xml,/)
    expect(decodeURIComponent(starTileUrl()).match(/<circle /g)).toHaveLength(
      STAR_COUNT,
    )
  })

  it('a texture layer over the gradients, under the grain, in the key', () => {
    expect(starfield.stars).toBe(true)
    const compiled = compileBackdrop(starfield, 'dark', FRAME)!
    expect(compiled.texture).toEqual([{kind: 'stars'}])
    const grained = compileBackdrop({...starfield, grain: true}, 'dark', FRAME)!
    expect(paintedLayers(grained).map(l => l.kind)).toEqual([
      'linear',
      'radial',
      'stars',
      'grain',
    ])
    expect(compileKey(starfield)).not.toBe(
      compileKey({...starfield, stars: undefined}),
    )
    // Only the Starfield carries stars.
    expect(BACKDROP_DEFS.filter(d => d.stars).map(d => d.id)).toEqual([
      'space.starfield',
    ])
  })

  it('a static repeated tile anchored at the frame origin, no filters', () => {
    const compiled = compileBackdrop(starfield, 'dark', FRAME)!
    const css = cssBackground(compiled, ['rgba(0, 0, 0, 0.5)'], FRAME, {
      x: -10,
      y: -20,
    })
    expect(css.backgroundImage.startsWith('linear-gradient(')).toBe(true)
    expect(css.backgroundImage).toContain(`url("${starTileUrl()}")`)
    expect(css.backgroundSize.split(', ')).toEqual([
      '100% 100%',
      `${STAR_TILE}px ${STAR_TILE}px`,
      '1440px 900px',
      '1440px 900px',
    ])
    expect(css.backgroundRepeat).toBe('no-repeat, repeat, no-repeat, no-repeat')
    expect(css.backgroundPosition).toBe(
      '0px 0px, -10px -20px, -10px -20px, -10px -20px',
    )
    expect(JSON.stringify(css)).not.toMatch(/filter|animation|transition/i)
  })

  it('the glass sees the stars', () => {
    const plain = {...starfield, stars: undefined}
    expect(sampledColors(starfield, 'dark').length).toBe(
      sampledColors(plain, 'dark').length * 2,
    )
    for (const theme of THEMES) {
      expect(glassAlpha(starfield, theme)).toBeGreaterThanOrEqual(
        glassAlpha(plain, theme),
      )
    }
    expect(glassAlpha(starfield, 'dark')).toBeGreaterThan(
      glassAlpha(plain, 'dark'),
    )
  })

  it('native draws the same stars as one pattern', () => {
    const frame = {width: 300, height: 200}
    const compiled = compileBackdrop(starfield, 'dark', frame)!
    const {UNSAFE_getAllByType} = render(
      <CompiledSvg compiled={compiled} frame={frame} />,
    )
    const [pattern] = UNSAFE_getAllByType(Pattern)
    expect(pattern.props.width).toBe(STAR_TILE)
    expect(pattern.props.patternUnits).toBe('userSpaceOnUse')
    const circles = UNSAFE_getAllByType(Circle)
    expect(circles).toHaveLength(STAR_COUNT)
    expect(circles[0].props.cx).toBe(STARS[0].x)
    expect(circles[0].props.fillOpacity).toBe(STARS[0].a)
    // Linear, radial, stars: one rect each.
    expect(UNSAFE_getAllByType(Rect)).toHaveLength(3)
  })
})

describe('custom stripes are drawn as the flags are (item 10)', () => {
  const stripes = ['#112233', '#445566', '#778899', '#AABBCC']

  it('their colours top to bottom, at the flags angle and bloom', () => {
    const def = customDef({
      mode: 'stripes',
      a: '#000000',
      b: '#FFFFFF',
      stripes,
    })
    expect(def.stripes).toEqual(stripes)
    expect(def.stripe.angleDeg).toBe(165)
    expect(def.bloomOpacity).toBe(0.1)
    expect(def.layers).toBeUndefined()
    const flag = registryDef('pride.graysexual')!
    const [mine] = compileBackdrop(def, 'light', FRAME)!.layers
    const [theirs] = compileBackdrop(
      {...flag, stripes, lockColors: false},
      'light',
      FRAME,
    )!.layers
    expect(mine).toEqual(theirs)
  })

  it('no pattern on stripes; one-tone and two-tone unchanged', () => {
    const def = customDef({
      mode: 'stripes',
      a: '#000000',
      b: '#FFFFFF',
      stripes,
      pattern: 'dots',
    })
    expect(def.pattern).toBeUndefined()
    expect(
      customDef({mode: 'twoTone', a: '#000000', b: '#FFFFFF', stripes}).stripes,
    ).toEqual(['#000000', '#FFFFFF'])
    expect(
      customDef({mode: 'solid', a: '#000000', b: '#FFFFFF', stripes}).stripes,
    ).toEqual(['#000000', '#000000'])
  })

  it('the glass sees every stripe', () => {
    const colors = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF']
    const def = customDef({
      mode: 'stripes',
      a: '#000000',
      b: '#FFFFFF',
      stripes: colors,
    })
    const seen = sampledColors(def, 'light').map(c => JSON.stringify(c))
    for (const color of colors) {
      expect(seen).toContain(JSON.stringify(hexToRgb(color)))
    }
    // A stripe between black and white needs more glass than the pair alone.
    const pair = customDef({mode: 'twoTone', a: '#000000', b: '#FFFFFF'})
    expect(glassAlpha(def, 'dark')).toBeGreaterThanOrEqual(
      glassAlpha(pair, 'dark'),
    )
  })
})
