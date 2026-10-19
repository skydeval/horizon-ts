/*
 * The compact frame (Phase 3 design, section 9): when a window or a lens is
 * drawn, the glass it lays over the backdrop, and the two value hooks that
 * let the Home header's inner pieces show its window (BD-13, BD-14). Pure
 * and shared; the painters are `BackdropWindow.web.tsx` (web) and
 * `BackdropWindow.tsx` (native).
 */

import {type Theme} from '#/alf'
import {themes} from '#/alf/themes'
import {IS_WEB} from '#/env'
import {hexToRgb, type RGB} from '#/horizon/backdrops/compile'
import {
  colorsUnderGlass,
  GLASS,
  glassFor,
  prefersReducedTransparency,
  REDUCED_TRANSPARENCY_ALPHA,
  rgba,
  smallestAlpha,
  veilOverlays,
} from '#/horizon/backdrops/glass'
import {BACKDROP_LOOK} from '#/horizon/backdrops/look'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'
import {BACKDROPS, COMPACT_FRAME_WINDOWS} from '#/horizon/switches'

/** The frame pieces that become windows with the "Bars" phone frame (9.3). */
export type WindowKind = 'homeHeader' | 'header' | 'bottomBar' | 'drawer'

/** The buttons that become lenses with the "Buttons" phone frame (9.7). */
export type LensKind = 'tab' | 'headerButton' | 'fab'

export type FrameStyle = 'bars' | 'buttons'

/**
 * Where a window or a lens sits inside its piece, absolutely positioned.
 * Plain numbers (pixels) and one percentage, so both painters can use it.
 */
export type WindowShape = {
  top: number
  left: number | `${number}%`
  right?: number
  bottom?: number
  width?: number
  height?: number
  marginLeft?: number
  borderRadius?: number
  /** A top hairline the window draws over the piece's own top border. */
  topBorder?: {width: number; color: string}
}

/** The piece's whole padding box. */
export const FILL_SHAPE: WindowShape = {top: 0, right: 0, bottom: 0, left: 0}

/** Large enough for any button to read as a circle. */
export const ROUND_RADIUS = 999

/**
 * The bottom tab lens (9.7): a 56 x 34 pill, radius 17, centred, its centre
 * on the icon's (the item's `paddingTop: 13` plus half a 26px icon).
 */
export const TAB_LENS_SHAPE: WindowShape = {
  top: 9,
  left: '50%',
  marginLeft: -28,
  width: 56,
  height: 34,
  borderRadius: 17,
}

/**
 * The bottom bar's window (9.3, BD-16): over the bar's top border, drawing
 * its own hairline unless the screen hides the border.
 */
export function bottomBarShape({
  hairline,
  hideBorder,
  borderColor,
}: {
  hairline: number
  hideBorder: boolean
  borderColor: string
}): WindowShape {
  return {
    top: -hairline,
    right: 0,
    bottom: 0,
    left: 0,
    ...(hideBorder ? {} : {topBorder: {width: hairline, color: borderColor}}),
  }
}

/** The compact frame is on at all (both switches). */
export function compactFrameOn(): boolean {
  return BACKDROPS && COMPACT_FRAME_WINDOWS
}

/**
 * Whether a window is drawn (9.3): a backdrop is active, the frame is
 * "Bars", the piece is not inside a dialog and is enabled, and a sticky
 * header only below 800px (at 800 and up it is part of the opaque column).
 * The header window is web only: `Layout.Header.Outer` is sticky only on
 * web (9.8).
 */
export function windowActive({
  def,
  frameStyle,
  kind,
  gtMobile,
  isWithinDialog,
  enabled = true,
  web = IS_WEB,
}: {
  def: BackdropDef | null
  frameStyle: FrameStyle
  kind: WindowKind
  gtMobile: boolean
  isWithinDialog: boolean
  enabled?: boolean
  web?: boolean
}): boolean {
  if (!compactFrameOn() || def === null) return false
  if (frameStyle !== 'bars' || isWithinDialog || !enabled) return false
  if (kind === 'header') return web && !gtMobile
  return true
}

