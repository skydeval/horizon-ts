/*
 * Member avatar and banner URLs (Phase 5 design 5.5, PP-12): Bluesky's
 * image CDN by DID and CID, resized, as stock builds profile images. Only
 * one's own members fall back to the own PDS's `getBlob` when the CDN
 * answers an error; another account's member image the CDN refuses is
 * replaced by the account's avatar (the caller's fallback), so a reader's
 * browser never contacts another author's PDS (PP-20).
 *
 * `useMemberImage` walks that chain from the image component's error
 * callback (live check L9): the CDN URL, then, for one's own member only,
 * the own PDS's `getBlob`, then `undefined` so the caller shows the
 * account's own image.
 */

import {useState} from 'react'

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

/** A member image to draw, and what to call when it fails to load. */
export type MemberImage = {
  uri: string
  onError: () => void
}

/*
 * URLs that failed to load this run, shared so a later mount of the same
 * member's image starts at the next step instead of failing again. Capped;
 * the oldest are forgotten first.
 */
const FAILED_CAP = 500
const failedImages = new Set<string>()

function rememberFailed(uri: string) {
  failedImages.delete(uri)
  failedImages.add(uri)
  if (failedImages.size > FAILED_CAP) {
    const oldest = failedImages.values().next().value
    if (oldest !== undefined) failedImages.delete(oldest)
  }
}

/** Forget every failed image URL (tests). */
export function resetMemberImageFailures() {
  failedImages.clear()
}

/**
 * The member image to draw for `blob`, or `undefined` for the account's
 * own image: no blob, or every step failed. The steps are the CDN URL and,
 * only when `did` is the current account, the own PDS's `getBlob`; another
 * account's PDS is never asked (PP-12, PP-20).
 */
export function useMemberImage(
  did: string,
  blob: Pick<BlobInfo, 'cid'> | undefined,
  preset: MemberImagePreset,
): MemberImage | undefined {
  // Local state as well as the shared set, so a failure re-renders this one.
  const [failed, setFailed] = useState<readonly string[]>([])
  if (!blob) return undefined
  const steps = [memberImageUrl(did, blob, preset)]
  const own = ownMemberImageFallbackUrl(did, blob)
  if (own) steps.push(own)
  const uri = steps.find(
    step => !failed.includes(step) && !failedImages.has(step),
  )
  if (!uri) return undefined
  return {
    uri,
    onError: () => {
      rememberFailed(uri)
      setFailed(previous =>
        previous.includes(uri) ? previous : [...previous, uri],
      )
    },
  }
}
