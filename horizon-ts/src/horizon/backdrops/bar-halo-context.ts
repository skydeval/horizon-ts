/*
 * What a bar's items read to draw the app's halo (`BarHalo.tsx`), kept apart
 * from the scope so every icon (`components/icons/nano.tsx`) can read it
 * without pulling in the backdrop and dialog modules. On web nothing
 * provides it, so it is always null there.
 */

import {createContext, useContext} from 'react'

import {type BarHaloColors} from '#/horizon/backdrops/frame'

export const BarHaloContext = createContext<BarHaloColors | null>(null)

/** The halo of the bare window this is inside, or null. */
export function useBarHalo(): BarHaloColors | null {
  return useContext(BarHaloContext)
}

/** Where an icon's halo copies sit round it, in points. */
export const ICON_HALO_OFFSETS: readonly [number, number][] = [
  [-1.5, 0],
  [1.5, 0],
  [0, -1.5],
  [0, 1.5],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

/**
 * A text's halo: one soft shadow, as web's three stacked ones. An empty
 * `text` (a scope that keeps colours) never recolours.
 */
export function haloTextStyle(halo: BarHaloColors, recolour: boolean) {
  return {
    textShadowColor: halo.halo,
    textShadowOffset: {width: 0, height: 0},
    textShadowRadius: 4,
    ...(recolour && halo.text ? {color: halo.text} : {}),
  }
}
