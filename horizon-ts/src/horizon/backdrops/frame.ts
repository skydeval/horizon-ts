/*
 * The compact frame (Phase 3 design, section 9; live fix batch 1): when a
 * window or a lens is drawn and how, the glass it lays over the backdrop,
 * and the two value hooks that let the Home header's inner pieces show its
 * window (BD-13, BD-14). Pure and shared; the painters are
 * `BackdropWindow.web.tsx` (web) and `BackdropWindow.tsx` (native).
 */

import {type Theme} from '#/alf'
import {themes} from '#/alf/themes'
import {IS_WEB} from '#/env'
import {hexToRgb, type RGB} from '#/horizon/backdrops/compile'
import {type DiscOverlay, type Overlay} from '#/horizon/backdrops/css'
import {type FrameStyle} from '#/horizon/backdrops/frame-style'
import {
  backdropKey,
  colorsUnderGlass,
  GLASS,
  glassFor,
  MAX_GLASS_ALPHA,
  prefersReducedTransparency,
  REDUCED_TRANSPARENCY_ALPHA,
  rgba,
  smallestAlpha,
} from '#/horizon/backdrops/glass'
import {BACKDROP_LOOK} from '#/horizon/backdrops/look'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'
import {BACKDROPS, COMPACT_FRAME_WINDOWS} from '#/horizon/switches'

export {type FrameStyle} from '#/horizon/backdrops/frame-style'

/** The frame pieces that can become windows (9.3). */
export type WindowKind = 'homeHeader' | 'header' | 'bottomBar' | 'drawer'

/** The buttons that become lenses with the "Buttons" phone frame (9.7). */
export type LensKind = 'tab' | 'headerButton' | 'fab'

/**
 * How a window is drawn: `full` covers the piece under the glass; `edge` is
 * the slim band of the Edges frame, along the header's bottom edge or the
 * bottom bar's top edge, with no glass (nothing is written on it).
 */
export type WindowMode = 'full' | 'edge'

/**
 * Where a window or a lens sits inside its piece, absolutely positioned.
 * Plain numbers (pixels) and one percentage, so both painters can use it.
 */
