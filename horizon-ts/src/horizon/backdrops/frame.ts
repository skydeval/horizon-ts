/*
 * The compact frame (Phase 3 design, section 9; live fix batch 1): when a
 * window is drawn and how, the glass it lays over the backdrop, the bare
 * windows' shades, and the two value hooks that let the Home header's inner
 * pieces show its window (BD-13, BD-14). Pure and shared; the painters are
 * `BackdropWindow.web.tsx` (web) and `BackdropWindow.tsx` (native).
 */

import {type Theme} from '#/alf'
import {themes} from '#/alf/themes'
import {IS_WEB} from '#/env'
import {
  compileBackdrop,
  type Frame,
  hexToRgb,
  type RGB,
} from '#/horizon/backdrops/compile'
import {type FrameStyle} from '#/horizon/backdrops/frame-style'
import {
  backdropKey,
  composite,
  contrast,
  FULL_RANGE,
  GLASS,
  glassFor,
  type GradientRange,
  luminance,
  MAX_GLASS_ALPHA,
  prefersReducedTransparency,
  REDUCED_TRANSPARENCY_ALPHA,
  rgba,
  sampledColors,
} from '#/horizon/backdrops/glass'
import {BACKDROP_LOOK} from '#/horizon/backdrops/look'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'
import {BACKDROPS, COMPACT_FRAME_WINDOWS} from '#/horizon/switches'

export {type FrameStyle} from '#/horizon/backdrops/frame-style'

/** The frame pieces that can become windows (9.3). */
export type WindowKind = 'homeHeader' | 'header' | 'bottomBar' | 'drawer'

/**
 * How a window is drawn: `full` covers the piece under the glass; `bare`
 * covers it with no glass at all, the piece's buttons, title and tabs each
 * on a small shade (`BarShade`; Bars, batch A, and Header's top bars,
 * round 2 list); `edge` is the slim band of the Edges frame, along the
 * header's bottom edge or the bottom bar's top edge, with no glass (nothing
 * is written on it).
 */
export type WindowMode = 'full' | 'bare' | 'edge'

/**
 * Where a window sits inside its piece, absolutely positioned.
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
  bars: {homeHeader: 'bare', header: 'bare', bottomBar: 'bare', drawer: 'full'},
  edges: {
    homeHeader: 'edge',
    header: 'edge',
    bottomBar: 'edge',
    drawer: 'full',
  },
  gutter: {drawer: 'full'},
  // Bare like Bars since the round 2 list; the bottom bar stays stock.
  headerBand: {homeHeader: 'bare', header: 'bare', drawer: 'full'},
}
/*
 * In the app the drawer is bare with every style, its text and icons
 * outlined (`Outlined`): its glass, at the alpha that kept grey text at
 * 4.5:1 over the whole backdrop, all but hid the colours in dim and dark.
 * Web keeps its glass (skydeval, 2026-10-29: web was already right).
 */

/**
 * How a window is drawn, or null when it is not (9.3): a backdrop is
 * active, the frame style draws this piece, the piece is not inside a
 * dialog and is enabled, and on web a sticky header only below 800px (at
 * 800 and up it is part of the opaque column). On native every screen's
 * header is a window too: it sits above its scroller, so the native painter
 * fills it as it does the Home header (Android app, 2026-10-29). A `bare`
 * window is bare on both: web halos its items with CSS, the app with
 * `BarHalo` (skydeval: as close to web as possible).
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
  if (mode && kind === 'header' && web && gtMobile) return null
  if (mode && kind === 'drawer' && !web) return 'bare'
  return mode
}

/** Whether a window is drawn at all (`windowMode` is not null). */
export function windowActive(args: Parameters<typeof windowMode>[0]): boolean {
  return windowMode(args) !== null
}

/**
 * A window's overlays, top first: for a full window the theme's glass tint
 * at the adaptive alpha (7.3, with the reduced-transparency floor); none
 * for the Edges band, which carries no text, and none for a bare window,
 * whose items carry their own shades.
 */
export function windowOverlays(
  def: BackdropDef,
  theme: ThemeName,
  mode: WindowMode = 'full',
  reduced: boolean = prefersReducedTransparency(),
): string[] {
  return mode === 'full' ? [glassFor(def, theme, reduced).color] : []
}

