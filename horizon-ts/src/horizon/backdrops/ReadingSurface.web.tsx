/*
 * The opaque reading surface (Phase 3 design, 7.5, BD-4): rendered first in
 * `Layout.Screen`, behind the stock centre borders and the screen. At
 * >= 800px it is the 602px column with `WebCenterBorders`' geometry; below,
 * the whole viewport, or the inset card (9.6, 3E) when that is on. Exactly
 * `t.atoms.bg`, so stock sticky headers and the
 * folder tabs join it. Only the focused screen's surface shows (the web stack
 * hides the others).
 *
 * The inset card's rounded corners keep the compositor from treating it as
 * opaque, so the full-screen backdrop layer under it and the card itself
 * were both drawn on every scroll frame (Gutter, performance round 2). A
 * plain rectangle of the same colour inside the card, clear of the
 * corners, is its own opaque fixed layer: everything under it is culled.
 * It is invisible, being the card's colour within the card.
 */

import {View} from 'react-native'

import {useIsWithinSplitView} from '#/screens/Messages/components/splitView/context'
import {
  atoms as a,
  useBreakpoints,
  useLayoutBreakpoints,
  useTheme,
  web,
} from '#/alf'
import {CENTER_COLUMN_OFFSET} from '#/components/Layout/const'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {
  INSET_GUTTER,
  INSET_RADIUS,
  useInsetReadingCard,
} from '#/horizon/backdrops/inset'

/** The surface behind the reading column, or nothing without a backdrop. */
export function ReadingSurface() {
  const t = useTheme()
  const def = useActiveBackdrop()
  const inset = useInsetReadingCard()
  const {isWithinSplitView} = useIsWithinSplitView()
  const {gtMobile} = useBreakpoints()
  const {centerColumnOffset} = useLayoutBreakpoints()
  if (!def || isWithinSplitView) return null
  if (!gtMobile) {
    // The inset card (9.6): the backdrop shows in the 8px gutters.
    const card = (
      <View
        pointerEvents="none"
        style={[
          a.fixed,
          inset
            ? {
                top: 0,
                bottom: 0,
                left: INSET_GUTTER,
                right: INSET_GUTTER,
                borderRadius: INSET_RADIUS,
              }
            : a.inset_0,
          t.atoms.bg,
        ]}
      />
    )
    if (!inset) return card
    return (
      <>
        {card}
        <View
          pointerEvents="none"
          style={[
            a.fixed,
            {
              top: INSET_RADIUS,
              bottom: INSET_RADIUS,
              left: INSET_GUTTER,
              right: INSET_GUTTER,
            },
            t.atoms.bg,
          ]}
        />
      </>
    )
  }
  return (
    <View
      pointerEvents="none"
      style={[
        a.fixed,
        {top: 0, bottom: 0},
        t.atoms.bg,
        web({
          width: 602,
          left: '50%',
          transform: [
            {translateX: '-50%'},
            {translateX: centerColumnOffset ? CENTER_COLUMN_OFFSET : 0},
            ...a.scrollbar_offset.transform,
          ],
        }),
      ]}
    />
  )
}
