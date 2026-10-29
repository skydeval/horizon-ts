import {describe, expect, it} from '@jest/globals'

import {
  haloTextStyle,
  ICON_HALO_OFFSETS,
  ICON_OUTLINE_OFFSETS,
  iconHaloOffsets,
  OUTLINE_RADIUS,
} from '#/horizon/backdrops/bar-halo-context'
import {
  barHaloColors,
  barOutline,
  barShadeVars,
  haloVar,
} from '#/horizon/backdrops/frame'
import {registryDef} from '#/horizon/backdrops/registry'

/*
 * The app's halo on a bare window (BarHalo.tsx) takes web's colour. It sits
 * only round the bar's items, in place of the glass the app used to lay over
 * the whole bar (skydeval: "dark as hell", 2026-10-29).
 */

function alphaOf(rgba: string): number {
  const match = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(rgba)
  return match ? Number(match[1]) : NaN
}

describe("the app's bar halo", () => {
  const trans = registryDef('pride.trans')!

  it("is web's halo colour, for every theme", () => {
    for (const theme of ['light', 'dim', 'dark'] as const) {
      const web = barShadeVars(trans, theme, [0, 0.1], false)
      expect(barHaloColors(trans, theme, [0, 0.1]).halo).toBe(
        web[haloVar('tab')],
      )
    }
  })

  it("splits the halo's alpha across its overlapping icon copies", () => {
    const colors = barHaloColors(trans, 'dark')
    const whole = alphaOf(colors.halo)
    const copy = alphaOf(colors.iconCopy)
    expect(copy).toBeLessThan(whole)
    // Four copies overlapping give back about the halo's own alpha
    expect(1 - Math.pow(1 - copy, 4)).toBeCloseTo(whole, 2)
  })

  it('the drawer’s outline: faint copies in the theme’s tint, colours kept', () => {
    const outline = barOutline('dark')
    expect(outline.halo).toBe('rgba(0, 0, 0, 0.25)')
    expect(barOutline('light').halo).toBe('rgba(255, 255, 255, 0.25)')
    const style = haloTextStyle(outline, true)
    expect(style.textShadowColor).toBe(outline.halo)
    expect(style.textShadowRadius).toBe(OUTLINE_RADIUS)
    expect('color' in style).toBe(false)
    // Icon copies match, a point out every way
    expect(outline.iconCopy).toBe(outline.halo)
    expect(iconHaloOffsets(outline)).toEqual(ICON_OUTLINE_OFFSETS)
    expect(iconHaloOffsets(barHaloColors(trans, 'dark'))).toEqual(
      ICON_HALO_OFFSETS,
    )
  })

  it("recolours to the theme's text colour", () => {
    expect(barHaloColors(trans, 'dark').text).not.toBe(
      barHaloColors(trans, 'light').text,
    )
  })
})
