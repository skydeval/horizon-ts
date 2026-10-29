/*
 * Age checks in the app, only where a state's app store law applies
 * (skydeval, 2026-10-26; rules picked 2026-10-29). See `README.md`.
 */

/** What Google Play said, as the app keeps it on the device. */
export type StoredAgeCheck = {
  /** When Play answered (ISO). */
  checkedAt: string
  /**
   * Play's sharing status: `SHARED`, `NOT_SHARED`, `VERIFICATION_REQUIRED`;
   * `NONE` when Play reports no status (no age duty applies to this user);
   * `UNAVAILABLE` when Play could not be asked (an install not from Play).
   */
  status: 'SHARED' | 'NOT_SHARED' | 'VERIFICATION_REQUIRED' | 'NONE' | 'UNAVAILABLE'
  lowerBound: number | null
  upperBound: number | null
  /** A supervised user's parent's answer to the app's latest change. */
  parentApproval: 'APPROVED' | 'PENDING' | 'DECLINED' | null
}

/**
 * What the app does with the answer:
 * - `open`: nothing changes (18 and up, or no duty applies);
 * - `teen`: adult content locked off (13 to 17);
 * - `parentPending`: adult content off until a parent approves;
 * - `unshared`: adult content off until the user shares their age range;
 * - `unknown`: adult content off; Play shared no age range;
 * - `verify`: adult content off until the user confirms their age in Play;
 * - `under13`: the app is blocked (Horizon is for 13 and up);
 * - `parentDeclined`: the app is blocked until a parent approves.
 */
export type AgeCheckOutcome =
  | 'open'
  | 'teen'
  | 'parentPending'
  | 'unshared'
  | 'unknown'
  | 'verify'
  | 'under13'
  | 'parentDeclined'

/** A covered state. */
export type CoveredRegion = {
  /** The state's two-letter code, as the location lookup gives it. */
  regionCode: string
  /** The state's name, for the notices. */
  name: string
  /** The law, for the notes. */
  law: string
  /** The first day (UTC, `YYYY-MM-DD`) the checks run there. */
  from: string
}
