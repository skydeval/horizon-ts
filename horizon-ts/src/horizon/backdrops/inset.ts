/*
 * The optional inset reading card (Phase 3 design, 9.6, 3E): below 800px the
 * reading surface becomes a card 8px in from each side, the fixed backdrop
 * showing in the gutters, and the outermost `Layout.Center` pads its content
 * to match (BD-18). Behind the constant below, then the per-device
 * `insetCard` setting (default off, Q3). Web only: native has no backdrop
 * layer behind its screens (7.6).
 */

import {useBreakpoints} from '#/alf'
import {IS_WEB} from '#/env'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {type BackdropDef} from '#/horizon/backdrops/types'
import {BACKDROPS} from '#/horizon/switches'

/**
 * Appearance shows "Reading card on small screens" and the card can be on.
 * Not a switch: off until skydeval has looked at the compact frame (Q3).
 */
export const INSET_READING_CARD_AVAILABLE: boolean = false

/** The gutter between the card and the viewport's sides, in pixels. */
export const INSET_GUTTER = 8

/** The card's corner radius. */
export const INSET_RADIUS = 16

/** Whether the inset card is drawn, from its inputs. */
export function insetReadingCardOn({
  def,
  insetCard,
  gtMobile,
  available = INSET_READING_CARD_AVAILABLE,
  web = IS_WEB,
}: {
  def: BackdropDef | null
  insetCard: boolean
  gtMobile: boolean
  available?: boolean
  web?: boolean
}): boolean {
  return available && BACKDROPS && web && def !== null && insetCard && !gtMobile
}

/** Whether the inset card is drawn now. */
export function useInsetReadingCard(): boolean {
  const def = useActiveBackdrop()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  return insetReadingCardOn({def, insetCard: device.insetCard, gtMobile})
}

/**
 * The outermost `Layout.Center`'s padding while the inset card is drawn,
 * else `undefined` (BD-18).
 */
export function useInsetReadingGutter():
  {paddingLeft: number; paddingRight: number} | undefined {
  return useInsetReadingCard()
    ? {paddingLeft: INSET_GUTTER, paddingRight: INSET_GUTTER}
    : undefined
}
