/*
 * The backdrop registry (Phase 3 design, 3.1): 1.0's entries in 1.0's
 * order, stored as the inputs of 1.0's layer builders, plus the Custom entry
 * built from the custom configuration. Fixed from 1.0: `lockColors` on every
 * pride flag, names as Lingui descriptors.
 *
 * Change list 2 (2026-10-20): seven more flags among the pride ones, the
 * Nature palettes (striped, drawn in the soft diagonal look like the
 * materials), the Skies and the Colour blobs (each with its own linear and
 * radial layers), and the "Time of day" sky. The nine solids are gone; a
 * stored solid id reads as a custom one-tone of the same colour
 * (`REMOVED_SOLIDS`, applied by the record and device parsers).
 *
 * Change list 3 (2026-10-20): nine more flags, the Calm, Seasonal (with
 * "Follow the season"), Space (with the static Starfield), Gems and
 * Aesthetics collections, and custom stripes.
 */

import {msg} from '@lingui/core/macro'

import {type Appearance, type CustomConfig} from '#/horizon/appearance/model'
import {makeStripedStops} from '#/horizon/backdrops/stripes'
import {
  type BackdropCollection,
  type BackdropDef,
  type Hex,
  type Layer,
  type LinearLayer,
  type RadialLayer,
  type ThemeName,
  type Tuning,
} from '#/horizon/backdrops/types'

export const BACKDROP_NONE = 'none'
export const BACKDROP_CUSTOM = 'custom'

/** The sky that follows the local hour (change list 2, item 3). */
export const BACKDROP_SKIES_AUTO = 'skies.auto'

/** The seasonal backdrop that follows the date (change list 3, item 4). */
export const BACKDROP_SEASON_AUTO = 'seasonal.auto'

const EDGE_EPSILON = 0.002

type Row = {
  id: string
  name: BackdropDef['name']
  collection: BackdropCollection
  version: number
  intent: string[]
  stripes: Hex[]
  angleDeg: number
  bloom: number
  tuning?: Partial<Record<ThemeName, Tuning>>
  layers?: Layer[]
}

function def({angleDeg, bloom, ...row}: Row): BackdropDef {
  return {
    ...row,
    stripe: {angleDeg, edgeEpsilon: EDGE_EPSILON, softenEdges: true},
    bloomOpacity: bloom,
    lockColors: row.collection === 'pride',
  }
}

const FLAT: Partial<Record<ThemeName, Tuning>> = {
  light: {saturation: 1, brightness: 1},
  dim: {saturation: 1, brightness: 1},
  dark: {saturation: 1, brightness: 1},
}

function tuning(
  light: [number, number],
  dim: [number, number],
  dark: [number, number],
): Partial<Record<ThemeName, Tuning>> {
  return {
    light: {saturation: light[0], brightness: light[1]},
    dim: {saturation: dim[0], brightness: dim[1]},
    dark: {saturation: dark[0], brightness: dark[1]},
  }
}

/** A flag added in change list 2: 165 degrees, a light bloom, flat. */
function flag(
  id: string,
  name: BackdropDef['name'],
  stripes: Hex[],
  intent: string[],
): BackdropDef {
  return def({
    id,
    name,
    collection: 'pride',
    version: 1,
    intent: [...intent, 'flag', 'striped'],
    stripes,
    angleDeg: 165,
    bloom: 0.1,
    tuning: FLAT,
  })
}

/** A Nature palette: the materials' soft diagonal, in fuller colours. */
function nature(
  id: string,
  name: BackdropDef['name'],
  stripes: Hex[],
  intent: string[],
): BackdropDef {
  return def({
    id,
    name,
    collection: 'nature',
    version: 1,
    intent: [...intent, 'nature', 'soft'],
    stripes,
    angleDeg: 135,
    bloom: 0.1,
    tuning: FLAT,
  })
}

/** A pool of colour fading out from its centre. */
function pool(
  color: Hex,
  cx: number,
  cy: number,
  r: number,
  opacity: number,
): RadialLayer {
  return {
    kind: 'radial',
    cx,
    cy,
    r,
    opacity,
    stops: [
      {color, pos: 0, alpha: 1},
      {color, pos: 1, alpha: 0},
    ],
  }
}

/**
 * A sky: a soft vertical gradient, top to bottom, and a low glow rising
 * from below the bottom edge.
 */
function sky(
  id: string,
  name: BackdropDef['name'],
  [top, middle, bottom]: [Hex, Hex, Hex],
  glow: {color: Hex; opacity: number},
  intent: string[],
  extra: RadialLayer[] = [],
): BackdropDef {
  return def({
    id,
    name,
    collection: 'skies',
    version: 1,
    intent: [...intent, 'sky'],
    stripes: [top, middle, bottom],
    angleDeg: 180,
    bloom: 0,
    tuning: FLAT,
    layers: [
      {
        kind: 'linear',
        direction: {kind: 'angle', deg: 180},
        opacity: 1,
        stops: [
          {color: top, pos: 0},
          {color: middle, pos: 0.55},
          {color: bottom, pos: 1},
        ],
      },
      pool(glow.color, 0.5, 1.08, 0.7, glow.opacity),
      ...extra,
    ],
  })
}

/** A corner-to-corner two-colour base. */
function cornerBase(from: Hex, to: Hex): LinearLayer {
  return {
    kind: 'linear',
    direction: {kind: 'corner'},
    opacity: 1,
    stops: [
      {color: from, pos: 0},
      {color: to, pos: 1},
    ],
  }
}

/** A gradient at `deg` through colours at their positions. */
function linearBase(deg: number, stops: [Hex, number][]): LinearLayer {
  return {
    kind: 'linear',
    direction: {kind: 'angle', deg},
    opacity: 1,
    stops: stops.map(([color, pos]) => ({color, pos})),
  }
}

/**
 * A def drawn from its own layers (change list 3): `stripes` are its
 * representative colours (the base's, then each pool's centre).
 */