export type WindowShape = {
  top?: number
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

/** The Edges frame's band, in pixels. */
export const EDGE_BAND = 4

/** The Edges band along a header's bottom edge (inside its bottom border). */
export const HEADER_EDGE_SHAPE: WindowShape = {
  left: 0,
  right: 0,
  bottom: 0,
  height: EDGE_BAND,
}

/**
 * The Edges band along the bottom bar's top edge. It covers the bar's top
 * border as well, so the band itself is the bar's edge.
 */
export function bottomBarEdgeShape(hairline: number): WindowShape {
  return {top: -hairline, left: 0, right: 0, height: EDGE_BAND + hairline}
}

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

/** How each frame style draws each piece; missing means stock. */
const WINDOW_MODES: Record<
  FrameStyle,
  Partial<Record<WindowKind, WindowMode>>
> = {
  bars: {homeHeader: 'full', header: 'full', bottomBar: 'full', drawer: 'full'},
  edges: {
    homeHeader: 'edge',
    header: 'edge',
    bottomBar: 'edge',
    drawer: 'full',
  },
  gutter: {drawer: 'full'},
  headerBand: {homeHeader: 'full', header: 'full', drawer: 'full'},
  buttons: {},
}

/**
 * How a window is drawn, or null when it is not (9.3): a backdrop is
 * active, the frame style draws this piece, the piece is not inside a
 * dialog and is enabled, and a sticky header only below 800px (at 800 and
 * up it is part of the opaque column). The header window is web only:
 * `Layout.Header.Outer` is sticky only on web (9.8).
 */
export function windowMode({
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
}): WindowMode | null {
  if (!compactFrameOn() || def === null) return null
  if (isWithinDialog || !enabled) return null
  const mode = WINDOW_MODES[frameStyle][kind] ?? null
  if (mode && kind === 'header' && !(web && !gtMobile)) return null
  return mode
}

/** Whether a window is drawn at all (`windowMode` is not null). */
export function windowActive(args: Parameters<typeof windowMode>[0]): boolean {
  return windowMode(args) !== null
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
 * A window's overlays, top first: for a full window the theme's glass tint
 * at the adaptive alpha (7.3, with the reduced-transparency floor); none
 * for the Edges band, which carries no text.
 */
export function windowOverlays(
  def: BackdropDef,
  theme: ThemeName,
  mode: WindowMode = 'full',
  reduced: boolean = prefersReducedTransparency(),
): Overlay[] {
  return mode === 'edge' ? [] : [glassFor(def, theme, reduced).color]
}

/*
 * Lenses (live fix batch 1). The first build laid one uniform tint over the
 * whole lens, checked against `t.atoms.text`; over pale backdrops in dark
 * that read as a flat grey pill, and the header buttons' grey icons
 * (`contrast_600`) vanished in it. Now the lens shows the backdrop
 * untinted, and only a small disc behind the icon (the backing) carries the
 * tint, at the smallest alpha that gives the icon's own colour 3:1.
 */

/** The lowest alpha a lens's backing goes to: none when not needed. */
export const LENS_MIN_ALPHA = 0

/** WCAG 1.4.11 for icons. */
export const LENS_TARGET = 3

/**
 * The backing disc of each lens, in pixels from the icon's centre: full
 * tint to `solid`, faded out by `fade`. Sized to the icon (26px tab icons,
 * 24px header icons, the compose icon) so the rest of the lens shows the
 * backdrop.
 */
export const LENS_BACKING: Record<LensKind, {solid: number; fade: number}> = {
  tab: {solid: 15, fade: 19},
  headerButton: {solid: 13, fade: 16},
  fab: {solid: 16, fade: 22},
}

const WHITE: RGB = {r: 255, g: 255, b: 255}
const BLACK: RGB = {r: 0, g: 0, b: 0}

/**
 * The colour of a lens's icon: the tab icons use `t.atoms.text`, the header
 * buttons (secondary ghost) `contrast_600`, the compose icon white.
 */
export function lensIconColor(theme: ThemeName, kind: LensKind): RGB {
  if (kind === 'fab') return WHITE
  const t = themes[theme]
  return hexToRgb(kind === 'tab' ? t.atoms.text.color : t.palette.contrast_600)
}

const lensCache = new Map<string, number>()

/**
 * A lens backing's tint and alpha: the theme's glass tint (black for the
 * compose button) at the smallest alpha from 0 that gives the icon's colour
 * 3:1 over the backdrop. Before the reduced-transparency floor; memoised per
 * def, theme, kind and look.
 */
export function lensGlass(
  def: BackdropDef,
  theme: ThemeName,
  kind: LensKind,
): {tint: RGB; alpha: number} {
  const tint = kind === 'fab' ? BLACK : GLASS[theme].tint
  const key = `${backdropKey(def)}|${theme}|${kind}|${BACKDROP_LOOK}`
  let alpha = lensCache.get(key)
  if (alpha === undefined) {
    alpha = smallestAlpha({
      under: colorsUnderGlass(def, theme),
      tint,
      text: lensIconColor(theme, kind),
      target: LENS_TARGET,
      min: LENS_MIN_ALPHA,
      max: MAX_GLASS_ALPHA,
    })
    // Custom previews add a key per slider position; keep the cache small.
    if (lensCache.size >= 512) lensCache.clear()
    lensCache.set(key, alpha)
  }
  return {tint, alpha}
}

/**
 * A lens's overlays: its icon backing, or nothing when the backdrop alone
 * gives the icon 3:1 (and transparency is not reduced).
 */
export function lensOverlays(
  def: BackdropDef,
  theme: ThemeName,
  kind: LensKind,
  reduced: boolean = prefersReducedTransparency(),
): DiscOverlay[] {
  const {tint, alpha} = lensGlass(def, theme, kind)
  const shown = reduced ? Math.max(alpha, REDUCED_TRANSPARENCY_ALPHA) : alpha
  if (shown <= 0) return []
  return [
    {
      kind: 'disc',
      color: rgba(tint, shown),
      clear: rgba(tint, 0),
      ...LENS_BACKING[kind],
    },
  ]
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
