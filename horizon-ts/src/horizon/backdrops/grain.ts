/*
 * The film grain tile (change list 2, item 6). Native draws no grain: the
 * setting is offered on web only. `grain.web.ts` is the web tile.
 */

/** The tile's side, in pixels. */
export const GRAIN_TILE = 128

/** The tile as a data URL; null where there is none. */
export function grainTileUrl(): string | null {
  return null
}