/*
 * Bar shades (the Bars frame, batch A; the Header frame's top bars since
 * the round 2 list). A bare window shows the backdrop with no glass, edge
 * to edge, as Gutter's margins do; each thing written on it (a bottom tab,
 * a header button, the title, a Home feed tab, the logo) gets a small soft
 * oblong of the theme's tint under it instead, at the smallest alpha that
 * gives the item's own colour 3:1 over the backdrop.
 *
 * The window sets each kind's colour as a CSS custom property on its piece
 * (`barShadeVars`), and a shade paints `var(...)`: a shade inherits a
 * colour only inside a bare window, so the same header row elsewhere (a
 * non-sticky header, a header in the opaque column, a dialog) draws
 * nothing, with no React state to keep in step.
 */

/** What a shade sits under. */
export type ShadeKind =
  'tab' | 'button' | 'title' | 'subtitle' | 'label' | 'logo' | 'brand'

/** Every shade kind. */
export const SHADE_KINDS: readonly ShadeKind[] = [
  'tab',
  'button',
  'title',
  'subtitle',
  'label',
  'logo',
  'brand',
]

/** WCAG 1.4.11's 3:1, as skydeval asked for the bar items. */
export const SHADE_TARGET = 3

/**
 * A shade's box inside its positioned parent (pixels; negative insets reach
 * past the parent's box) and its soft edge.
 */
export type ShadeShape = {
  top?: number
  right?: number
  bottom?: number
  left?: number | `${number}%`
  width?: number
  height?: number
  marginLeft?: number
  /** The tint fades to nothing over this many pixels at the left and right. */
  fadeX: number
  /** The same at the top and bottom. */
  fadeY: number
}

/**
 * Each kind's shade: an oblong whose solid middle covers the item and
 * whose wide soft ends reach past it. The tab one is centred on the 26px
 * tab icon (its centre 26px down: the item's `paddingTop: 13` plus half the
 * icon); the header buttons' on the 34px button, the logo's on the logo. The text kinds fill their
 * text's box, which `TEXT_SHADE_PADDING` grows by the fades without moving
 * the text; the Home feed tab's follows its label (`BarShade.web.tsx`).
 */
export const SHADE_SHAPES: Record<ShadeKind, ShadeShape> = {
  tab: {
    top: 6,
    left: '50%',
    marginLeft: -26,
    width: 52,
    height: 40,
    fadeX: 12,
    fadeY: 9,
  },
  button: {top: -3, right: -6, bottom: -3, left: -6, fadeX: 11, fadeY: 9},
  title: {top: 0, right: 0, bottom: 0, left: 0, fadeX: 12, fadeY: 6},
  subtitle: {top: 0, right: 0, bottom: 0, left: 0, fadeX: 12, fadeY: 6},
  label: {top: 0, left: 0, width: 0, height: 0, fadeX: 12, fadeY: 6},
  logo: {top: -7, right: -10, bottom: -7, left: -10, fadeX: 10, fadeY: 7},
  brand: {top: -7, right: -10, bottom: -7, left: -10, fadeX: 10, fadeY: 7},
}

/** How far a text shade reaches past its text, each side: its fades. */
export const TEXT_SHADE_PADDING = {horizontal: 12, vertical: 6}

/** The CSS custom property that carries a kind's colour. */
export function shadeVar(kind: ShadeKind): string {
  return `--horizon-shade-${kind}`
}

/**
 * The colours a kind's shade must keep readable: the bottom tab icons and
 * the title use `t.atoms.text`; the header buttons are secondary ghost
 * (`contrast_600`); the subtitle and an unselected Home feed tab use
 * `text_contrast_medium`; the logo is `primary_500`, and the signed-out
 * bar's logo group adds the logotype in `t.atoms.text`.
 */
export function shadeItemColors(theme: ThemeName, kind: ShadeKind): RGB[] {
  const t = themes[theme]
  const text = hexToRgb(t.atoms.text.color)
  const medium = hexToRgb(t.atoms.text_contrast_medium.color)
  const logo = hexToRgb(t.palette.primary_500)
  switch (kind) {
    case 'tab':
    case 'title':
      return [text]
    case 'button':
      return [hexToRgb(t.palette.contrast_600)]
    case 'subtitle':
      return [medium]
    case 'label':
      return [medium, text]
    case 'logo':
      return [logo]
    case 'brand':
      return [logo, text]
  }
}

