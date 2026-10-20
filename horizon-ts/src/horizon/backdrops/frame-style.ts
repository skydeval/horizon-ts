/*
 * The phone frame styles and their picker (Phase 3 design, 9.3, 9.6, 9.7,
 * Q2; live fix batch 1; round 2 list). `SHOW_FRAME_STYLE_PICKER` is not a
 * switch: it chooses whether Appearance shows "Phone frame". Once skydeval
 * has picked, it goes false and `DEFAULT_FRAME_STYLE` becomes the pick.
 */

/** Appearance shows the "Phone frame" picker. */
export const SHOW_FRAME_STYLE_PICKER: boolean = true

/**
 * How the frame shows the backdrop below 800px:
 * - `bars`: the headers and the bottom bar are bare windows (the backdrop
 *   with no glass, a shade under each item), the drawer a glass window;
 * - `edges`: stock bars with a slim band of backdrop along the header's
 *   bottom edge and the bottom bar's top edge;
 * - `gutter`: stock bars and the inset reading card (9.6), the backdrop in
 *   8px gutters beside it;
 * - `headerBand`: only the top headers are bare windows, as with Bars; the
 *   bottom bar stays stock.
 * The drawer is a window with every style.
 */
export type FrameStyle = 'bars' | 'edges' | 'gutter' | 'headerBand'

/** Every style, in the picker's order. */
export const FRAME_STYLES: readonly FrameStyle[] = [
  'bars',
  'edges',
  'gutter',
  'headerBand',
]

export const DEFAULT_FRAME_STYLE: FrameStyle = 'bars'

/**
 * Retired styles and what they read as: `buttons` (the button-lens
 * prototype, 9.7) was removed in the round 2 list and reads as Bars.
 */
const RETIRED_FRAME_STYLES = new Map<unknown, FrameStyle>([['buttons', 'bars']])

/**
 * A stored `frameStyle`, leniently. An unknown value reads as the default
 * and a retired one as its replacement. `legacyInsetCard` is the retired
 * `insetCard` toggle: on with Bars (or no style) it reads as Gutter, its
 * replacement; with another style, retired ones included, it is dropped,
 * the style being the explicit pick.
 */
export function parseFrameStyle(
  value: unknown,
  legacyInsetCard: unknown = false,
): FrameStyle {
  const retired = RETIRED_FRAME_STYLES.get(value)
  if (retired !== undefined) return retired
  const known = FRAME_STYLES.find(style => style === value)
  if (legacyInsetCard === true && (known === undefined || known === 'bars')) {
    return 'gutter'
  }
  return known ?? DEFAULT_FRAME_STYLE
}
