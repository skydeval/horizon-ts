/*
 * Who may turn Bluesky's moderation labeler off (skydeval, 2026-10-29):
 * adults can; minors keep it. Pure, so the rule is tested on its own.
 */

/** Why the switch is locked on, or null when the account may change it. */
export type BskyModerationLock = 'underAge' | 'noAge' | 'ageCheck' | null

export function bskyModerationLock({
  age,
  declaredAdult,
  ageCheckLocks,
}: {
  /** The account's age from its saved birthdate, if Horizon can read it. */
  age: number | undefined
  /** The account's declared-age preference says 18 or over. */
  declaredAdult: boolean
  /** The app's age check is keeping adult content off. */
  ageCheckLocks: boolean
}): BskyModerationLock {
  if (ageCheckLocks) return 'ageCheck'
  if (age !== undefined) return age >= 18 ? null : 'underAge'
  return declaredAdult ? null : 'noAge'
}
