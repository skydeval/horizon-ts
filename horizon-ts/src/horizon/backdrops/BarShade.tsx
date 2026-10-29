/*
 * Bar shades in the app. Web draws a CSS halo per item (`BarShade.web.tsx`);
 * the app's halo comes from the bar's `BarHaloScope` instead
 * (`BarHalo.tsx`): text takes a text shadow here, icons draw their own
 * (`components/icons/nano.tsx`). So `BarShade` and `BarSlot` draw nothing
 * themselves.
 */

import {type StyleProp, type TextStyle} from 'react-native'

import {haloTextStyle, useBarHalo} from '#/horizon/backdrops/bar-halo-context'
import {RECOLOURED_KINDS, type ShadeKind} from '#/horizon/backdrops/frame'

/** Nothing in the app: the bar's halo scope does the work. */
export function BarShade(_props: {kind: ShadeKind; show?: boolean}) {
  return null
}

/** Nothing in the app: the drawer's `BarHaloScope` does the work. */
export function DrawerHalo() {
  return null
}

/** The slot's children only, in the app. */
export function BarSlot({children}: {children?: React.ReactNode}) {
  return <>{children}</>
}

/**
 * A header title's or subtitle's halo on a bare window: a soft text shadow,
 * and the subtitle in the theme's text colour, as on web.
 */
export function useBarTextShade(
  kind: 'title' | 'subtitle',
  _style?: StyleProp<TextStyle>,
): TextStyle | undefined {
  const halo = useBarHalo()
  if (!halo) return undefined
  return haloTextStyle(halo, RECOLOURED_KINDS.has(kind))
}
