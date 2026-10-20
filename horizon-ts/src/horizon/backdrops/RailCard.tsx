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
 * Longhands only, so a stock `padding*` on `style` is overridden predictably.
 * RN-web boxes are border-box: the nav card's 1px border sits inside its
 * width, so its content keeps the stock width (7.4).
 */
const SHAPES: Record<RailCardVariant, ViewStyle> = {
  rail: {
    paddingTop: 16,
    paddingRight: 16,
    paddingBottom: 16,
    paddingLeft: 16,
  },
  nav: {
    marginLeft: -9,
    marginRight: -9,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 12,
    paddingBottom: 12,
  },
  navMinimal: {
    marginLeft: -13,
    marginRight: -13,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 12,
    paddingBottom: 12,
  },
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
  {borderColor, reduced}: {borderColor: string; reduced?: boolean},
): {style: ViewStyle; glass: string} {
  const glass = glassFor(def, theme, reduced)
  return {
    style: {
      ...SHAPES[variant],
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
