/*
 * Whether a backdrop is active (Phase 3 design, 3.5): the shown appearance
 * resolves to a def and the `BACKDROPS` switch is on. Everything Phase 3
 * draws is gated on this.
 */

import {useEffectiveAppearance} from '#/horizon/appearance/store'
import {resolveBackdrop} from '#/horizon/backdrops/registry'
import {type BackdropDef} from '#/horizon/backdrops/types'
import {BACKDROPS} from '#/horizon/switches'

/** The active backdrop's def, or null when none is active. */
export function useActiveBackdrop(): BackdropDef | null {
  const appearance = useEffectiveAppearance()
  return BACKDROPS ? resolveBackdrop(appearance) : null
}