function layered(
  id: string,
  name: BackdropDef['name'],
  collection: BackdropCollection,
  layers: Layer[],
  intent: string[],
): BackdropDef {
  const colors: Hex[] = []
  for (const layer of layers) {
    if (layer.kind === 'radial') colors.push(layer.stops[0].color)
    else for (const stop of layer.stops) colors.push(stop.color)
  }
  return def({
    id,
    name,
    collection,
    version: 1,
    intent: [...intent, collection],
    stripes: colors.filter((c, i) => colors.indexOf(c) === i),
    angleDeg: 135,
    bloom: 0,
    tuning: FLAT,
    layers,
  })
}

/**
 * Pools of colour over a corner-to-corner base, as the colour blobs are
 * drawn; also gems, space, seasonal and aesthetics entries.
 */
function pooled(
  id: string,
  name: BackdropDef['name'],
  collection: BackdropCollection,
  [from, to]: [Hex, Hex],
  pools: RadialLayer[],
  intent: string[],
): BackdropDef {
  return layered(id, name, collection, [cornerBase(from, to), ...pools], intent)
}

/**
 * Colour blobs: a pale (or deep) corner-to-corner base under overlapping
 * pools of colour.
 */
function blobs(
  id: string,
  name: BackdropDef['name'],
  [from, to]: [Hex, Hex],
  pools: RadialLayer[],
  intent: string[],
): BackdropDef {
  return def({
    id,
    name,
    collection: 'blobs',
    version: 1,
    intent: [...intent, 'blobs'],
    stripes: [from, to, ...pools.map(p => p.stops[0].color)],
    angleDeg: 135,
    bloom: 0,
    tuning: FLAT,
    layers: [cornerBase(from, to), ...pools],
  })
}

/**
 * A Calm backdrop (change list 3, item 5): one gentle top-to-bottom
 * gradient through three neighbouring shades of one muted colour. No pools,
 * no stripes, no texture: nothing in it draws the eye.
 */
function calm(
  id: string,
  name: BackdropDef['name'],
  [top, middle, bottom]: [Hex, Hex, Hex],
  intent: string[],
): BackdropDef {
  return layered(
    id,
    name,
    'calm',
    [
      linearBase(180, [
        [top, 0],
        [middle, 0.5],
        [bottom, 1],
      ]),
    ],
    [...intent, 'quiet', 'low contrast'],
  )
}

const SKY_NIGHT = sky(
  'skies.night',
  msg({message: 'Night', context: 'backdrop name'}),
  ['#05070F', '#0E1630', '#1C2A4F'],
  {color: '#3A5A8C', opacity: 0.35},
  ['dark', 'calm'],
)
const SKY_DAWN = sky(
  'skies.dawn',
  msg({message: 'Dawn', context: 'backdrop name'}),
  ['#3E4A7A', '#C88AA8', '#F6C7A0'],
  {color: '#FFD9A8', opacity: 0.6},
  ['soft', 'warm'],
)
const SKY_DAY = sky(
  'skies.day',
  msg({message: 'Daylight', context: 'backdrop name'}),
  ['#4A90D9', '#8EC5EE', '#D8EEFA'],
  {color: '#FFFFFF', opacity: 0.5},
  ['bright', 'airy'],
)
const SKY_GOLDEN = sky(
  'skies.golden',
  msg({message: 'Golden Hour', context: 'backdrop name'}),
  ['#6F8FC4', '#F2B872', '#F7D79A'],
  {color: '#FFC56B', opacity: 0.6},
  ['warm', 'bright'],
)
const SKY_DUSK = sky(
  'skies.dusk',
  msg({message: 'Dusk', context: 'backdrop name'}),
  ['#2E3A6E', '#B05E7E', '#F08A5D'],
  {color: '#FF9E6B', opacity: 0.55},
  ['warm', 'moody'],
)
const SKY_TWILIGHT = sky(
  'skies.twilight',
  msg({message: 'Twilight', context: 'backdrop name'}),
  ['#141B3D', '#3A3F7A', '#8A6AA6'],
  {color: '#C58BC0', opacity: 0.4},
  ['moody', 'cool'],
)
const SKY_AURORA = sky(
  'skies.aurora',
  msg({message: 'Aurora', context: 'backdrop name'}),
  ['#06121F', '#0B2A3A', '#0E1E2E'],
  {color: '#1E6B6B', opacity: 0.35},
  ['dark', 'vivid'],
  [
    pool('#3DFFB0', 0.3, 0.22, 0.6, 0.42),
    pool('#8A5CFF', 0.78, 0.32, 0.55, 0.32),
    pool('#2BD4E8', 0.55, 0.5, 0.45, 0.22),
  ],
)

/* Seasonal (change list 3, item 4), in the year's order. */
const SEASON_SPRING = pooled(
  'seasonal.spring',
  msg({message: 'Spring Bloom', context: 'backdrop name'}),
  'seasonal',
  ['#F7FBEF', '#FDF1F5'],
  [
    pool('#F7B6CF', 0.2, 0.25, 0.5, 0.5),
    pool('#BFE6A3', 0.82, 0.7, 0.55, 0.45),
    pool('#D9C6F2', 0.75, 0.15, 0.4, 0.4),
    pool('#FFE7A6', 0.3, 0.88, 0.4, 0.4),
  ],
  ['soft', 'fresh'],
)
const SEASON_SUMMER = pooled(
  'seasonal.summer',
  msg({message: 'Summer Haze', context: 'backdrop name'}),
  'seasonal',
  ['#FFF3DC', '#FCE1D2'],
  [
    pool('#FFC870', 0.75, 0.2, 0.6, 0.55),
    pool('#FFA28A', 0.2, 0.75, 0.55, 0.4),
    pool('#A9D8F2', 0.15, 0.12, 0.45, 0.35),
  ],
  ['warm', 'bright'],
)
const SEASON_HALLOWS = pooled(
  'seasonal.hallows',
  msg({message: 'Hallows’ Eve', context: 'backdrop name'}),
  'seasonal',
  ['#120C17', '#1D0F24'],
  [
    pool('#6A2FA0', 0.2, 0.2, 0.55, 0.5),
    pool('#3B0F4A', 0.85, 0.4, 0.5, 0.45),
    pool('#E8701E', 0.5, 1.05, 0.65, 0.5),
  ],
  ['dark', 'autumn'],
)
const SEASON_WINTER = pooled(
  'seasonal.winter',
  msg({message: 'Winter Frost', context: 'backdrop name'}),
  'seasonal',
  ['#EEF5FB', '#D6E6F3'],
  [
    pool('#FFFFFF', 0.15, 0.15, 0.55, 0.7),
    pool('#B8D4EE', 0.85, 0.8, 0.55, 0.5),
    pool('#DCE3F7', 0.6, 0.35, 0.4, 0.4),
  ],
  ['cool', 'airy'],
)
const SEASON_CHRISTMAS = pooled(
  'seasonal.christmas',
  msg({message: 'Christmas', context: 'backdrop name'}),
  'seasonal',
  ['#0D2318', '#122C20'],
  [
    pool('#B32234', 0.2, 0.25, 0.55, 0.45),
    pool('#2E7D4F', 0.85, 0.35, 0.5, 0.45),
    pool('#E3B24A', 0.6, 0.95, 0.5, 0.35),
    pool('#F2F5F7', 0.1, 0.9, 0.35, 0.2),
  ],
  ['dark', 'festive'],
)

