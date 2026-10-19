/*
 * The backdrop data model (Phase 3 design, section 3.2). 1.0's data and
 * types, ported; the rendering is Horizon's own (`compile.ts`).
 */

import {type MessageDescriptor} from '@lingui/core'

/** A theme name as ALF has it (`t.name`). */
export type ThemeName = 'light' | 'dim' | 'dark'

/** `#RRGGBB`, uppercase. */
export type Hex = string

export type BackdropCollection =
  'system' | 'pride' | 'materials' | 'solids' | 'custom'

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
}