/** The step a window's gradient range is widened to. */
const RANGE_STEP = 0.02

/** A window's box in the viewport. */
export type WindowBox = {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The part of the backdrop's first linear layer a window at `box` sees: the
 * positions along the gradient line of its four corners, widened to the
 * next `RANGE_STEP` (so a bar sliding a few pixels keeps its value) and
 * clamped to the line. A bar only ever shows its strip of the gradient,
 * which is often far from the backdrop's palest or darkest colour.
 */
export function windowRange(
  def: BackdropDef,
  theme: ThemeName,
  frame: Frame,
  box: WindowBox,
): GradientRange {
  const compiled = compileBackdrop(def, theme, frame)
  const layer = compiled?.layers.find(l => l.kind === 'linear')
  if (!layer || layer.kind !== 'linear') return FULL_RANGE
  const dx = layer.x2 - layer.x1
  const dy = layer.y2 - layer.y1
  const length = dx * dx + dy * dy
  if (length === 0) return FULL_RANGE
  const at = (x: number, y: number) =>
    ((x - layer.x1) * dx + (y - layer.y1) * dy) / length
  const right = box.left + box.width
  const bottom = box.top + box.height
  const ts = [
    at(box.left, box.top),
    at(right, box.top),
    at(box.left, bottom),
    at(right, bottom),
  ]
  const from = Math.max(
    0,
    Math.floor(Math.min(...ts) / RANGE_STEP) * RANGE_STEP,
  )
  const to = Math.min(1, Math.ceil(Math.max(...ts) / RANGE_STEP) * RANGE_STEP)
  return [Number(from.toFixed(2)), Number(to.toFixed(2))]
}

const shadeCache = new Map<string, number>()

/**
 * A shade's alpha: the smallest from 0 at which the theme's tint gives each
 * of the kind's colours 3:1 over every colour of the backdrop in `range`
 * (the window's part of it; all of it by default). Before the
 * reduced-transparency floor; memoised per def, theme, kind, range and
 * look.
 */
export function shadeAlpha(
  def: BackdropDef,
  theme: ThemeName,
  kind: ShadeKind,
  range: GradientRange = FULL_RANGE,
): number {
  const key = `${backdropKey(def)}|${theme}|${kind}|${range[0]}-${range[1]}|${BACKDROP_LOOK}`
  let alpha = shadeCache.get(key)
  if (alpha === undefined) {
    const under = sampledColors(def, theme, BACKDROP_LOOK, range)
    const tint = GLASS[theme].tint
    const items = shadeItemColors(theme, kind)
    /*
     * One search for all of the kind's colours: contrast is not monotonic
     * in the alpha (a tint can pass through an item's own lightness), so
     * the largest of each colour's own answer is not always an answer.
     */
    const top = Math.round(MAX_GLASS_ALPHA * 100)
    alpha = MAX_GLASS_ALPHA
    for (let step = 0; step <= top; step++) {
      const a = step / 100
      const ok = items.every(text =>
        under.every(
          color => contrast(composite(tint, color, a), text) >= SHADE_TARGET,
        ),
      )
      if (ok) {
        alpha = a
        break
      }
    }
    if (shadeCache.size >= 512) shadeCache.clear()
    shadeCache.set(key, alpha)
  }
  return alpha
}

/** A shade's paint: the colour it is filled with, at an alpha. */
export type ShadeFill = {color: RGB; alpha: number}

function averageColor(colors: RGB[]): RGB {
  const sum = colors.reduce(
    (acc, c) => ({r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b}),
    {r: 0, g: 0, b: 0},
  )
  return {
    r: sum.r / colors.length,
    g: sum.g / colors.length,
    b: sum.b / colors.length,
  }
}

function mix(a: RGB, b: RGB, f: number): RGB {
  return {
    r: a.r + (b.r - a.r) * f,
    g: a.g + (b.g - a.g) * f,
    b: a.b + (b.b - a.b) * f,
  }
}

/**
 * The theme's tint lightened toward white, or darkened toward black, to
 * the relative luminance `target`: the tint's own hue at another lightness.
 */
function tintAtLuminance(tint: RGB, target: number): RGB {
  const toward =
    target >= luminance(tint) ? {r: 255, g: 255, b: 255} : {r: 0, g: 0, b: 0}
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    const l = luminance(mix(tint, toward, mid))
    if (target >= luminance(tint) ? l < target : l > target) lo = mid
    else hi = mid
  }
  return mix(tint, toward, (lo + hi) / 2)
}

