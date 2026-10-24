/*
 * Member avatar and banner URLs (Phase 5 design 5.5, PP-12): Bluesky's
 * image CDN by DID and CID, resized, as stock builds profile images. Only
 * one's own members fall back to the own PDS's `getBlob` when the CDN
 * answers an error; another account's member image the CDN refuses is
 * replaced by the account's avatar (the caller's fallback), so a reader's
 * browser never contacts another author's PDS (PP-20).
 */

import {type BlobInfo} from '#/horizon/identity/parse'
import {getCurrentClients} from '#/horizon/routing/current-clients'

const CDN = 'https://cdn.bsky.app/img'

/**
 * The CDN preset: `avatar_thumbnail` on posts, `avatar` on the profile,
 * `banner` for the header.
 */
export type MemberImagePreset = 'avatar_thumbnail' | 'avatar' | 'banner'

/** The CDN URL of a member image. */
export function memberImageUrl(
  did: string,
  blob: Pick<BlobInfo, 'cid'>,
  preset: MemberImagePreset,
): string {
  return `${CDN}/${preset}/plain/${did}/${blob.cid}@jpeg`
}

/**
 * The own PDS's `getBlob` URL of one's own member image, for when the CDN
 * refuses it; `undefined` for any account but the current one, or without
 * a known PDS URL.
 */
export function ownMemberImageFallbackUrl(
  did: string,
  blob: Pick<BlobInfo, 'cid'>,
): string | undefined {
  const current = getCurrentClients()
  if (!current || current.did !== did || !current.pdsUrl) return undefined
  const url = new URL('/xrpc/com.atproto.sync.getBlob', current.pdsUrl)
  url.searchParams.set('did', did)
  url.searchParams.set('cid', blob.cid)
  return url.toString()
}
