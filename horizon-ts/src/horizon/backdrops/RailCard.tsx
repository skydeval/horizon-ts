/*
 * The frosted cards of the desktop and tablet frame (Phase 3 design, 7.4,
 * BD-6 to BD-10): each right-rail section, the left nav and the collapsed
 * tablet nav. Inactive, the stock tree exactly.
 *
 * Performance fix 7a: no live `backdrop-filter`. The cards sat over a
 * full-width transparent scroller, so the blur was recomputed on every
 * scroll frame, for a look that over a smooth gradient is nearly the
 * same unblurred. Each card now paints the backdrop into itself, offset to
 * where it sits (`BackdropWindow`, read on mount, resize and layout
 * changes, never on page scroll), under the theme's glass tint.
 */

import {type StyleProp, StyleSheet, View, type ViewStyle} from 'react-native'

import {useTheme} from '#/alf'
import {IS_WEB} from '#/env'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {BackdropWindow} from '#/horizon/backdrops/BackdropWindow'
import {type WindowShape} from '#/horizon/backdrops/frame'
import {glassFor} from '#/horizon/backdrops/glass'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

export type RailCardVariant = 'rail' | 'nav' | 'navMinimal'

/** The card's corner radius. */
export const RAIL_CARD_RADIUS = 16

/** The card's border width. */
const BORDER = 1

/*
 * Change list 2, item 10: a card grows outward around its content instead
 * of pushing it in. Each side's edge sits `RAIL_CARD_OUTSET` outside the
 * stock box (a negative margin), and the padding is whatever puts the
 * content exactly where the stock box puts it: the stock padding and border
 * plus the outset, less the card's own border. So turning a backdrop on or
 * off never moves the rail's or the nav's content. In the right rail the
 * stock gap between sections is 16px, so the cards' vertical outset is
 * small (5px, leaving 6px between cards); the rail grows on its right by
 * `RAIL_CARD_ROOM` so the cards' right edges are not clipped. The nav's
 * values are its former padding (8 or 12 beside, 12 above and below, plus
 * the border), now as outsets. RN-web boxes are border-box, so a border
 * sits inside the box's width.
 */

/** How far a card's edges sit outside the stock box, beside and above/below. */
export const RAIL_CARD_OUTSET: Record<RailCardVariant, {x: number; y: number}> =
  {
    rail: {x: 10, y: 5},
    nav: {x: 9, y: 13},
    navMinimal: {x: 13, y: 13},
  }

/** The width the right rail adds on its right while cards are drawn. */
export const RAIL_CARD_ROOM = RAIL_CARD_OUTSET.rail.x

type Side = 'Top' | 'Right' | 'Bottom' | 'Left'

const SIDES: Side[] = ['Top', 'Right', 'Bottom', 'Left']

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** A flattened style's value for one side: longhand, then axis, then all. */
function sideValue(
  flat: Record<string, unknown>,
  prop: 'padding' | 'margin',
  side: Side,
): number {
  const axis = side === 'Top' || side === 'Bottom' ? 'Vertical' : 'Horizontal'
  return (
    num(flat[`${prop}${side}`]) ??
    num(flat[`${prop}${axis}`]) ??
    num(flat[prop]) ??
    0
  )
}

function borderValue(flat: Record<string, unknown>, side: Side): number {
  return num(flat[`border${side}Width`]) ?? num(flat.borderWidth) ?? 0
}

/**
 * Where a stock box puts its content, from each outer edge: its padding
 * plus its border, per side.
 */
export function stockInset(style: StyleProp<ViewStyle>): Record<Side, number> {
  const flat: Record<string, unknown> = {...StyleSheet.flatten(style)}
  const out = {} as Record<Side, number>
  for (const side of SIDES) {
    out[side] = sideValue(flat, 'padding', side) + borderValue(flat, side)
  }
  return out
}

/**
 * The card's margins and padding (longhands only, so they override a stock
 * `padding*` predictably) for a variant over a stock style.
 */
