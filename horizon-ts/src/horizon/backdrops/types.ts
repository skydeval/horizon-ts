/*
 * The backdrop data model (Phase 3 design, section 3.2). 1.0's data and
 * types, ported; the rendering is Horizon's own (`compile.ts`).
 */

import {type MessageDescriptor} from '@lingui/core'

/** A theme name as ALF has it (`t.name`). */
export type ThemeName = 'light' | 'dim' | 'dark'

/** `#RRGGBB`, uppercase. */
export type Hex = string

/**
 * The registry's groups. `solids` is gone (change list 2, item 9): a stored
 * solid id reads as a custom one-tone (`registry.ts`). Change list 3 added
 * `calm`, `seasonal`, `space`, `gems` and `aesthetics`. The picker's order
 * is `PICKER_ORDER` (`appearance/settings/picker.ts`).
 */
export type BackdropCollection =
  | 'system'
  | 'pride'
  | 'materials'
  | 'calm'
  | 'nature'
  | 'seasonal'
  | 'skies'
  | 'space'
  | 'gems'
  | 'blobs'
  | 'aesthetics'
  | 'custom'

/**
 * A quiet repeating pattern over a custom one-tone (change list 2, item 7).
 */
export type PatternName = 'dots' | 'grid' | 'lines'

/**
 * Where a linear layer's gradient runs. `angle` is the CSS convention:
 * 0 points up, 90 right, 180 down, clockwise; the gradient line passes
 * through the frame's centre and its length is |W sin A| + |H cos A|.
 * `corner` runs from the frame's top-left corner (0%) to its bottom-right
 * corner (100%), whatever the frame's aspect: the line 1.0 drew.
 */
export type Direction = {kind: 'angle'; deg: number} | {kind: 'corner'}

export type Stop = {
  color: Hex
  /** 0..1 along the gradient line. */
  pos: number
  /** 0..1, default 1. */
  alpha?: number
}

export type LinearLayer = {
  kind: 'linear'
  direction: Direction
  stops: Stop[]
  /** 0..1, multiplied into every stop's alpha. */
  opacity: number
}

export type RadialLayer = {
  kind: 'radial'
  /** Centre, fractions of the frame's width and height. */
  cx: number
  cy: number
  /** Radius, a fraction of max(W, H). A circle. */
  r: number
  stops: Stop[]
  opacity: number
}

/**
 * One tile of a quiet pattern (change list 2, item 7), repeated over the
 * frame from its origin: `dots` a dot at each tile's centre, `hlines` and
 * `vlines` a 1px line along each tile's top or left edge (a grid is both),
 * `diagonal` 1px lines at 45 degrees. The colour is chosen by the compiler
 * against the backdrop's base so the contrast stays low.
 */
export type PatternLayer = {
  kind: 'pattern'
  shape: 'dots' | 'hlines' | 'vlines' | 'diagonal'
  /** The tile's side, in pixels. */
  size: number
}

/**
 * Film grain (change list 2, item 6): a small static noise tile, made once
 * per page and repeated. Always the top layer.
 */
export type GrainLayer = {kind: 'grain'}

/**
 * A starfield (change list 3, item 3): a static tile of small stars, made
 * once and repeated, between a pattern and the grain.
 */
export type StarsLayer = {kind: 'stars'}

/** A gradient layer, as a def lists them (`BackdropDef.layers`). */
export type Layer = LinearLayer | RadialLayer

/** Multipliers; missing means 1. */
export type Tuning = {
  saturation?: number
  brightness?: number
  opacity?: number
}

export type BackdropDef = {
  id: string
  name: MessageDescriptor
  collection: BackdropCollection
  version: number
  intent: string[]
  /** 1.0's stripe colours; empty for `none`. */
  stripes: Hex[]
  /** 1.0's makeStripedLinearLayer options. */
  stripe: {angleDeg: number; edgeEpsilon: number; softenEdges: boolean}
  /** 1.0's makeNeutralBloomRadialLayer opacity. */
  bloomOpacity: number
  tuning?: Partial<Record<ThemeName, Tuning>>
  /** Never tune saturation or brightness (flags stay accurate). */
  lockColors: boolean
  /**
   * The device's backdrop softness (0..1) for the theme the def is drawn
   * in; missing means 0. Only `useActiveBackdrop` sets it, so swatches and
   * registry defs keep their full colours. Applies to flags as well:
   * softness is the viewer's own treatment, not a tuning of the backdrop.
   */
  soften?: number
  /**
   * The def's own layers, bottom first (change list 2: skies and colour
   * blobs). When set they replace the striped layers in both looks; the
   * def's `stripes` are then only its representative colours, for the
   * swatch rules and keys.
   */
  layers?: Layer[]
  /** A quiet pattern over the layers (custom one-tone only). */
  pattern?: PatternName
  /**
   * Film grain over everything. Like `soften`, only `useActiveBackdrop`
   * sets it, from the device's setting.
   */
  grain?: boolean
  /** A starfield over the layers (change list 3, item 3). */
  stars?: boolean
}