function clampChannel(value: number) {
  return Math.min(255, Math.max(0, Math.round(value)))
}

/**
 * The colour that, at `alpha` over `under`, gives `target`, each channel
 * clamped to what a colour can be (so the result only nears `target` when
 * the alpha is too low to reach it).
 */
function colorGiving(target: RGB, under: RGB, alpha: number): RGB {
  return {
    r: clampChannel((target.r - (1 - alpha) * under.r) / alpha),
    g: clampChannel((target.g - (1 - alpha) * under.g) / alpha),
    b: clampChannel((target.b - (1 - alpha) * under.b) / alpha),
  }
}

/**
 * How far a shade's result may stray from the theme's hue, in chroma (the
 * spread of its channels, 0 to 255).
 */
export const SHADE_HUE_TOLERANCE = 16

function chroma(c: RGB) {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
}

const shadeFillCache = new Map<string, ShadeFill>()

/*
 * A shade's colour (live check, 2026-10-20). The theme's tint laid thinly
 * over a bright backdrop takes the backdrop's hue: black over yellow came
 * out olive, a smudge rather than a shade. The shade is instead filled with
 * the colour that, over the average of the backdrop it covers, comes out
 * as the theme's own tint at the lightness the plain tint would give (a
 * neutral grey in dark, the dim surface's blue-grey in dim): over yellow,
 * a deep blue that cancels the yellow. A thin shade cannot cancel a vivid
 * colour, so the alpha rises until the result is within
 * `SHADE_HUE_TOLERANCE` of the theme's hue as well as 3:1 over every
 * sampled colour: on bright sections the chip is firmer, and clean.
 */
export function shadeFill(
  def: BackdropDef,
  theme: ThemeName,
  kind: ShadeKind,
  range: GradientRange = FULL_RANGE,
): ShadeFill {
  const tint = GLASS[theme].tint
  const base = shadeAlpha(def, theme, kind, range)
  if (base === 0) return {color: tint, alpha: 0}
  const key = `${backdropKey(def)}|${theme}|${kind}|${range[0]}-${range[1]}|${BACKDROP_LOOK}`
  let fill = shadeFillCache.get(key)
  if (!fill) {
    fill = {color: tint, alpha: base}
    const under = sampledColors(def, theme, BACKDROP_LOOK, range)
    if (under.length > 0) {
      const mean = averageColor(under)
      const items = shadeItemColors(theme, kind)
      const top = Math.round(MAX_GLASS_ALPHA * 100)
      for (let step = Math.round(base * 100); step <= top; step++) {
        const a = step / 100
        const target = tintAtLuminance(
          tint,
          luminance(composite(tint, mean, a)),
        )
        const color = colorGiving(target, mean, a)
        const neutral =
          chroma(composite(color, mean, a)) <=
          chroma(target) + SHADE_HUE_TOLERANCE
        const ok =
          (neutral || a === top / 100) &&
          items.every(text =>
            under.every(
              c => contrast(composite(color, c, a), text) >= SHADE_TARGET,
            ),
          )
        if (ok) {
          fill = {color, alpha: a}
          break
        }
      }
    }
    if (shadeFillCache.size >= 512) shadeFillCache.clear()
    shadeFillCache.set(key, fill)
  }
  return fill
}

/*
 * How a bare window's items are kept readable (live check, 2026-10-20):
 * `halo` draws a soft glow of the theme's tint hugging each glyph and icon
 * (`text-shadow`, `drop-shadow`), as map labels and captions do; `box`
 * draws the oblong under each item. The boxes read as grey blocks over
 * bright backdrops, so halo is the default.
 */
