/*
 * The profileAlt record in the query cache: one entry per account, read
 * from the account's own repo (prism does not serve it), 5 minutes fresh.
 * `null` is a proven none. A failed read shows nothing extra, and a cached
 * answer keeps showing behind it.
 */

import {type QueryClient, useQuery, useQueryClient} from '@tanstack/react-query'

import {readRepoSelfRecord} from '#/horizon/identity/reads'
import {PROFILE_ALT_COLLECTION} from '#/horizon/lexicons/nearhorizon'
import {
  altForImage,
  parseProfileAlt,
  type ProfileAlt,
} from '#/horizon/profile-alt/parse'
import {PROFILE_ALT_TEXT} from '#/horizon/switches'

const ROOT = 'horizon-profile-alt'

const STALE_MS = 5 * 60 * 1000
const GC_MS = 24 * 60 * 60 * 1000

/** The record as read: parsed (or `null` for none) and its CID. */
export type ProfileAltAnswer = {record: ProfileAlt | null; cid?: string}

export function profileAltQueryKey(did: string) {
  return [ROOT, did] as const
}

/** Read `did`'s record from its repo. */
export async function fetchProfileAlt(
  did: string,
  queryClient?: QueryClient,
): Promise<ProfileAltAnswer> {
  const read = await readRepoSelfRecord(did, PROFILE_ALT_COLLECTION, {
    queryClient,
  })
  if (read.status === 'none') return {record: null}
  // A record that does not parse describes nothing, but it exists.
  const record = parseProfileAlt(read.value) ?? {raw: {}}
  return read.cid === undefined ? {record} : {record, cid: read.cid}
}

export function profileAltQueryOptions(did: string, queryClient: QueryClient) {
  return {
    queryKey: profileAltQueryKey(did),
    queryFn: () => fetchProfileAlt(did, queryClient),
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: 1,
  }
}

/** `did`'s record, or nothing while `did` is unset or the switch is off. */
export function useProfileAltQuery(did: string | undefined) {
  const queryClient = useQueryClient()
  return useQuery({
    ...profileAltQueryOptions(did ?? '', queryClient),
    enabled: PROFILE_ALT_TEXT && !!did,
  })
}

/**
 * The descriptions of the avatar and banner shown for `did`: each only
 * when the record describes that very image (a plural member's image shown
 * in its place gets none).
 */
export function useProfileImageAlts(
  did: string | undefined,
  shown: {avatar?: string; banner?: string},
): {avatar?: string; banner?: string} {
  const {data} = useProfileAltQuery(did)
  const record = data?.record
  return {
    avatar: altForImage(record, 'avatar', shown.avatar),
    banner: altForImage(record, 'banner', shown.banner),
  }
}
