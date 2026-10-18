/*
 * The PDS of a private post's author, for the blob URLs of embeds built from
 * the record (6.1.3). The current account's comes from the current-clients
 * record; another author's is resolved without a session, as the audience
 * label resolves an audience's owner (7.2), and kept in the account's
 * persisted query cache for {@link PDS_TTL_MS}, so a launch does not resolve
 * it again. A failed resolution is not kept.
 */

import {resolvePdsForIdentifier} from '#/state/queries/pds-detection'
import {createQueryKey} from '#/state/queries/util'
import {getCurrentClients} from '#/horizon/routing/current-clients'

/**
 * How long a resolved PDS URL is used before it is resolved again.
 */
export const PDS_TTL_MS = 6 * 60 * 60 * 1000

/**
 * How long an unused entry stays in the cache (and on disk).
 */
const PDS_GC_MS = 24 * 60 * 60 * 1000

/**
 * The persisted query key of `did`'s PDS URL.
 */
export function authorPdsQueryKey(did: string) {
  return createQueryKey('horizon-author-pds', {did}, {persistedVersion: 1})
}

async function resolve(did: string): Promise<string> {
  const identity = await resolvePdsForIdentifier(did)
  if (!identity?.pdsUrl) throw new Error('author PDS not resolved')
  return identity.pdsUrl
}

/**
 * The PDS URL of `did`, or `undefined` when it cannot be resolved. Calls for
 * one DID while a resolution is running share it, so a caller may start one
 * early and a later caller picks it up.
 */
export async function authorPdsUrl(did: string): Promise<string | undefined> {
  const current = getCurrentClients()
  if (current?.did === did) return current.pdsUrl
  const queryClient = current?.queryClient
  if (!queryClient) return resolve(did).catch(() => undefined)
  return queryClient
    .fetchQuery({
      queryKey: authorPdsQueryKey(did),
      staleTime: PDS_TTL_MS,
      gcTime: PDS_GC_MS,
      queryFn: () => resolve(did),
    })
    .catch(() => undefined)
}

/**
 * Start resolving `did`'s PDS URL ahead of need, for a caller that knows the
 * author before the post arrives. The later {@link authorPdsUrl} call joins
 * it. Nothing happens without the account's query cache, which is what
 * shares the resolution.
 */
export function prefetchAuthorPds(did: string) {
  const current = getCurrentClients()
  if (!current?.queryClient || current.did === did) return
  void authorPdsUrl(did)
}
