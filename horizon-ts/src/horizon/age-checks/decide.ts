import {
  type AgeCheckOutcome,
  type StoredAgeCheck,
} from '#/horizon/age-checks/types'

/** The app's minimum age, as Bluesky's. */
export const MIN_AGE = 13

/** The age from which adult content can be switched on. */
export const ADULT_AGE = 18

/**
 * What the app does with Play's answer in a covered state (skydeval,
 * 2026-10-29, "Bluesky-like"). `undefined` is no answer yet: adult content
 * stays off until Play answers.
 */
export function decideAgeCheck(
  check: StoredAgeCheck | undefined,
): AgeCheckOutcome {
  if (!check) return 'unshared'
  switch (check.status) {
    // No duty applies to this user, or this install isn't from Play (an
    // install from elsewhere isn't store-distributed, so the laws don't
    // reach it).
    case 'NONE':
    case 'UNAVAILABLE':
      return 'open'
    case 'NOT_SHARED':
      return 'unshared'
    case 'VERIFICATION_REQUIRED':
      return 'verify'
    case 'SHARED':
      break
  }
  const {lowerBound, upperBound, parentApproval} = check
  if (upperBound !== null && upperBound < MIN_AGE) return 'under13'
  if (parentApproval === 'DECLINED') return 'parentDeclined'
  if (lowerBound === null) return 'unknown'
  if (lowerBound >= ADULT_AGE) return 'open'
  if (parentApproval === 'PENDING') return 'parentPending'
  return 'teen'
}

/** Whether the outcome blocks the app. */
export function blocksApp(outcome: AgeCheckOutcome): boolean {
  return outcome === 'under13' || outcome === 'parentDeclined'
}

/** Whether the outcome keeps adult content off. */
export function locksAdultContent(outcome: AgeCheckOutcome): boolean {
  return outcome !== 'open'
}
