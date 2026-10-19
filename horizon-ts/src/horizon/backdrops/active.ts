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
import {compileKey} from '#/horizon/backdrops/compile'
import {resolveBackdrop} from '#/horizon/backdrops/registry'
import {softnessAmount} from '#/horizon/backdrops/softness'
import {type BackdropDef} from '#/horizon/backdrops/types'
import {BACKDROPS} from '#/horizon/switches'

/*
 * One def object per compile key (performance fix 7d): the softened copy
 * and a custom def are new objects on every read, so without this every
 * render handed the painters a new def. Stable identity lets the React
 * Compiler skip work and keeps the def-keyed caches warm.
 */
const stableDefs = new Map<string, BackdropDef>()

/** The def's one shared instance for its compile key. */
export function stableDef(def: BackdropDef): BackdropDef {
  const key = compileKey(def)
  const existing = stableDefs.get(key)
  if (existing) return existing
  // Custom previews add a key per slider step; keep the map small.
  if (stableDefs.size >= 256) stableDefs.clear()
  stableDefs.set(key, def)
  return def
}

/** The active backdrop's def, or null when none is active. */
export function useActiveBackdrop(): BackdropDef | null {
  const t = useTheme()
  const appearance = useEffectiveAppearance()
  const {device} = useAppearanceState()
  if (!BACKDROPS) return null
  const def = resolveBackdrop(appearance)
  if (!def) return null
  const soften = softnessAmount(device.softness, t.name)
  return stableDef(soften > 0 ? {...def, soften} : def)
}
