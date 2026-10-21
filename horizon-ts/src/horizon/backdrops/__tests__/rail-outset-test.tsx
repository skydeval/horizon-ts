import {type ViewStyle} from 'react-native'
import {describe, expect, it, jest} from '@jest/globals'

import type * as ThemesModule from '#/alf/themes'
import {
  cardShape,
  NAV_TOP_ALIGN,
  RAIL_CARD_OUTSET,
  RAIL_CARD_ROOM,
  railCardStyle,
  type RailCardVariant,
  stockInset,
} from '#/horizon/backdrops/RailCard'
import {registryDef} from '#/horizon/backdrops/registry'

jest.mock('#/alf', () => ({
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
  web: (value: unknown) => value,
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
}))
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => undefined,
  writeDeviceJson: () => {},
  subscribeDeviceJson: () => () => {},
}))

/*
 * Change list 2, item 10: switching a backdrop on or off must not move the
 * rails' content. Jest has no layout engine, so this checks the box
 * arithmetic RN-web lays out (border-box, so a border is inside a box's
 * size): with the card on, the content's offset from where the stock box
 * starts is margin + border + padding on every side, and it must equal the
 * stock box's own padding + border.
 */

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const

/* Each card as the shell renders it: the stock style it replaces. */
const CARDS: {name: string; variant: RailCardVariant; stock?: ViewStyle}[] = [
  {name: 'the left nav', variant: 'nav'},
  {name: 'the tablet nav', variant: 'navMinimal'},
  {name: 'the search box', variant: 'rail'},
  // `Feeds.tsx`: a.flex_1 and web({gap: 2, paddingTop: 2, overflowY}).
  {name: 'the feeds card', variant: 'rail', stock: {flex: 1, paddingTop: 2}},
  {name: 'the feeds loading card', variant: 'rail', stock: {gap: 10}},
  // `SidebarTrendingTopics.tsx`: a.p_lg, a.rounded_md, a.border.
  {
    name: 'the trending card',
    variant: 'rail',
    stock: {padding: 16, borderRadius: 8, borderWidth: 1},
  },
]

function num(style: ViewStyle, key: string) {
  const value = (style as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : 0
}

describe('rail cards grow outward (change list 2, item 10)', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const card of CARDS) {
      it(`${card.name} keeps its content in place (${theme})`, () => {
        const def = registryDef('pride.trans')!
        const {style} = railCardStyle(card.variant, def, theme, {
          borderColor: '#000000',
          stock: card.stock,
        })
        const stock = stockInset(card.stock)
        for (const side of SIDES) {
          const content =
            num(style, `margin${side}`) +
            num(style, 'borderWidth') +
            num(style, `padding${side}`)
          expect(content).toBe(stock[side])
          // And the card's edge is outside the stock box, never inside.
          expect(num(style, `margin${side}`)).toBeLessThan(0)
        }
      })
    }
  }

  it('the nav keeps its former look: 8 or 12 beside, 12 above and below', () => {
    expect(cardShape('nav')).toMatchObject({
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 12,
      paddingBottom: 12,
      marginLeft: -9,
      marginTop: -13,
    })
    expect(cardShape('navMinimal')).toMatchObject({
      paddingLeft: 12,
      paddingTop: 12,
      marginLeft: -13,
    })
  })

  it('the right rail cards do not overlap in its 16px gaps', () => {
    const gap = 16
    const {y} = RAIL_CARD_OUTSET.rail
    const between = gap - 2 * y
    expect(between).toBeGreaterThanOrEqual(6)
    // The feeds card's own 2px top padding is still inside the card.
    expect(cardShape('rail', {paddingTop: 2}).paddingTop).toBe(6)
  })

  it('the rail has room for the outset edges', () => {
    // The rail's own padding: 20 above, 32 to the left (gutters), 2 to the
    // right plus the room the rail adds while cards are drawn.
    const {x, y} = RAIL_CARD_OUTSET.rail
    expect(y).toBeLessThanOrEqual(20)
    expect(x).toBeLessThanOrEqual(32)
    expect(RAIL_CARD_ROOM).toBeGreaterThanOrEqual(x)
    // The left nav's container has 16px padding on every side.
    expect(RAIL_CARD_OUTSET.nav.y).toBeLessThanOrEqual(16)
    expect(RAIL_CARD_OUTSET.nav.x).toBeLessThanOrEqual(16)
    // The tablet nav's card fits its 80px column: 48 + 2 x 13 = 74.
    expect(48 + 2 * RAIL_CARD_OUTSET.navMinimal.x).toBeLessThanOrEqual(80)
  })

  it('the footer keeps 16px padding, its edges in line with the rail cards', () => {
    const footer = cardShape('footer')
    const rail = cardShape('rail')
    for (const side of SIDES) {
      expect(footer[`padding${side}`]).toBe(16)
      expect(footer[`margin${side}`]).toBe(rail[`margin${side}`])
    }
  })

  it('the left nav card lines up with the right rail first card', () => {
    // Rail: content 20px down, card 5px above it. Nav: content 16px down
    // plus NAV_TOP_ALIGN, card 13px above it.
    const railCardTop = 20 - RAIL_CARD_OUTSET.rail.y
    const navCardTop = 16 + NAV_TOP_ALIGN - RAIL_CARD_OUTSET.nav.y
    expect(navCardTop).toBe(railCardTop)
    expect(NAV_TOP_ALIGN).toBe(12)
  })

  it('reads shorthand and longhand stock padding and borders', () => {
    expect(
      stockInset({paddingVertical: 3, paddingLeft: 5, borderWidth: 2}),
    ).toEqual({Top: 5, Right: 2, Bottom: 5, Left: 7})
    expect(stockInset(undefined)).toEqual({
      Top: 0,
      Right: 0,
      Bottom: 0,
      Left: 0,
    })
  })
})
