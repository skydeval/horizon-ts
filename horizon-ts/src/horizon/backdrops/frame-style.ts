/*
 * The phone frame styles and their picker (Phase 3 design, 9.3, 9.6, 9.7,
 * Q2; live fix batch 1). `SHOW_FRAME_STYLE_PICKER` is not a switch: it
 * chooses whether Appearance shows "Phone frame". Once skydeval has picked,
 * it goes false and `DEFAULT_FRAME_STYLE` becomes the pick.
 */

/** Appearance shows the "Phone frame" picker. */
export const SHOW_FRAME_STYLE_PICKER: boolean = true

/**
 * How the frame shows the backdrop below 800px:
 * - `bars`: the headers, the bottom bar and the drawer are glass windows;
 * - `edges`: stock bars with a slim band of backdrop along the header's
 *   bottom edge and the bottom bar's top edge;
 * - `gutter`: stock bars and the inset reading card (9.6), the backdrop in
 *   8px gutters beside it;
 * - `headerBand`: only the top headers are windows, the bottom bar stays
 *   stock;
 * - `buttons`: stock bars, the frame's buttons are lenses (9.7).
 * The drawer is a window with every style but `buttons`.
 */
export type FrameStyle = 'bars' | 'edges' | 'gutter' | 'headerBand' | 'buttons'

/** Every style, in the picker's order. */
export const FRAME_STYLES: readonly FrameStyle[] = [
  'bars',
  'edges',
  'gutter',
  'headerBand',
  'buttons',
]

export const DEFAULT_FRAME_STYLE: FrameStyle = 'bars'

/**
 * A stored `frameStyle`, leniently. An unknown value reads as the default.
 * `legacyInsetCard` is the retired `insetCard` toggle: on with Bars (or no
 * style) it reads as Gutter, its replacement; with another style it is
 * dropped, the style being the explicit pick.
 */
export function parseFrameStyle(
  value: unknown,
  legacyInsetCard: unknown = false,
): FrameStyle {
  const known = FRAME_STYLES.find(style => style === value)
  if (legacyInsetCard === true && (known === undefined || known === 'bars')) {
    return 'gutter'
  }
  return known ?? DEFAULT_FRAME_STYLE
}
