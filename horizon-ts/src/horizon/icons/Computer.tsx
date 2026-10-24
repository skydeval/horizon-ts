import {createSinglePathSVG} from '#/components/icons/TEMPLATE'

/**
 * A desktop monitor on a stand, drawn to match the stock set's
 * Stroke2/Corner2 icons (a 2 px outline with rounded corners on a 24 grid).
 * The stock set has no computer icon; this one has no font glyph, so it
 * renders as an SVG path.
 */
export const Computer_Stroke2_Corner2_Rounded = createSinglePathSVG({
  path: 'M5 3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H5Zm6 12h2v2h-2v-2Zm-3 2h8a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2Z',
  viewBox: '0 0 24 24',
})
