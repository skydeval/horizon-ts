/*
 * The device record of an account's membership: the last answered state and
 * the private-tier features prism answered with it. Pure apart from Horizon's
 * device keys; shared by `membership.ts` (the state) and `features.ts` (the
 * features), which do not otherwise depend on each other's storage.
 *
 * Round 3 stored the state alone as a plain string. 2H stores JSON under the
 * same key:
 *
 *   {"v":2,"state":"member"|"indexing"|"not-member","features":[...]|null}
 *
 * `features: null` is a prism without the membership query (legacy). A plain
 * round 3 value reads as its state with features never answered.
 */

import {readLocal, writeLocal} from '#/horizon/session/local-store'

/**
 * A state prism answered (never `unknown`, which is not stored).
 */
export type AnsweredMembershipState = 'member' | 'indexing' | 'not-member'

/**
 * What the device holds for an account.
 */
export type MembershipRecord = {
  state: AnsweredMembershipState
  /**
   * The features prism answered with the state; `null` for a prism without
   * the membership query; `undefined` when never answered (a round 3 value).
   */
  features: readonly string[] | null | undefined
}

/**
 * The device key holding an account's membership record.
 */
export function membershipStorageKey(did: string) {
  return `horizon:membership:${did}`
}

function isAnsweredState(value: unknown): value is AnsweredMembershipState {
  return value === 'member' || value === 'not-member' || value === 'indexing'
}

/**
 * Parse a stored value. A v2 JSON record, or a round 3 plain state; anything
 * else (including malformed JSON) is ignored.
 */
export function parseMembershipRecord(
  value: string | undefined,
): MembershipRecord | undefined {
  if (value === undefined) return undefined
  if (isAnsweredState(value)) return {state: value, features: undefined}
  if (!value.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const record = parsed as {v?: unknown; state?: unknown; features?: unknown}
  if (record.v !== 2 || !isAnsweredState(record.state)) return undefined
  if (record.features === null) return {state: record.state, features: null}
  if (!Array.isArray(record.features)) return undefined
  return {
    state: record.state,
    features: record.features.filter(
      (feature): feature is string => typeof feature === 'string',
    ),
  }
}

/**
 * The stored form of a record. Features never answered are stored as `null`,
 * which every reader treats alike (only the `private` family).
 */
export function serializeMembershipRecord(record: MembershipRecord): string {
  return JSON.stringify({
    v: 2,
    state: record.state,
    features: record.features ?? null,
  })
}

/**
 * The record the device holds for `did`, if any.
 */
export function readMembershipRecord(
  did: string,
): MembershipRecord | undefined {
  return parseMembershipRecord(readLocal(membershipStorageKey(did)))
}

/**
 * Store `record` for `did`, only when it differs from what is stored.
 */
export function writeMembershipRecord(did: string, record: MembershipRecord) {
  const key = membershipStorageKey(did)
  const value = serializeMembershipRecord(record)
  if (readLocal(key) !== value) writeLocal(key, value)
}
