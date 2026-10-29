import {describe, expect, it, jest} from '@jest/globals'

import {drawerPillColor} from '#/horizon/backdrops/drawer-pill'

// The hook's inputs, not used here (they reach the session and reanimated)
jest.mock('#/alf', () => ({}))
jest.mock('#/horizon/appearance/store', () => ({}))
jest.mock('#/horizon/backdrops/active', () => ({}))
import {
  colorsUnderGlass,
  composite,
  contrast,
  GLASS,
  glassFor,
} from '#/horizon/backdrops/glass'
import {registryDef} from '#/horizon/backdrops/registry'

/*
 * The drawer's rows sit on pills of the glass the whole drawer used to wear,
 * so each row reads as it did (skydeval, 2026-10-29).
 */

describe("the drawer's pills", () => {
  const trans = registryDef('pride.trans')!

  it('are the theme glass for the backdrop', () => {
    for (const theme of ['light', 'dim', 'dark'] as const) {
      expect(drawerPillColor(trans, theme)).toBe(
        glassFor(trans, theme, false).color,
      )
    }
  })

  it("keep the grey text at 4.5:1 over the flag's every colour, white band included", () => {
    for (const theme of ['light', 'dim', 'dark'] as const) {
      const {alpha} = glassFor(trans, theme, false)
      for (const under of colorsUnderGlass(trans, theme)) {
        const pill = composite(GLASS[theme].tint, under, alpha)
        expect(contrast(pill, GLASS[theme].text)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
