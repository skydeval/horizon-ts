/*
 * The translucent cards of the desktop and tablet frame (Phase 3 design,
 * 7.4, BD-6 to BD-10): each right-rail section, the left nav and the
 * collapsed tablet nav. Inactive, the stock tree exactly.
 */

import {type StyleProp, View, type ViewStyle} from 'react-native'

import {useBreakpoints, useTheme, web} from '#/alf'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {GLASS_BLUR, glassFor} from '#/horizon/backdrops/glass'
import {type BackdropDef, type ThemeName} from '#/horizon/backdrops/types'

export type RailCardVariant = 'rail' | 'nav' | 'navMinimal'

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

/**
 * A card's style for a def and a theme, and whether it is blurred (at
 * >= 800px, unless the browser asks for reduced transparency).
 */
export function railCardStyle(
  variant: RailCardVariant,
  def: BackdropDef,
  theme: ThemeName,
  {
    borderColor,
    gtMobile,
    reduced,
  }: {borderColor: string; gtMobile: boolean; reduced?: boolean},
): {style: ViewStyle; blur: boolean} {
  const glass = glassFor(def, theme, reduced)
  return {
    style: {
      ...SHAPES[variant],
      borderRadius: 16,
      borderWidth: 1,
      borderColor,
      backgroundColor: glass.color,
    },
    blur: gtMobile && glass.blur,
  }
}

const BLUR = `blur(${GLASS_BLUR}px)`

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
  const {gtMobile} = useBreakpoints()
  if (!def) {
    return style === undefined ? (
      <>{children}</>
    ) : (
      <View style={style}>{children}</View>
    )
  }
  const card = railCardStyle(variant, def, t.name, {
    borderColor: t.atoms.border_contrast_low.borderColor,
    gtMobile,
  })
  return (
    <View
      style={[
        style,
        card.style,
        card.blur
          ? web({backdropFilter: BLUR, WebkitBackdropFilter: BLUR})
          : null,
      ]}>
      {children}
    </View>
  )
}
