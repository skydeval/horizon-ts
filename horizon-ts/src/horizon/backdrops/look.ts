/** The two ways the registry can be drawn (Phase 3 design, 4.3). */
export type BackdropLook = 'seen' | 'spec'

/**
 * Which layers the registry draws. 'seen' reproduces what 1.0 drew and
 * skydeval approved; 'spec' draws 1.0's spec as written (angles, hard
 * stripe edges, the bloom, per-theme tuning). Not a user setting.
 */
export const BACKDROP_LOOK: BackdropLook = 'seen'
