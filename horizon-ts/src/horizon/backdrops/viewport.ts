/*
 * The frame every backdrop painter uses (Phase 3 design, 9.2). Native: the
 * window. `viewport.web.ts` is the web implementation.
 */

import {useWindowDimensions} from 'react-native'

import {type Frame} from '#/horizon/backdrops/compile'

/** The backdrop's frame, in pixels. */
export function useViewportFrame(): Frame {
  const {width, height} = useWindowDimensions()
  return {width, height}
}
