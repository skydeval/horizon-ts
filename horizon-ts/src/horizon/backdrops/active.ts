/*
 * Whether a backdrop is active (Phase 3 design, 3.5): the shown appearance
 * resolves to a def and the `BACKDROPS` switch is on. Everything Phase 3
 * draws is gated on this. The def carries the device's softness for the
 * current theme (live fix batch 1) and its grain setting (change list 2,
 * item 6), so every painter and the glass rule see the same treated
 * colours. "Time of day" resolves to the sky of the local hour, followed
 * only while it is selected (`hour.ts`); "Follow the season" to the
 * seasonal backdrop of the local month and the device's hemisphere,
 * followed only while it is selected (`season.ts`, change list 3).
 */

import {useTheme} from '#/alf'
import {
  useAppearanceState,
  useEffectiveAppearance,
} from '#/horizon/appearance/store'
import {compileKey} from '#/horizon/backdrops/compile'
import {useHour} from '#/horizon/backdrops/hour'
import {
  BACKDROP_SEASON_AUTO,
  BACKDROP_SKIES_AUTO,
  resolveBackdrop,
} from '#/horizon/backdrops/registry'
import {useMonth} from '#/horizon/backdrops/season'
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
  const hour = useHour(BACKDROPS && appearance.backdrop === BACKDROP_SKIES_AUTO)
  const month = useMonth(
    BACKDROPS && appearance.backdrop === BACKDROP_SEASON_AUTO,
  )
  if (!BACKDROPS) return null
  const def = resolveBackdrop(appearance, hour, {
    month,
    southern: device.southern,
  })
  if (!def) return null
  const soften = softnessAmount(device.softness, t.name)
  const treated: BackdropDef = {...def}
  if (soften > 0) treated.soften = soften
  if (device.grain) treated.grain = true
  return stableDef(soften > 0 || device.grain ? treated : def)
}
