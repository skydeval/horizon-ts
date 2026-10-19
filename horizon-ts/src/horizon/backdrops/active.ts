/*
 * Whether a backdrop is active (Phase 3 design, 3.5): the shown appearance
 * resolves to a def and the `BACKDROPS` switch is on. Everything Phase 3
 * draws is gated on this. The def carries the device's softness for the
 * current theme (live fix batch 1), so every painter and the glass rule
 * see the same treated colours.
 */

import {useTheme} from '#/alf'
import {
  useAppearanceState,
  useEffectiveAppearance,
} from '#/horizon/appearance/store'
import {resolveBackdrop} from '#/horizon/backdrops/registry'
import {softnessAmount} from '#/horizon/backdrops/softness'
import {type BackdropDef} from '#/horizon/backdrops/types'
import {BACKDROPS} from '#/horizon/switches'

/** The active backdrop's def, or null when none is active. */
export function useActiveBackdrop(): BackdropDef | null {
  const t = useTheme()
  const appearance = useEffectiveAppearance()
  const {device} = useAppearanceState()
  if (!BACKDROPS) return null
  const def = resolveBackdrop(appearance)
  if (!def) return null
  const soften = softnessAmount(device.softness, t.name)
  return soften > 0 ? {...def, soften} : def
}
