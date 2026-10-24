/*
 * The fronters a post is written with (Phase 5 design 8.3, P5R2-L4): only
 * rkeys of members read as records for the posting DID, and only while the
 * compose's choice is that DID's. Fail closed: anything else is dropped, and
 * with none left no key is written. Read synchronously by every write path
 * before its first await, as the media spoilers are (the public `post()`,
 * the locus route, and the encode route's press). Imports no UI module, so
 * the write paths stay free of one.
 */

import {type Client} from '@atproto/lex'
import {type QueryClient} from '@tanstack/react-query'

import {identityQueryKey} from '#/horizon/identity/keys'
import {type PluralMember} from '#/horizon/identity/parse'
import {type IdentityAnswer} from '#/horizon/identity/queries'
import {POSTING_AS} from '#/horizon/switches'
import {getPostingState} from './compose-store'

/**
 * Server-support constant (Phase 5 design 10): Bluesky's PDS and AppView
 * keep the fronters key on a public post (live checks L1, L2). Flipped in
 * the commit that records a failed check: `false` writes no key on public
 * posts, and the control lists accounts only.
 */
export const PUBLIC_FRONTERS_KEPT: boolean = true

/**
 * The member rkeys to write as `did`'s post's fronters: the chosen members,
 * each read as a record for `did` (and not answered none in the cache
 * since), while the choice is `did`'s and no restored draft's members are
 * still held.
 */
export function postingFronters(
  queryClient: QueryClient | undefined,
  did: string,
): string[] {
  const s = getPostingState()
  if (!POSTING_AS || !s.active || s.did !== did) return []
  if (s.heldMembers || s.data?.did !== did) return []
  const listed = new Set(s.data.members.map(member => member.rkey))
  return s.members.filter(rkey => {
    if (!listed.has(rkey)) return false
    const cached = queryClient?.getQueryData<IdentityAnswer<PluralMember>>(
      identityQueryKey('member', {did, rkey}),
    )
    return cached?.kind !== 'none'
  })
}

/**
 * The fronters of a public post written through `pdsClient`: none while
 * `PUBLIC_FRONTERS_KEPT` is off.
 */
export function publicPostingFronters(
  queryClient: QueryClient,
  pdsClient: Client,
): string[] {
  if (!PUBLIC_FRONTERS_KEPT) return []
  let did: string
  try {
    did = pdsClient.assertDid
  } catch {
    return []
  }
  return postingFronters(queryClient, did)
}
