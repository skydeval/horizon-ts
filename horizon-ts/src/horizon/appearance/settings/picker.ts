/*
 * The Backdrops picker's sections (change list 2): the registry grouped by
 * collection, None first on its own, then Flags, Materials, Nature, Skies
 * and Color blobs, each under a small heading, in registry order inside.
 * The Custom chip follows the sections.
 */

import {BACKDROP_DEFS} from '#/horizon/backdrops/registry'
import {
  type BackdropCollection,
  type BackdropDef,
} from '#/horizon/backdrops/types'

/** A collection the picker shows as a section. */
export type PickerCollection = Exclude<BackdropCollection, 'custom'>

/** The sections' order. */
export const PICKER_ORDER: readonly PickerCollection[] = [
  'system',
  'pride',
  'materials',
  'nature',
  'skies',
  'blobs',
]

export type PickerSection = {
  collection: PickerCollection
  defs: BackdropDef[]
}

/** The non-empty sections, in `PICKER_ORDER`. */
export const PICKER_SECTIONS: readonly PickerSection[] = PICKER_ORDER.map(
  collection => ({
    collection,
    defs: BACKDROP_DEFS.filter(def => def.collection === collection),
  }),
).filter(section => section.defs.length > 0)
