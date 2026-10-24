/*
 * The identity entries' query keys, apart from `queries.ts` so the write
 * paths (`posting-as/fronters.ts`, read by `post()`) can check a cached
 * member answer without importing the reads and their session modules.
 */

import {createQueryKey} from '#/state/queries/util'

/** The entries, by kind. */
export type IdentityKind =
  'pronouns' | 'system' | 'member' | 'members' | 'front'

export const IDENTITY_ROOTS: Record<IdentityKind, string> = {
  pronouns: 'horizon-identity-pronouns',
  system: 'horizon-identity-system',
  member: 'horizon-identity-member',
  members: 'horizon-identity-members',
  front: 'horizon-identity-front',
}

/** Each entry's args. */
export type IdentityArgs = {
  pronouns: {did: string}
  system: {did: string}
  member: {did: string; rkey: string}
  members: {did: string}
  front: {did: string}
}

/** The persisted query key of an entry (the front is not persisted). */
export function identityQueryKey<K extends IdentityKind>(
  kind: K,
  args: IdentityArgs[K],
) {
  return kind === 'front'
    ? createQueryKey(IDENTITY_ROOTS[kind], args)
    : createQueryKey(IDENTITY_ROOTS[kind], args, {persistedVersion: 1})
}