/**
 * Whether a lens is drawn (9.7): a backdrop is active, the frame is
 * "Buttons", the button is not inside a dialog, and a header button only
 * below 800px.
 */
export function lensActive({
  def,
  frameStyle,
  kind,
  gtMobile,
  isWithinDialog,
}: {
  def: BackdropDef | null
  frameStyle: FrameStyle
  kind: LensKind
  gtMobile: boolean
  isWithinDialog: boolean
}): boolean {
  if (!compactFrameOn() || def === null) return false
  if (frameStyle !== 'buttons' || isWithinDialog) return false
  if (kind === 'headerButton') return !gtMobile
  return true
}

/**
 * A window's overlays, top first: the theme's glass tint at the adaptive
 * alpha (7.3, with the reduced-transparency floor), then the dark veil.
 */
export function windowOverlays(
  def: BackdropDef,
  theme: ThemeName,
  reduced: boolean = prefersReducedTransparency(),
): string[] {
  return [glassFor(def, theme, reduced).color, ...veilOverlays(theme)]
}

/** The lowest alpha a lens goes to. */
export const LENS_MIN_ALPHA = 0.2

/** WCAG 1.4.11 for icons. */
export const LENS_TARGET = 3

const WHITE: RGB = {r: 255, g: 255, b: 255}
const BLACK: RGB = {r: 0, g: 0, b: 0}

function textColor(theme: ThemeName): RGB {
  return hexToRgb(themes[theme].atoms.text.color)
}

const lensCache = new Map<string, number>()

/**
 * A lens's tint and alpha (9.7): the theme's glass tint at the smallest
 * alpha from 0.20 that gives `t.atoms.text` 3:1 over the backdrop; for the
 * compose button black, giving its white icon 3:1. Before the
 * reduced-transparency floor; memoised per def, theme, kind and look.
 */
export function lensGlass(
  def: BackdropDef,
  theme: ThemeName,
  kind: LensKind,
): {tint: RGB; alpha: number} {
  const fab = kind === 'fab'
  const tint = fab ? BLACK : GLASS[theme].tint
  const key = `${def.id}|${def.stripes.join(',')}|${theme}|${fab}|${BACKDROP_LOOK}`
  let alpha = lensCache.get(key)
  if (alpha === undefined) {
    alpha = smallestAlpha({
      under: colorsUnderGlass(def, theme),
      tint,
      text: fab ? WHITE : textColor(theme),
      target: LENS_TARGET,
      min: LENS_MIN_ALPHA,
    })
    // Custom previews add a key per slider position; keep the cache small.
    if (lensCache.size >= 512) lensCache.clear()
    lensCache.set(key, alpha)
  }
  return {tint, alpha}
}

/** A lens's overlays, top first: its tint, then the dark veil. */
export function lensOverlays(
  def: BackdropDef,
  theme: ThemeName,
  kind: LensKind,
  reduced: boolean = prefersReducedTransparency(),
): string[] {
  const {tint, alpha} = lensGlass(def, theme, kind)
  const shown = reduced ? Math.max(alpha, REDUCED_TRANSPARENCY_ALPHA) : alpha
  return [rgba(tint, shown), ...veilOverlays(theme)]
}

/**
 * BD-13: the Home header's inner row is not sticky while the compact frame
 * is on, so its opaque background does not cover the wrapper's window.
 * Inside the fixed wrapper, sticky has no other effect.
 */
export function horizonInnerHeaderSticky(): boolean {
  return !compactFrameOn()
}

const TRANSPARENT = {backgroundColor: 'transparent'} as const

/**
 * BD-14: the web tab bar's background. Transparent for the Home header's
 * tab bar (the only caller passing `transparent`) while the compact frame
 * is on; both of its parents paint `t.atoms.bg`, so without a window it
 * looks stock.
 */
export function horizonTabBarBg(t: Theme, transparent: boolean | undefined) {
  return transparent && compactFrameOn() ? TRANSPARENT : t.atoms.bg
}