export const SHADE_STYLE: 'halo' | 'box' = 'halo'

/** The CSS custom property that carries a kind's halo colour. */
export function haloVar(kind: ShadeKind): string {
  return `--horizon-halo-${kind}`
}

/*
 * Halo option (b), live check 2026-10-20: the top bar's grey items (the
 * header buttons, a subtitle, the unselected Home feed tabs) needed a far
 * heavier halo than the bottom bar's white icons, and smeared. On a bare
 * window they are drawn in the theme's text colour instead
 * (`BARE_TEXT_VAR`), so every item but the logo takes the bottom bar's
 * light halo. The selected feed tab is still marked by its underline.
 */

/** The kinds drawn in the theme's text colour on a bare window. */
export const RECOLOURED_KINDS: ReadonlySet<ShadeKind> = new Set([
  'button',
  'subtitle',
  'label',
])

/** The custom property with the theme's text colour, on a bare window. */
export const BARE_TEXT_VAR = '--horizon-bare-text'

/** The attribute a bare window's piece carries while it is bare. */
export const BARE_ATTRIBUTE = 'data-horizon-bare'

/**
 * The colour a kind's halo is computed for: the logo keeps its own (blue);
 * every other kind is the text colour, as drawn on a bare window.
 */
function haloKind(kind: ShadeKind): ShadeKind {
  return kind === 'logo' || kind === 'brand' ? kind : 'tab'
}

/**
 * A halo's alpha from its box shade's: none where the backdrop needs no
 * shade, and denser than the box, since it only covers the glyph's edge.
 */
export function haloAlpha(boxAlpha: number): number {
  if (boxAlpha === 0) return 0
  return Math.min(0.95, 0.35 + boxAlpha)
}

/** A bare window's halo, for the app (`BarHalo.tsx`). */
export type BarHaloColors = {
  /** The halo's colour, as web's `haloVar` for every kind but the logo. */
  halo: string
  /** The same halo's colour for one of the copies an icon's halo is drawn
   * with: a few overlap at each edge, so each is fainter. */
  iconCopy: string
  /** The theme's text colour, which the grey items take on a bare window. */
  text: string
}

/** How many of an icon's halo copies overlap at its edge, roughly. */
const ICON_HALO_OVERLAP = 4

const barHaloCache = new Map<string, BarHaloColors>()

/**
 * The app's halo colours for a bare window over `range` of the backdrop:
 * web's (`barShadeVars`), as one colour and its per-copy share.
 */
export function barHaloColors(
  def: BackdropDef,
  theme: ThemeName,
  range: GradientRange = FULL_RANGE,
): BarHaloColors {
  const key = `${backdropKey(def)}|${theme}|${range[0]}-${range[1]}|${BACKDROP_LOOK}`
  let colors = barHaloCache.get(key)
  if (!colors) {
    const tint = GLASS[theme].tint
    const alpha = haloAlpha(shadeAlpha(def, theme, haloKind('tab'), range))
    colors = {
      halo: rgba(tint, alpha),
      iconCopy: rgba(tint, 1 - Math.pow(1 - alpha, 1 / ICON_HALO_OVERLAP)),
      text: themes[theme].atoms.text.color,
    }
    if (barHaloCache.size >= 512) barHaloCache.clear()
    barHaloCache.set(key, colors)
  }
  return colors
}

/*
 * The outline is a soft border, not a highlight (skydeval, 2026-10-29: "more
 * like a faded shadow than a bold line"): each of the app's eight copies is
 * faint and blurred, so where several overlap at a letter's edge they build
 * a shadow that fades outward. App only: web's drawer keeps its glass.
 */

/** The alpha of each of the app's outline copies (icons). */
export const OUTLINE_COPY_ALPHA = 0.25

/** The alpha of the soft shadow under the drawer's text in the app. */
export const OUTLINE_SHADOW_ALPHA = 0.9

/** An outline's colour: the theme's glass tint at `alpha`. */
export function outlineColor(theme: ThemeName, alpha = 1): string {
  return rgba(GLASS[theme].tint, alpha)
}

const barOutlines = new Map<ThemeName, BarHaloColors & {outline: true}>()

