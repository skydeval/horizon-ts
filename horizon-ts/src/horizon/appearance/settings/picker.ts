/*
 * The Backdrops picker's sections (change list 2): the registry grouped by
 * collection, None first on its own, then each collection under a small
 * heading, in registry order inside. The Custom chip follows the sections.
 *
 * Change list 3's order: Flags; the quiet ones (Materials, then Calm);
 * the world outside (Nature, Seasonal, Skies, Space); then the richer
 * colour (Gems, Color blobs) and Aesthetics last, the loudest.
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
  'calm',
  'nature',
  'seasonal',
  'skies',
  'space',
  'gems',
  'blobs',
  'aesthetics',
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
