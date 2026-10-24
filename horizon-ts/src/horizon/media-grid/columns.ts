/*
 * The Media tab grid's columns for the stock `PostFeed`, which counts its
 * video grid's columns with a hook (`useVideoGridColumns`).
 */

import {useBreakpoints} from '#/alf'
import {isMediaGridFeed, mediaGridColumns} from './grid'

/**
 * Tiles to a row for `feed`: the Media tab grid's 3 or 4, or the stock
 * video grid's `stock` for any other feed.
 */
export function useMediaGridColumns(feed: string, stock: number): number {
  const {gtMobile} = useBreakpoints()
  return isMediaGridFeed(feed) ? mediaGridColumns(gtMobile) : stock
}
