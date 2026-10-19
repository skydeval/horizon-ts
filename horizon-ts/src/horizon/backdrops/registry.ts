/*
 * The backdrop registry (Phase 3 design, 3.1): 1.0's 29 entries in 1.0's
 * order, stored as the inputs of 1.0's layer builders, plus the Custom entry
 * built from the custom configuration. Fixed from 1.0: `lockColors` on every
 * pride flag, names as Lingui descriptors, no collection list.
 */

import {msg} from '@lingui/core/macro'

import {type Appearance, type CustomConfig} from '#/horizon/appearance/model'
import {
  type BackdropCollection,
  type BackdropDef,
  type Hex,
  type ThemeName,
  type Tuning,
} from '#/horizon/backdrops/types'

export const BACKDROP_NONE = 'none'
export const BACKDROP_CUSTOM = 'custom'

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

function solid(
  id: string,
  name: BackdropDef['name'],
  color: Hex,
  intent: string[],
  bloom: number,
  t: Partial<Record<ThemeName, Tuning>>,
): BackdropDef {
  return def({
    id,
    name,
    collection: 'solids',
    version: 1,
    intent,
    stripes: [color, color],
    angleDeg: 180,
    bloom,
    tuning: t,
  })
}

/** The 29 registry entries, in the picker's order. */
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
  solid(
    'solids.slate',
    msg({message: 'Slate', context: 'backdrop name'}),
    '#1F2937',
    ['neutral', 'calm', 'solid'],
    0.1,
    tuning([0.85, 1.02], [0.85, 1.0], [0.85, 0.95]),
  ),
  solid(
    'solids.mist',
    msg({message: 'Mist', context: 'backdrop name'}),
    '#E9EEF5',
    ['neutral', 'airy', 'solid'],
    0.08,
    tuning([0.75, 1.03], [0.74, 1.0], [0.72, 0.93]),
  ),
  solid(
    'solids.red',
    msg({message: 'Red', context: 'backdrop name'}),
    '#B4534B',
    ['warm', 'solid'],
    0.1,
    tuning([0.92, 1.02], [0.9, 0.99], [0.88, 0.92]),
  ),
  solid(
    'solids.orange',
    msg({message: 'Orange', context: 'backdrop name'}),
    '#C26A3B',
    ['warm', 'solid'],
    0.1,
    tuning([0.92, 1.02], [0.9, 0.99], [0.88, 0.92]),
  ),
  solid(
    'solids.yellow',
    msg({message: 'Yellow', context: 'backdrop name'}),
    '#B79B2A',
    ['warm', 'solid'],
    0.12,
    tuning([0.86, 1.02], [0.84, 0.99], [0.82, 0.92]),
  ),
  solid(
    'solids.green',
    msg({message: 'Green', context: 'backdrop name'}),
    '#2F7D5C',
    ['cool', 'solid'],
    0.1,
    tuning([0.92, 1.01], [0.9, 0.98], [0.88, 0.9]),
  ),
  solid(
    'solids.blue',
    msg({message: 'Blue', context: 'backdrop name'}),
    '#2F5F9E',
    ['cool', 'solid'],
    0.1,
    tuning([0.92, 1.01], [0.9, 0.98], [0.88, 0.9]),
  ),
  solid(
    'solids.indigo',
    msg({message: 'Indigo', context: 'backdrop name'}),
    '#3A3F8F',
    ['cool', 'solid'],
    0.1,
    tuning([0.9, 1.01], [0.88, 0.98], [0.86, 0.9]),
  ),
  solid(
    'solids.violet',
    msg({message: 'Violet', context: 'backdrop name'}),
    '#6B4A8E',
    ['cool', 'solid'],
    0.1,
    tuning([0.9, 1.01], [0.88, 0.98], [0.86, 0.9]),
  ),
]

/** The Custom entry's name. The picker's chip says "Custom". */
export const CUSTOM_NAME = msg({
  message: 'Custom Color',
  context: 'backdrop name',
})

const BY_ID = new Map(BACKDROP_DEFS.map(entry => [entry.id, entry]))

/** A registry entry by id; `undefined` for `custom` and unknown ids. */
export function registryDef(id: string): BackdropDef | undefined {
  return BY_ID.get(id)
}

/**
 * The Custom entry for a configuration: 1.0's inputs, one stripe per colour
 * (two of the same colour when solid).
 */
export function customDef(config: CustomConfig): BackdropDef {
  return {
    id: BACKDROP_CUSTOM,
    name: CUSTOM_NAME,
    collection: 'custom',
    version: 1,
    intent: ['custom', config.mode],
    stripes:
      config.mode === 'solid' ? [config.a, config.a] : [config.a, config.b],
    stripe: {angleDeg: 180, edgeEpsilon: EDGE_EPSILON, softenEdges: true},
    bloomOpacity: 0.1,
    lockColors: false,
  }
}

/**
 * The def an appearance draws: null for `none` and for ids this build does
 * not know (kept in the appearance, drawn as none).
 */
export function resolveBackdrop(appearance: Appearance): BackdropDef | null {
  if (appearance.backdrop === BACKDROP_NONE) return null
  if (appearance.backdrop === BACKDROP_CUSTOM) {
    return customDef(appearance.custom)
  }
  return BY_ID.get(appearance.backdrop) ?? null
}