/**
 * The app's outline for a bare window (the drawer): the theme's tint, faint,
 * for each text and icon copy; no recolouring (`text` empty).
 */
export function barOutline(theme: ThemeName): BarHaloColors & {outline: true} {
  let outline = barOutlines.get(theme)
  if (!outline) {
    const color = outlineColor(theme, OUTLINE_COPY_ALPHA)
    outline = {halo: color, iconCopy: color, text: '', outline: true}
    barOutlines.set(theme, outline)
  }
  return outline
}

const shadeVarsCache = new Map<string, Record<string, string>>()

/**
 * The custom properties a bare window sets on its piece: each kind's tint
 * at its alpha over the window's `range` of the backdrop (0.85 at least
 * where the browser asks for reduced transparency). One object per def,
 * theme, range and reduced flag, so a window rewrites them only when one
 * changes.
 */
export function barShadeVars(
  def: BackdropDef,
  theme: ThemeName,
  range: GradientRange = FULL_RANGE,
  reduced: boolean = prefersReducedTransparency(),
): Record<string, string> {
  const key = `${backdropKey(def)}|${theme}|${range[0]}-${range[1]}|${reduced ? 1 : 0}|${BACKDROP_LOOK}`
  let vars = shadeVarsCache.get(key)
  if (!vars) {
    const tint = GLASS[theme].tint
    vars = {}
    vars[BARE_TEXT_VAR] = themes[theme].atoms.text.color
    for (const kind of SHADE_KINDS) {
      vars[haloVar(kind)] = rgba(
        tint,
        haloAlpha(shadeAlpha(def, theme, haloKind(kind), range)),
      )
      if (reduced) {
        // Near-opaque: the plain tint, which the backdrop barely shows through.
        const alpha = shadeAlpha(def, theme, kind, range)
        vars[shadeVar(kind)] = rgba(
          tint,
          Math.max(alpha, REDUCED_TRANSPARENCY_ALPHA),
        )
      } else {
        const fill = shadeFill(def, theme, kind, range)
        vars[shadeVar(kind)] = rgba(fill.color, fill.alpha)
      }
    }
    if (shadeVarsCache.size >= 512) shadeVarsCache.clear()
    shadeVarsCache.set(key, vars)
  }
  return vars
}

/** The shade kinds of the bottom bar, bare only with Bars. */
const BOTTOM_BAR_SHADES: ReadonlySet<ShadeKind> = new Set(['tab', 'brand'])

/**
 * Whether a shade is rendered at all: web, a backdrop, the compact frame
 * on, a frame whose bars are bare (Bars; Header for the top bars' kinds
 * only, its bottom bar being stock), not inside a dialog, and below 800px
 * except for the signed-out bottom bar's logo group (that bar is a window
 * up to 1300px). Where it renders outside a bare window it inherits no
 * colour and draws nothing (a non-sticky header, say).
 */
export function barShadesOn({
  def,
  frameStyle,
  kind,
  gtMobile,
  isWithinDialog,
  web = IS_WEB,
}: {
  def: BackdropDef | null
  frameStyle: FrameStyle
  kind: ShadeKind
  gtMobile: boolean
  isWithinDialog: boolean
  web?: boolean
}): boolean {
  return (
    web &&
    compactFrameOn() &&
    def !== null &&
    (frameStyle === 'bars' ||
      (frameStyle === 'headerBand' && !BOTTOM_BAR_SHADES.has(kind))) &&
    !isWithinDialog &&
    (kind === 'brand' || !gtMobile)
  )
}

/*
 * The fixed layer below 800px (performance fix 7c). There the reading
 * surface is opaque and covers the viewport, and every window paints its
 * own backdrop, so the full-screen layer is never seen; only Gutter's
 * margins show it. Not drawing it saves a full-screen layer composited
 * under a transparent scroller on every frame.
 */

/** Whether the fixed backdrop layer is drawn. */
export function fixedLayerDrawn({
  frameStyle,
  gtMobile,
}: {
  frameStyle: FrameStyle
  gtMobile: boolean
}): boolean {
  if (gtMobile || !compactFrameOn()) return true
  return frameStyle === 'gutter'
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
