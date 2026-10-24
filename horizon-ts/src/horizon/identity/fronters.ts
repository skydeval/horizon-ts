/*
 * A post's fronters (Phase 5 design 4.2, PP-1): the
 * `app.nearhorizon.plural.fronters` key on a post record, public or
 * kryphocron. Pure.
 */

import {isValidRecordKey} from '@atproto/syntax'

import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'

/** At most this many fronters on one post. */
export const MAX_FRONTERS = 20

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The member rkeys a post record names as its fronters, or `null` for "no
 * fronters". The value must be an object whose `members` is an array of 1
 * to 20 objects, each with an `id` that is a record key; anything else reads
 * as no fronters (fail to the account, never to a guess). Duplicates are
 * dropped. Returned in display order, ascending rkey (member-list order,
 * creation order for TIDs), whatever order the record holds.
 */
export function readFronters(record: unknown): string[] | null {
  if (!isObject(record)) return null
  const value = record[PLURAL_FRONTERS_KEY]
  if (!isObject(value)) return null
  const members = value.members
  if (
    !Array.isArray(members) ||
    members.length < 1 ||
    members.length > MAX_FRONTERS
  ) {
    return null
  }
  const ids = new Set<string>()
  for (const entry of members) {
    if (!isObject(entry)) return null
    const id = entry.id
    if (typeof id !== 'string' || !isValidRecordKey(id)) return null
    ids.add(id)
  }
  return sortFronters(Array.from(ids))
}

/** Rkeys in display order: ascending, as member lists are. */
export function sortFronters(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * A copy of `record` naming `ids` as its fronters (deduplicated, each
 * `{id}`, no status), or without the key when `ids` is empty. Never mutates
 * `record`. Throws past {@link MAX_FRONTERS} or on an id that is not a
 * record key, so a bad value is never written.
 */
export function withFronters<T extends object>(
  record: T,
  ids: readonly string[],
): T {
  const unique = Array.from(new Set(ids))
  const copy = {...record} as Record<string, unknown>
  if (unique.length === 0) {
    delete copy[PLURAL_FRONTERS_KEY]
    return copy as T
  }
  if (unique.length > MAX_FRONTERS) {
    throw new Error(`At most ${MAX_FRONTERS} fronters`)
  }
  for (const id of unique) {
    if (!isValidRecordKey(id)) throw new Error('A fronter id is not an rkey')
  }
  copy[PLURAL_FRONTERS_KEY] = {members: unique.map(id => ({id}))}
  return copy as T
}
