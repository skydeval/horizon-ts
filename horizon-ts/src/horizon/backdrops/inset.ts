/*
 * The inset reading card (Phase 3 design, 9.6, 3E): below 800px the reading
 * surface becomes a card 8px in from each side, the fixed backdrop showing
 * in the gutters, and the outermost `Layout.Center` pads its content to
 * match (BD-18). Since live fix batch 1 it is the "Gutter" phone frame
 * style, chosen in the "Phone frame" picker; the separate toggle and its
 * `INSET_READING_CARD_AVAILABLE` constant are gone (a stored `insetCard`
 * reads as Gutter, `parseFrameStyle`). Web only: native has no backdrop
 * layer behind its screens (7.6).
 */

import {useBreakpoints} from '#/alf'
import {IS_WEB} from '#/env'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {compactFrameOn} from '#/horizon/backdrops/frame'
import {type FrameStyle} from '#/horizon/backdrops/frame-style'
import {type BackdropDef} from '#/horizon/backdrops/types'

/** The gutter between the card and the viewport's sides, in pixels. */
export const INSET_GUTTER = 8

/** The card's corner radius. */
export const INSET_RADIUS = 16

/** Whether the inset card is drawn, from its inputs. */
export function insetReadingCardOn({
  def,
  frameStyle,
  gtMobile,
  web = IS_WEB,
}: {
  def: BackdropDef | null
  frameStyle: FrameStyle
  gtMobile: boolean
  web?: boolean
}): boolean {
  return (
    compactFrameOn() &&
    web &&
    def !== null &&
    frameStyle === 'gutter' &&
    !gtMobile
  )
}

/**
 * Whether the app draws the Sides strips (`SidesFrame.tsx`): web's inset
 * card look, the backdrop in 8px strips down each side, which the app paints
 * over its screens as it has no layer behind them (skydeval, 2026-10-29).
 */
export function sidesStripsOn({
  def,
  frameStyle,
  gtMobile,
  web = IS_WEB,
}: {
  def: BackdropDef | null
  frameStyle: FrameStyle
  gtMobile: boolean
  web?: boolean
}): boolean {
  return (
    compactFrameOn() &&
    !web &&
    def !== null &&
    frameStyle === 'gutter' &&
    !gtMobile
  )
}

/** Whether the inset card is drawn now. */
export function useInsetReadingCard(): boolean {
  const def = useActiveBackdrop()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  return insetReadingCardOn({def, frameStyle: device.frameStyle, gtMobile})
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
