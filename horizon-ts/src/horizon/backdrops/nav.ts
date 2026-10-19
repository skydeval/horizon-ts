/*
 * The navigation hooks' values (Phase 3 design, 8.3, 8.4 and 8.6, BD-2,
 * BD-3 and BD-5). Selection-independent on purpose: they are read in plain
 * functions and in components a store read would not re-render, and without
 * a backdrop the shell root beneath them paints `t.atoms.bg`, so a
 * transparent screen looks stock.
 */

import {type Theme as NavigationTheme} from '@react-navigation/native'

import {type Theme} from '#/alf'
import {IS_WEB} from '#/env'
import {BACKDROPS} from '#/horizon/switches'

const TRANSPARENT = {backgroundColor: 'transparent'} as const

/** Every stack's `contentStyle`: transparent on web, stock on native. */
export function horizonContentStyle(t: Theme) {
  return IS_WEB && BACKDROPS ? TRANSPARENT : t.atoms.bg
}

const navThemes = new WeakMap<NavigationTheme, NavigationTheme>()

/**
 * The navigation theme with a transparent `background` on web (React
 * Navigation paints it under every screen). The same input gives the same
 * object, so the container's theme prop keeps its identity.
 */
export function horizonNavTheme(theme: NavigationTheme): NavigationTheme {
  if (!(IS_WEB && BACKDROPS)) return theme
  let out = navThemes.get(theme)
  if (!out) {
    out = {...theme, colors: {...theme.colors, background: 'transparent'}}
    navThemes.set(theme, out)
  }
  return out
}

/** An opaque `t.atoms.bg` where the area beneath is transparent (the Messages split view). */
export function horizonOpaque(t: Theme) {
  return BACKDROPS ? t.atoms.bg : undefined
}
