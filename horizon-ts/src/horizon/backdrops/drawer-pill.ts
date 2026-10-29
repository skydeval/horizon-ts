/*
 * The drawer's pills (skydeval, 2026-10-29): the drawer is a bare window,
 * the backdrop in full colour, and each of its rows (the profile card, each
 * menu item, the links, the Help button) sits on a rounded pill of the
 * theme's glass. The pill is the glass the whole drawer used to wear, at the
 * same alpha (7.3: the theme's grey text at 4.5:1 over the backdrop's worst
 * colour), so every row reads as it did, and the colour shows between and
 * around them. A halo was tried first and could not part white text from a
 * flag's white band.
 */

import {type ViewStyle} from 'react-native'

import {useBreakpoints, useTheme} from '#/alf'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {windowMode} from '#/horizon/backdrops/frame'
import {glassFor} from '#/horizon/backdrops/glass'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

/** A pill's corner radius. */
export const DRAWER_PILL_RADIUS = 14

/** A pill's colour: the theme's glass for the backdrop. */
export function drawerPillColor(def: BackdropDef, theme: ThemeName): string {
  return glassFor(def, theme).color
}

/**
 * The pill a drawer row sits on while the drawer is a bare window, else
 * null (no backdrop: the stock drawer).
 */
export function useDrawerPill(): ViewStyle | null {
  const t = useTheme()
  const def = useActiveBackdrop()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  const mode = windowMode({
    def,
    frameStyle: device.frameStyle,
    kind: 'drawer',
    gtMobile,
    isWithinDialog: false,
  })
  if (!def || mode !== 'bare') return null
  return {
    backgroundColor: drawerPillColor(def, t.name),
    borderRadius: DRAWER_PILL_RADIUS,
  }
}