export function cardShape(
  variant: RailCardVariant,
  style?: StyleProp<ViewStyle>,
): ViewStyle {
  const flat: Record<string, unknown> = {...StyleSheet.flatten(style)}
  const inset = stockInset(style)
  const {x, y} = RAIL_CARD_OUTSET[variant]
  const out: Record<string, number> = {}
  for (const side of SIDES) {
    const outset = side === 'Top' || side === 'Bottom' ? y : x
    out[`margin${side}`] = sideValue(flat, 'margin', side) - outset
    out[`padding${side}`] = inset[side] + outset - BORDER
  }
  return out
}

/*
 * A stock style's keys a card drops (rail fix). Stock's feeds list is
 * `flex: 1; overflow-y: auto` so that, when the fixed rail outgrows the
 * viewport, the list shrinks and scrolls inside itself. On a card that made
 * the card its own scroller: with the cards' padding the rail outgrew a
 * 1080p viewport with about 17 feeds, so the card was capped mid-item and
 * grew both scrollbars, and its painter scrolled away with the list. A card
 * sizes to its content; the rail scrolls as a whole instead
 * (`RAIL_SCROLL_STYLE`).
 */
const SIZING_KEYS = [
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'height',
  'maxHeight',
  'overflow',
  'overflowX',
  'overflowY',
] as const

/** `style` without the keys that let a card size to anything but its content. */
export function cardStockStyle(style: StyleProp<ViewStyle>): ViewStyle {
  // `overflowX` and `overflowY` are web keys, outside `ViewStyle`.
  const flat: Record<string, unknown> = {...StyleSheet.flatten(style)}
  for (const key of SIZING_KEYS) delete flat[key]
  return flat
}

/**
 * The desktop rail's own scroll, while cards are drawn: the cards keep
 * their full height, so a rail taller than the viewport scrolls as a whole
 * (wheel, trackpad, keyboard). It draws no scrollbar: a classic one took
 * 10px off every card's width the moment the rail overflowed, and stock's
 * right rail shows none. Its painters are static windows inside it, so the
 * tracker re-reads them only when the rail itself scrolls.
 */
export const RAIL_SCROLL_STYLE = {
  overflowX: 'hidden',
  overflowY: 'auto',
  scrollbarWidth: 'none',
} as unknown as ViewStyle

/** The painted backdrop fills the card inside its border. */
export const RAIL_CARD_PAINT_SHAPE: WindowShape = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  borderRadius: RAIL_CARD_RADIUS - BORDER,
}

/**
 * A card's style and glass for a def and a theme. The glass is the card's
 * background too, so the card reads the same before its paint lands.
 */
export function railCardStyle(
  variant: RailCardVariant,
  def: BackdropDef,
  theme: ThemeName,
  {
    borderColor,
    reduced,
    stock,
  }: {
    borderColor: string
    reduced?: boolean
    /** The stock style of the view the card replaces, if any. */
    stock?: StyleProp<ViewStyle>
  },
): {style: ViewStyle; glass: string} {
  const glass = glassFor(def, theme, reduced)
  return {
    style: {
      ...cardShape(variant, stock),
      borderRadius: RAIL_CARD_RADIUS,
      borderWidth: BORDER,
      borderColor,
      backgroundColor: glass.color,
    },
    glass: glass.color,
  }
}

/**
 * A frame card. `style` is the stock style of a view the card replaces, if
 * any: inactive, the card renders that view (or a fragment with no `style`).
 */
export function RailCard({
  children,
  style,
  variant = 'rail',
}: {
  children: React.ReactNode
  /** The stock style of a view the card replaces, if any. */
  style?: StyleProp<ViewStyle>
  variant?: RailCardVariant
}) {
  const t = useTheme()
  const def = useActiveBackdrop()
  if (!def) {
    return style === undefined ? (
      <>{children}</>
    ) : (
      <View style={style}>{children}</View>
    )
  }
  const card = railCardStyle(variant, def, t.name, {
    borderColor: t.atoms.border_contrast_low.borderColor,
    stock: style,
  })
  return (
    <View style={[cardStockStyle(style), card.style]}>
      {IS_WEB && (
        <BackdropWindow
          def={def}
          overlays={[card.glass]}
          shape={RAIL_CARD_PAINT_SHAPE}
          isStatic
        />
      )}
      {children}
    </View>
  )
}
