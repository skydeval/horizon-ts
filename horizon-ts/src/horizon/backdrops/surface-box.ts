/*
 * The reading surface's horizontal box (Phase 3 design, 7.5, BD-4), for the
 * surface itself and for any stock background that must stay on it.
 *
 * Stock's Notifications header (v2) is a fixed bar from the window's left
 * edge to its right one, with the title's `t.atoms.bg` and the pills' fade
 * drawn across all of it: over a solid page that is invisible, over a
 * backdrop it was an opaque band about 100px tall across the top of the
 * window, over the left nav card and fading into the right rail (header
 * fix). Its backgrounds take this box instead, so they cover only the
 * reading surface they join.
 */

import {type ViewStyle} from 'react-native'

import {useIsWithinSplitView} from '#/screens/Messages/components/splitView/context'
import {atoms as a, useBreakpoints, useLayoutBreakpoints, web} from '#/alf'
import {CENTER_COLUMN_OFFSET} from '#/components/Layout/const'
import {IS_WEB} from '#/env'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {
  INSET_GUTTER,
  INSET_RADIUS,
  useInsetReadingCard,
} from '#/horizon/backdrops/inset'

/** The centre column with its borders, as `WebCenterBorders` draws it. */
export const READING_COLUMN_WIDTH = 602

/**
 * The surface's box across a full-width parent: at >= 800px the centre
 * column, below it the inset card when that is on, else `null` (the whole
 * width, as stock).
 */
export function readingColumnBox({
  gtMobile,
  inset,
  centerColumnOffset,
}: {
  gtMobile: boolean
  inset: boolean
  centerColumnOffset: boolean
}): ViewStyle | null {
  if (gtMobile) {
    return web({
      left: '50%',
      right: 'auto',
      width: READING_COLUMN_WIDTH,
      transform: [
        {translateX: '-50%'},
        {translateX: centerColumnOffset ? CENTER_COLUMN_OFFSET : 0},
        ...a.scrollbar_offset.transform,
      ],
    }) as ViewStyle
  }
  if (inset) {
    return {
      left: INSET_GUTTER,
      right: INSET_GUTTER,
      borderTopLeftRadius: INSET_RADIUS,
      borderTopRightRadius: INSET_RADIUS,
    }
  }
  return null
}

/**
 * The box a full-width stock background takes while a backdrop is drawn on
 * web, else `null` (stock unchanged).
 */
export function useReadingColumnBox(): ViewStyle | null {
  const def = useActiveBackdrop()
  const inset = useInsetReadingCard()
  const {isWithinSplitView} = useIsWithinSplitView()
  const {gtMobile} = useBreakpoints()
  const {centerColumnOffset} = useLayoutBreakpoints()
  if (!IS_WEB || !def || isWithinSplitView) return null
  return readingColumnBox({gtMobile, inset, centerColumnOffset})
}
