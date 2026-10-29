/*
 * What a bar's items read to draw the app's halo (`BarHalo.tsx`), kept apart
 * from the scope so every icon (`components/icons/nano.tsx`) can read it
 * without pulling in the backdrop and dialog modules. On web nothing
 * provides it, so it is always null there.
 */

import {createContext, useContext} from 'react'
import {PixelRatio} from 'react-native'

import {type BarHaloColors} from '#/horizon/backdrops/frame'

/** A bare window's halo, as its items read it. */
export type BarHalo = BarHaloColors & {
  /**
   * A thin solid outline in the theme's tint instead of a soft glow (the
   * drawer, whose white text a glow could not part from a flag's white
   * band, skydeval 2026-10-29). `text` is then empty: items keep their own
   * colours.
   */
  outline?: boolean
}

export const BarHaloContext = createContext<BarHalo | null>(null)

/** The halo of the bare window this is inside, or null. */
export function useBarHalo(): BarHalo | null {
  return useContext(BarHaloContext)
}

/*
 * An outline in the app is drawn as copies (`Outlined.tsx`): text inside a
 * copy takes this colour, with a slight blur of the same colour, nested text
 * included.
 */
export const OutlineCopyContext = createContext<string | null>(null)

/** The colour text takes inside an outline copy, or null. */
export function useOutlineCopyColor(): string | null {
  return useContext(OutlineCopyContext)
}

/**
 * The blur of an outline copy's text, in the pixels Android's text shadow
 * takes (not points): a point and a half.
 */
export const OUTLINE_COPY_BLUR = 1.5 * PixelRatio.get()

/** The style text takes inside an outline copy of `color`. */
export function outlineCopyTextStyle(color: string) {
  return {
    color,
    textShadowColor: color,
    textShadowOffset: {width: 0, height: 0},
    textShadowRadius: OUTLINE_COPY_BLUR,
  }
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

/** Where an icon's outline copies sit round it: a point out every way. */
export const ICON_OUTLINE_OFFSETS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

/** The offsets of an icon's copies for `halo`. */
export function iconHaloOffsets(halo: BarHalo) {
  return halo.outline ? ICON_OUTLINE_OFFSETS : ICON_HALO_OFFSETS
}

/** A text outline's shadow radius: small, so the solid shadow reads as an edge. */
export const OUTLINE_RADIUS = 2

/**
 * A text's halo: one soft shadow, as web's three stacked ones; for an
 * outline, a small solid one. An empty `text` (a scope that keeps colours)
 * never recolours.
 */
export function haloTextStyle(halo: BarHalo, recolour: boolean) {
  return {
    textShadowColor: halo.halo,
    textShadowOffset: {width: 0, height: 0},
    textShadowRadius: halo.outline ? OUTLINE_RADIUS : 4,
    ...(recolour && halo.text ? {color: halo.text} : {}),
  }
}