/* Nature's Autumn, which "Follow the season" also uses (2026-10-21). */
const NATURE_AUTUMN = nature(
  'nature.autumn',
  msg({message: 'Autumn', context: 'backdrop name'}),
  ['#F6D9A8', '#EEAE5E', '#D9783A', '#B0502E', '#7E3A2A'],
  ['warm', 'cozy'],
)

/**
 * The seasonal backdrop for a month (0-11), for "Follow the season"
 * (skydeval, 2026-10-21). October is Hallows' Eve and December is Christmas in
 * both hemispheres: they follow the calendar, not the weather. The other
 * months follow meteorological seasons, northern unless `southern`:
 * spring, summer, autumn (Nature's Autumn), winter. Switches by date only;
 * nothing animates.
 */
export function seasonForMonth(month: number, southern = false): BackdropDef {
  if (month === 9) return SEASON_HALLOWS
  if (month === 11) return SEASON_CHRISTMAS
  const m = southern ? (month + 6) % 12 : month
  if (m >= 2 && m <= 4) return SEASON_SPRING
  if (m >= 5 && m <= 7) return SEASON_SUMMER
  if (m >= 8 && m <= 10) return NATURE_AUTUMN
  return SEASON_WINTER
}

/** The local month and hemisphere "Follow the season" resolves with. */
export type SeasonInput = {month: number; southern: boolean}

/* The Starfield's base (change list 3, item 3): a near-black night. */
const STARFIELD: BackdropDef = {
  ...layered(
    'space.starfield',
    msg({message: 'Starfield', context: 'backdrop name'}),
    'space',
    [
      linearBase(180, [
        ['#03040A', 0],
        ['#070A18', 0.55],
        ['#0C1124', 1],
      ]),
      pool('#1A2350', 0.5, 1.1, 0.8, 0.35),
    ],
    ['dark', 'stars'],
  ),
  stars: true,
}

/*
 * Retro 70s (change list 3, item 1): stacked horizontal bands with hard
 * edges, built with the flags' stripe stops at 180 degrees.
 */
const RETRO_BANDS: Hex[] = [
  '#F2C14E',
  '#F08A3C',
  '#D9612B',
  '#A0452A',
  '#5C3520',
]

/**
 * The sky for a local hour (0-23), for "Time of day". Aurora is never
 * picked: it is not a time of day.
 */
export function skyForHour(hour: number): BackdropDef {
  if (hour >= 5 && hour < 7) return SKY_DAWN
  if (hour >= 7 && hour < 16) return SKY_DAY
  if (hour >= 16 && hour < 18) return SKY_GOLDEN
  if (hour >= 18 && hour < 20) return SKY_DUSK
  if (hour >= 20 && hour < 22) return SKY_TWILIGHT
  return SKY_NIGHT
}

/** The registry entries, in the picker's order. */
export const BACKDROP_DEFS: readonly BackdropDef[] = [
  {
    id: BACKDROP_NONE,
    name: msg({message: 'None', context: 'backdrop name'}),
    collection: 'system',
    version: 1,
    intent: [],
    stripes: [],
    stripe: {angleDeg: 180, edgeEpsilon: EDGE_EPSILON, softenEdges: true},
    bloomOpacity: 0,
    lockColors: false,
  },
  def({
    id: 'pride.lesbian',
    name: msg({message: 'Lesbian Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['warm', 'flag', 'striped'],
    stripes: ['#D52D00', '#FF9A56', '#FFFFFF', '#D162A4', '#A30262'],
    angleDeg: 165,
    bloom: 0.16,
    tuning: tuning([1.0, 1.02], [1.0, 0.98], [1.02, 0.92]),
  }),
  def({
    id: 'pride.trans',
    name: msg({message: 'Trans Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['calm', 'airy', 'flag', 'striped'],
    stripes: ['#5BCEFA', '#F5A9B8', '#FFFFFF', '#F5A9B8', '#5BCEFA'],
    angleDeg: 165,
    bloom: 0.12,
    tuning: FLAT,
  }),
  flag(
    'pride.transfeminine',
    msg({message: 'Transfeminine Pride', context: 'backdrop name'}),
    [
      '#73DEFF',
      '#FFE1ED',
      '#FFB5D6',
      '#FE8CBF',
      '#FFB5D6',
      '#FFE1ED',
      '#73DEFF',
    ],
    ['airy'],
  ),
  flag(
    'pride.transmasculine',
    msg({message: 'Transmasculine Pride', context: 'backdrop name'}),
    [
      '#FF8ABD',
      '#CDF5FE',
      '#9AEBFF',
      '#74DFFF',
      '#9AEBFF',
      '#CDF5FE',
      '#FF8ABD',
    ],
    ['airy'],
  ),
  def({
    id: 'pride.bi',
    name: msg({message: 'Bi Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['bold', 'twilight', 'flag', 'striped'],
    stripes: ['#D60270', '#D60270', '#9B4F96', '#0038A8', '#0038A8'],
    angleDeg: 150,
    bloom: 0.12,
    tuning: FLAT,
  }),
  def({
    id: 'pride.rainbow',
    name: msg({message: 'Rainbow', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['bright', 'celebratory', 'flag', 'striped'],
    stripes: ['#E40303', '#FF8C00', '#FFED00', '#008026', '#004DFF', '#750787'],
    angleDeg: 135,
    bloom: 0.1,
    tuning: FLAT,
  }),
  // Philadelphia's 2017 flag: black and brown over the six rainbow stripes.
  flag(
    'pride.philly',
    msg({message: 'Philly Pride', context: 'backdrop name'}),
    [
      '#000000',
      '#784F17',
      '#E40303',
      '#FF8C00',
      '#FFED00',
      '#008026',
      '#004DFF',
      '#750787',
    ],
    ['bright', 'celebratory'],
  ),
  // The 2015 striped queer flag (skydeval, change list 3, item 8).
  flag(
    'pride.queer',
    msg({message: 'Queer Pride', context: 'backdrop name'}),
    [
      '#000000',
      '#99D9EA',
      '#00A2E8',
      '#B5E61D',
      '#FFFFFF',
      '#FFC90E',
      '#FD6666',
      '#FFAEC9',
    ],
    ['bright'],
  ),
  def({
    id: 'pride.gay',
    name: msg({message: 'Gay Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['cool', 'flag', 'striped'],
    stripes: ['#078D70', '#26CEAA', '#98E8C1', '#7BADE2', '#3D1A78'],
    angleDeg: 165,
    bloom: 0.12,
    tuning: FLAT,
  }),
  def({
    id: 'pride.pan',
    name: msg({message: 'Pan Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['bright', 'flag', 'striped'],
    stripes: ['#FF218C', '#FFD800', '#21B1FF'],
    angleDeg: 150,
    bloom: 0.1,
    tuning: FLAT,
  }),
  flag(
    'pride.omnisexual',
    msg({message: 'Omnisexual Pride', context: 'backdrop name'}),
    ['#FC9CCC', '#FC54BC', '#240444', '#645CFC', '#8CA4FC'],
    ['bold'],
  ),
  flag(
    'pride.polysexual',
    msg({message: 'Polysexual Pride', context: 'backdrop name'}),
    ['#F61CB9', '#07D569', '#1C92F6'],
    ['bright'],
  ),
  flag(
    'pride.abrosexual',
    msg({message: 'Abrosexual Pride', context: 'backdrop name'}),
    ['#65C286', '#B4E4CC', '#FFFFFF', '#E796B7', '#D9446E'],
    ['soft'],
  ),
  def({
    id: 'pride.ace',
    name: msg({message: 'Ace Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['quiet', 'flag', 'striped'],
    stripes: ['#000000', '#A3A3A3', '#FFFFFF', '#800080'],
    angleDeg: 165,
    bloom: 0.08,
    tuning: FLAT,
  }),
  /*
   * The demi flags' black chevron, simplified to a first stripe as the
   * intersex ring is; white and grey are doubled to keep their 2:1:2 bands.
   */
  flag(
    'pride.demisexual',
    msg({message: 'Demisexual Pride', context: 'backdrop name'}),
    ['#000000', '#FFFFFF', '#FFFFFF', '#6E0070', '#D2D2D2', '#D2D2D2'],
    ['quiet'],
  ),
  flag(
    'pride.graysexual',
    msg({message: 'Graysexual Pride', context: 'backdrop name'}),
    ['#740195', '#B2B2B2', '#FFFFFF', '#B2B2B2', '#740195'],
    ['quiet'],
  ),
  def({
    id: 'pride.aromantic',
    name: msg({message: 'Aromantic Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 1,
    intent: ['calm', 'flag', 'striped'],
    stripes: ['#3DA542', '#A7D379', '#FFFFFF', '#A9A9A9', '#000000'],
    angleDeg: 165,
    bloom: 0.1,
    tuning: FLAT,
  }),
  flag(
    'pride.demiromantic',
    msg({message: 'Demiromantic Pride', context: 'backdrop name'}),
    ['#000000', '#FFFFFF', '#FFFFFF', '#3DA542', '#D2D2D2', '#D2D2D2'],
    ['calm'],
  ),
  flag(
    'pride.grayromantic',
    msg({message: 'Grayromantic Pride', context: 'backdrop name'}),
    ['#087D16', '#B2B2B2', '#FFFFFF', '#B2B2B2', '#087D16'],
    ['calm'],
  ),
  flag(
    'pride.aroace',
    msg({message: 'Aroace Pride', context: 'backdrop name'}),
    ['#E28C00', '#ECCD00', '#FFFFFF', '#62AEDC', '#203856'],
    ['warm'],
  ),
  def({
    id: 'pride.nonbinary',
    name: msg({message: 'Nonbinary Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['bold', 'flag', 'striped'],
    stripes: ['#FCF434', '#FFFFFF', '#9C59D1', '#2C2C2C'],
    angleDeg: 155,
    bloom: 0.1,
    tuning: FLAT,
  }),
  flag(
    'pride.genderqueer',
    msg({message: 'Genderqueer Pride', context: 'backdrop name'}),
    ['#B57EDC', '#FFFFFF', '#4A8123'],
    ['bold'],
  ),
  flag(
    'pride.genderfluid',
    msg({message: 'Genderfluid Pride', context: 'backdrop name'}),
    ['#FF76A4', '#FFFFFF', '#C011D7', '#000000', '#2F3CBE'],
    ['bold'],
  ),
  flag(
    'pride.bigender',
    msg({message: 'Bigender Pride', context: 'backdrop name'}),
    [
      '#C479A2',
      '#EDA5CD',
      '#D6C7E8',
      '#FFFFFF',
      '#D6C7E8',
      '#9AC7E8',
      '#6D82D1',
    ],
    ['soft'],
  ),
  flag(
    'pride.agender',
    msg({message: 'Agender Pride', context: 'backdrop name'}),
    [
      '#000000',
      '#BCC4C7',
      '#FFFFFF',
      '#B7F684',
      '#FFFFFF',
      '#BCC4C7',
      '#000000',
    ],
    ['quiet'],
  ),
  def({
    id: 'pride.intersex',
    name: msg({message: 'Intersex Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 1,
    intent: ['symbolic', 'flag', 'focused'],
    stripes: ['#FFD800', '#FFD800', '#7902AA'],
    angleDeg: 140,
    bloom: 0.2,
    tuning: FLAT,
  }),
  def({
    id: 'pride.disability',
    name: msg({message: 'Disability Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['calm', 'flag', 'striped'],
    stripes: ['#CF7280', '#EEDC82', '#7BCF9B', '#5FA6D6', '#3F3F3F'],
    angleDeg: 160,
    bloom: 0.1,
    tuning: FLAT,
  }),
  def({
    id: 'pride.neurodiversity',
    name: msg({message: 'Neurodiversity Pride', context: 'backdrop name'}),
    collection: 'pride',
    version: 2,
    intent: ['warm', 'symbolic', 'striped'],
    stripes: ['#FFD700', '#FF8C00', '#FF69B4', '#6A5ACD', '#00CED1'],
    angleDeg: 145,
    bloom: 0.12,
    tuning: FLAT,
  }),
  def({
    id: 'materials.paper',
    name: msg({message: 'Paper', context: 'backdrop name'}),
    collection: 'materials',
    version: 1,
    intent: ['calm', 'warm', 'soft', 'striped'],
    stripes: ['#F6F1E8', '#F2F3F0', '#F6F1E8', '#EFE6DA', '#F6F1E8', '#E6D8C8'],
    angleDeg: 20,
    bloom: 0.14,
    tuning: tuning([0.92, 1.03], [0.9, 0.99], [0.88, 0.92]),
  }),
  def({
    id: 'materials.glass',
    name: msg({message: 'Glass', context: 'backdrop name'}),
    collection: 'materials',
    version: 1,
    intent: ['calm', 'cool', 'airy', 'striped'],
    stripes: [
      '#EAF2FF',
      '#DDF7F2',
      '#EAF2FF',
      '#EEE8FF',
      '#EAF2FF',
      '#FFFFFF',
      '#EAF2FF',
      '#CFE0FF',
    ],
    angleDeg: 70,
    bloom: 0.12,
    tuning: tuning([0.94, 1.02], [0.92, 0.98], [0.9, 0.9]),
  }),
  def({
    id: 'materials.granite',
    name: msg({message: 'Granite', context: 'backdrop name'}),
    collection: 'materials',
    version: 1,
    intent: ['calm', 'neutral', 'grounded', 'striped'],
    stripes: [
      '#ECEDEF',
      '#D9DBE0',
      '#D9DBE0',
      '#DED8D2',
      '#D9DBE0',
      '#D3D9E6',
      '#BFC4CF',
    ],
    angleDeg: 6,
    bloom: 0.1,
    tuning: tuning([0.85, 1.02], [0.82, 0.98], [0.8, 0.9]),
  }),
  def({
    id: 'materials.fabric',
    name: msg({message: 'Fabric', context: 'backdrop name'}),
    collection: 'materials',
    version: 1,
    intent: ['calm', 'warm', 'cozy', 'striped'],
    stripes: ['#F1EAE3', '#E9DDD3', '#F1EAE3', '#E6D7CC', '#F1EAE3', '#DCD0C7'],
    angleDeg: 38,
    bloom: 0.13,
    tuning: tuning([0.92, 1.02], [0.9, 0.98], [0.88, 0.9]),
  }),
  def({
    id: 'materials.clay',
    name: msg({message: 'Clay', context: 'backdrop name'}),
    collection: 'materials',
    version: 1,
    intent: ['calm', 'earthy', 'warm', 'striped'],
    stripes: ['#F3E6DE', '#EAD4C7', '#F3E6DE', '#E6C4B3', '#F3E6DE', '#DDB2A1'],
    angleDeg: 18,
    bloom: 0.12,
    tuning: tuning([0.96, 1.02], [0.94, 0.98], [0.92, 0.9]),
  }),
  def({
    id: 'materials.fog',
    name: msg({message: 'Fog', context: 'backdrop name'}),
    collection: 'materials',
    version: 1,
    intent: ['quiet', 'neutral', 'airy', 'soft'],
    stripes: ['#F4F6F8', '#EEF1F4', '#F4F6F8', '#E9EDF2', '#F4F6F8', '#E4E9EF'],
    angleDeg: 92,
    bloom: 0.09,
    tuning: tuning([0.7, 1.04], [0.68, 1.0], [0.66, 0.92]),
  }),
  def({
    id: 'materials.inkwash',
    name: msg({message: 'Ink Wash', context: 'backdrop name'}),
    collection: 'materials',
    version: 1,
    intent: ['calm', 'moody', 'cool', 'soft'],
    stripes: ['#EEF2F7', '#DDE5F1', '#EEF2F7', '#CBD7E8', '#EEF2F7', '#B8C6DA'],
    angleDeg: 120,
    bloom: 0.1,
    tuning: tuning([0.86, 1.01], [0.84, 0.97], [0.82, 0.89]),
  }),
  calm(
    'calm.hush',
    msg({message: 'Hush', context: 'backdrop name'}),
    ['#E8E5E0', '#E4E1DC', '#DFDBD6'],
    ['warm', 'neutral'],
  ),
  calm(
    'calm.sand',
    msg({message: 'Sand', context: 'backdrop name'}),
    ['#E9E4DB', '#E4DFD5', '#DED8CD'],
    ['warm'],
  ),
  calm(
    'calm.sage',
    msg({message: 'Soft Sage', context: 'backdrop name'}),
    ['#DEE3DA', '#D9DFD5', '#D3D9CE'],
    ['green'],
  ),
  calm(
    'calm.stillwater',
    msg({message: 'Still Water', context: 'backdrop name'}),
    ['#DDE4E7', '#D8E0E3', '#D2DADE'],
    ['cool'],
  ),
  calm(
    'calm.lilac',
    msg({message: 'Quiet Lilac', context: 'backdrop name'}),
    ['#E3E0E8', '#DEDBE4', '#D8D5DF'],
    ['cool'],
  ),
  calm(
    'calm.slate',
    msg({message: 'Calm Slate', context: 'backdrop name'}),
    ['#2C3136', '#2A2F34', '#272B30'],
    ['dark', 'cool'],
  ),
  calm(
    'calm.charcoal',
    msg({message: 'Charcoal', context: 'backdrop name'}),
    ['#232426', '#212224', '#1E1F21'],
    ['dark', 'neutral'],
  ),
  nature(
    'nature.ocean',
    msg({message: 'Ocean', context: 'backdrop name'}),
    ['#D7F0F5', '#9FD6E2', '#62B6CC', '#3B8FB0', '#2A6D91'],
    ['cool', 'calm'],
  ),
  nature(
    'nature.forest',
    msg({message: 'Forest', context: 'backdrop name'}),
    ['#E3EDD9', '#B5CFA0', '#7FA872', '#4F7F52', '#2F5A3C'],
    ['cool', 'grounded'],
  ),
  nature(
    'nature.desert',
    msg({message: 'Desert', context: 'backdrop name'}),
    ['#F7E6C8', '#EDC99A', '#DDA46E', '#C47F52', '#9C5B3E'],
    ['warm', 'earthy'],
  ),
  nature(
    'nature.sakura',
    msg({message: 'Sakura', context: 'backdrop name'}),
    ['#FFF1F4', '#FBD5DF', '#F5B3C6', '#E894AE', '#C97B9A'],
    ['warm', 'airy'],
  ),
  NATURE_AUTUMN,
  nature(
    'nature.moss',
    msg({message: 'Moss', context: 'backdrop name'}),
    ['#E7EBCF', '#C6D09A', '#9BAE6B', '#738A4C', '#4E6436'],
    ['calm', 'earthy'],
  ),
  {
    ...SEASON_SPRING,
    id: BACKDROP_SEASON_AUTO,
    name: msg({message: 'Follow the Season', context: 'backdrop name'}),
    intent: ['seasonal', 'follows the date'],
  },
  SEASON_SPRING,
  SEASON_SUMMER,
  SEASON_HALLOWS,
  SEASON_CHRISTMAS,
  SEASON_WINTER,
  {
    ...SKY_DAY,
    id: BACKDROP_SKIES_AUTO,
    name: msg({message: 'Time of Day', context: 'backdrop name'}),
    intent: ['sky', 'time of day'],
  },
  SKY_DAWN,
  SKY_DAY,
  SKY_GOLDEN,
  SKY_DUSK,
  SKY_TWILIGHT,
  SKY_NIGHT,
  SKY_AURORA,
  pooled(
    'space.nebula',
    msg({message: 'Nebula', context: 'backdrop name'}),
    'space',
    ['#07060F', '#140A26'],
    [
      pool('#6A2C8C', 0.3, 0.35, 0.6, 0.55),
      pool('#B03A6E', 0.7, 0.6, 0.45, 0.4),
      pool('#1E4E8C', 0.8, 0.15, 0.5, 0.45),
      pool('#2A1250', 0.25, 0.9, 0.5, 0.5),
    ],
    ['dark', 'vivid'],
  ),
  pooled(
    'space.galaxy',
    msg({message: 'Galaxy', context: 'backdrop name'}),
    'space',
    ['#04050C', '#0B1026'],
    [
      pool('#2E3A8C', 0.5, 0.5, 0.7, 0.45),
      pool('#6B5BB8', 0.32, 0.35, 0.4, 0.35),
      pool('#1B2A5A', 0.72, 0.68, 0.45, 0.5),
      pool('#8C7AD9', 0.5, 0.48, 0.16, 0.3),
    ],
    ['dark', 'deep'],
  ),
  STARFIELD,
  pooled(
    'gems.amethyst',
    msg({message: 'Amethyst', context: 'backdrop name'}),
    'gems',
    ['#3A1D5C', '#7E4FB5'],
    [
      pool('#D2B4FF', 0.22, 0.18, 0.45, 0.45),
      pool('#A77BE0', 0.75, 0.3, 0.35, 0.35),
      pool('#2A1147', 0.85, 0.85, 0.55, 0.55),
    ],
    ['deep', 'jewel'],
  ),
  pooled(
    'gems.emerald',
    msg({message: 'Emerald', context: 'backdrop name'}),
    'gems',
    ['#0A3A2B', '#1E8558'],
    [
      pool('#8EE3B4', 0.22, 0.18, 0.45, 0.4),
      pool('#3FBF84', 0.75, 0.3, 0.35, 0.35),
      pool('#052419', 0.85, 0.85, 0.55, 0.55),
    ],
    ['deep', 'jewel'],
  ),
  pooled(
    'gems.sapphire',
    msg({message: 'Sapphire', context: 'backdrop name'}),
    'gems',
    ['#0A1C4A', '#2253B2'],
    [
      pool('#8DB2FF', 0.22, 0.18, 0.45, 0.4),
      pool('#4C82E0', 0.75, 0.3, 0.35, 0.35),
      pool('#06122F', 0.85, 0.85, 0.55, 0.55),
    ],
    ['deep', 'jewel'],
  ),
  pooled(
    'gems.rosequartz',
    msg({message: 'Rose Quartz', context: 'backdrop name'}),
    'gems',
    ['#F8DDE2', '#EBBCC7'],
    [
      pool('#FFFFFF', 0.22, 0.18, 0.45, 0.55),
      pool('#F3C9D3', 0.7, 0.3, 0.35, 0.35),
      pool('#D898A9', 0.85, 0.85, 0.5, 0.45),
    ],
    ['soft', 'jewel'],
  ),
  pooled(
    'gems.opal',
    msg({message: 'Opal', context: 'backdrop name'}),
    'gems',
    ['#F4F2F7', '#EAF4F4'],
    [
      pool('#FFC4DA', 0.2, 0.25, 0.4, 0.5),
      pool('#A4EBE2', 0.8, 0.3, 0.4, 0.5),
      pool('#C9BAFF', 0.35, 0.8, 0.4, 0.45),
      pool('#FFF0B8', 0.75, 0.85, 0.35, 0.45),
    ],
    ['soft', 'iridescent'],
  ),
  pooled(
    'gems.oilslick',
    msg({message: 'Oil Slick', context: 'backdrop name'}),
    'gems',
    ['#0D0E13', '#17142B'],
    [
      pool('#B0358C', 0.25, 0.3, 0.45, 0.45),
      pool('#1E8C8A', 0.75, 0.35, 0.45, 0.45),
      pool('#A8891E', 0.6, 0.85, 0.4, 0.4),
      pool('#4A2E9E', 0.2, 0.85, 0.4, 0.45),
    ],
    ['dark', 'iridescent'],
  ),
  pooled(
    'gems.holographic',
    msg({message: 'Holographic', context: 'backdrop name'}),
    'gems',
    ['#EEE8FF', '#E5FAFF'],
    [
      pool('#FF9DE6', 0.15, 0.2, 0.45, 0.55),
      pool('#8CEFFF', 0.85, 0.25, 0.45, 0.55),
      pool('#BCA2FF', 0.5, 0.6, 0.4, 0.5),
      pool('#FFF29E', 0.25, 0.9, 0.4, 0.5),
      pool('#9DFFC8', 0.85, 0.85, 0.35, 0.45),
    ],
    ['bright', 'iridescent'],
  ),
  blobs(
    'blobs.peach',
    msg({message: 'Peach', context: 'backdrop name'}),
    ['#FFF4EC', '#FDE8F0'],
    [
      pool('#FFB38A', 0.18, 0.2, 0.55, 0.55),
      pool('#FF8FB1', 0.85, 0.3, 0.5, 0.45),
      pool('#FFD27A', 0.5, 0.92, 0.6, 0.45),
    ],
    ['warm', 'soft'],
  ),
  blobs(
    'blobs.lagoon',
    msg({message: 'Lagoon', context: 'backdrop name'}),
    ['#EEF8FB', '#EAF0FF'],
    [
      pool('#6FD3E0', 0.15, 0.75, 0.55, 0.5),
      pool('#7FA8FF', 0.82, 0.2, 0.5, 0.45),
      pool('#9EF0C6', 0.7, 0.88, 0.45, 0.4),
    ],
    ['cool', 'soft'],
  ),
  blobs(
    'blobs.berry',
    msg({message: 'Berry', context: 'backdrop name'}),
    ['#F7EEFA', '#FCEFF5'],
    [
      pool('#C38BFF', 0.2, 0.3, 0.55, 0.5),
      pool('#FF8AC8', 0.82, 0.72, 0.55, 0.45),
      pool('#8AA0FF', 0.62, 0.08, 0.45, 0.4),
    ],
    ['vivid', 'soft'],
  ),
  blobs(
    'blobs.citrus',
    msg({message: 'Citrus', context: 'backdrop name'}),
    ['#FBFBE8', '#F0FAEC'],
    [
      pool('#FFD84D', 0.22, 0.22, 0.55, 0.5),
      pool('#9BE36B', 0.8, 0.6, 0.55, 0.42),
      pool('#FF9F4A', 0.35, 0.9, 0.45, 0.38),
    ],
    ['bright', 'warm'],
  ),
  blobs(
    'blobs.midnight',
    msg({message: 'Midnight', context: 'backdrop name'}),
    ['#0B0D1A', '#141030'],
    [
      pool('#3B2E8C', 0.2, 0.25, 0.6, 0.6),
      pool('#0E5A7A', 0.85, 0.55, 0.55, 0.55),
      pool('#7A2E6E', 0.4, 0.95, 0.5, 0.5),
    ],
    ['dark', 'moody'],
  ),
  layered(
    'aesthetics.frutigeraero',
    msg({message: 'Frutiger Aero', context: 'backdrop name'}),
    'aesthetics',
    [
      linearBase(180, [
        ['#3AA0EE', 0],
        ['#9BE3F2', 0.5],
        ['#E8F8F0', 0.7],
        ['#78C850', 0.86],
        ['#4E9E35', 1],
      ]),
      pool('#FFFFFF', 0.3, 0.12, 0.45, 0.55),
      pool('#5FE0E8', 0.85, 0.4, 0.35, 0.35),
    ],
    ['bright', 'glossy'],
  ),
  pooled(
    'aesthetics.vaporwave',
    msg({message: 'Vaporwave', context: 'backdrop name'}),
    'aesthetics',
    ['#F5B8E4', '#B9A3F0'],
    [
      pool('#5EE6E0', 0.8, 0.25, 0.5, 0.55),
      pool('#FF71CE', 0.15, 0.75, 0.5, 0.5),
      pool('#9B6BFF', 0.55, 0.95, 0.45, 0.45),
    ],
    ['vivid', 'haze'],
  ),
  layered(
    'aesthetics.synthwave',
    msg({message: 'Synthwave', context: 'backdrop name'}),
    'aesthetics',
    [
      linearBase(180, [
        ['#12052A', 0],
        ['#2D0B4E', 0.45],
        ['#7A1A6E', 0.8],
        ['#E0457B', 1],
      ]),
      pool('#FF4FA3', 0.5, 1.0, 0.75, 0.3),
      pool('#FF9A3C', 0.5, 1.02, 0.42, 0.6),
    ],
    ['dark', 'vivid'],
  ),
  layered(
    'aesthetics.y2k',
    msg({message: 'Y2K', context: 'backdrop name'}),
    'aesthetics',
    [
      linearBase(160, [
        ['#E9E3F7', 0],
        ['#C7C1E4', 0.25],
        ['#F6F8FC', 0.45],
        ['#A9C8EC', 0.65],
        ['#D8CCF2', 0.85],
        ['#BFE2F7', 1],
      ]),
      pool('#FFFFFF', 0.3, 0.2, 0.4, 0.5),
    ],
    ['cool', 'chrome'],
  ),
  def({
    id: 'aesthetics.cottagecore',
    name: msg({message: 'Cottagecore', context: 'backdrop name'}),
    collection: 'aesthetics',
    version: 1,
    intent: ['warm', 'soft', 'aesthetics'],
    stripes: ['#F6EEDF', '#D9DEC4', '#B4C29D', '#E8CFC4', '#D6A3A0'],
    angleDeg: 135,
    bloom: 0.1,
    tuning: FLAT,
  }),
  pooled(
    'aesthetics.darkacademia',
    msg({message: 'Dark Academia', context: 'backdrop name'}),
    'aesthetics',
    ['#2B1D15', '#4A1B22'],
    [
      pool('#E6D5AE', 0.2, 0.15, 0.5, 0.3),
      pool('#6E1F2B', 0.8, 0.75, 0.5, 0.5),
      pool('#5A3A26', 0.3, 0.85, 0.45, 0.45),
    ],
    ['dark', 'warm'],
  ),
  pooled(
    'aesthetics.pastelgoth',
    msg({message: 'Pastel Goth', context: 'backdrop name'}),
    'aesthetics',
    ['#131118', '#1C1822'],
    [
      pool('#C4A3F0', 0.2, 0.25, 0.5, 0.4),
      pool('#9EEBCF', 0.82, 0.75, 0.5, 0.35),
      pool('#F2A7CF', 0.75, 0.15, 0.35, 0.25),
    ],
    ['dark', 'soft'],
  ),
  layered(
    'aesthetics.retro70s',
    msg({message: 'Retro 70s', context: 'backdrop name'}),
    'aesthetics',
    [
      {
        kind: 'linear',
        direction: {kind: 'angle', deg: 180},
        opacity: 1,
        stops: makeStripedStops(RETRO_BANDS, {
          edgeEpsilon: EDGE_EPSILON,
          softenEdges: false,
        }),
      },
    ],
    ['warm', 'striped'],
  ),
]

/** The Custom entry's name. The picker's chip says "Custom". */
export const CUSTOM_NAME = msg({
  message: 'Custom Color',
  context: 'backdrop name',
})

/**
 * The nine solids removed in change list 2 (item 9) and their colours. Each
 * drew exactly as a custom one-tone of its colour, so a stored id of one is
 * read as that (`migrateRemovedSolid`): nobody's backdrop changes.
 */
export const REMOVED_SOLIDS: Readonly<Record<string, Hex>> = {
  'solids.slate': '#1F2937',
  'solids.mist': '#E9EEF5',
  'solids.red': '#B4534B',
  'solids.orange': '#C26A3B',
  'solids.yellow': '#B79B2A',
  'solids.green': '#2F7D5C',
  'solids.blue': '#2F5F9E',
  'solids.indigo': '#3A3F8F',
  'solids.violet': '#6B4A8E',
}

/**
 * Backdrop ids that were renamed, old to new. `seasonal.spooky` became
 * `seasonal.hallows` with the name Hallows' Eve (skydeval, 2026-10-21):
 * "spook" is a racist slur, and the record is public.
 */
export const RENAMED_BACKDROPS: Readonly<Record<string, string>> = {
  'seasonal.spooky': 'seasonal.hallows',
}

/**
 * An appearance with a removed solid selected, read as Custom one-tone of
 * that colour, or with a renamed backdrop selected, read with its new id;
 * any other appearance unchanged. The custom `b` (the two-tone's second
 * colour) and the pattern are kept.
 */
export function migrateRemovedSolid(appearance: Appearance): Appearance {
  const renamed = RENAMED_BACKDROPS[appearance.backdrop]
  if (renamed) return {...appearance, backdrop: renamed}
  const color = REMOVED_SOLIDS[appearance.backdrop]
  if (!color) return appearance
  return {
    ...appearance,
    backdrop: BACKDROP_CUSTOM,
    custom: {...appearance.custom, mode: 'solid', a: color},
  }
}

const BY_ID = new Map(BACKDROP_DEFS.map(entry => [entry.id, entry]))

/** A registry entry by id; `undefined` for `custom` and unknown ids. */
export function registryDef(id: string): BackdropDef | undefined {
  return BY_ID.get(id)
}

/**
 * The Custom entry for a configuration: 1.0's inputs, one stripe per colour
 * (two of the same colour when solid), and the pattern on a one-tone. Custom
 * stripes (change list 3, item 10) are drawn as the flags are: their
 * colours top to bottom, at the flags' angle and bloom.
 */
export function customDef(config: CustomConfig): BackdropDef {
  const solid = config.mode === 'solid'
  const striped =
    config.mode === 'stripes' &&
    config.stripes !== undefined &&
    config.stripes.length >= 2
  const out: BackdropDef = {
    id: BACKDROP_CUSTOM,
    name: CUSTOM_NAME,
    collection: 'custom',
    version: 1,
    intent: ['custom', config.mode],
    stripes: striped
      ? [...config.stripes!]
      : solid
        ? [config.a, config.a]
        : [config.a, config.b],
    stripe: {
      angleDeg: striped ? 165 : 180,
      edgeEpsilon: EDGE_EPSILON,
      softenEdges: true,
    },
    bloomOpacity: 0.1,
    lockColors: false,
  }
  if (solid && config.pattern) out.pattern = config.pattern
  return out
}

/**
 * The def an appearance draws: null for `none` and for ids this build does
 * not know (kept in the appearance, drawn as none). "Time of day" draws
 * the sky of `hour` (0-23, the local hour by default); "Follow the season"
 * the seasonal backdrop of `season` (the local month, northern by default).
 */
export function resolveBackdrop(
  appearance: Appearance,
  hour: number = new Date().getHours(),
  season: SeasonInput = {month: new Date().getMonth(), southern: false},
): BackdropDef | null {
  if (appearance.backdrop === BACKDROP_NONE) return null
  if (appearance.backdrop === BACKDROP_CUSTOM) {
    return customDef(appearance.custom)
  }
  if (appearance.backdrop === BACKDROP_SKIES_AUTO) return skyForHour(hour)
  if (appearance.backdrop === BACKDROP_SEASON_AUTO) {
    return seasonForMonth(season.month, season.southern)
  }
  return BY_ID.get(appearance.backdrop) ?? null
}
