/*
 * Membership joins the feed query keys (O-9). A member's Following, Posts and
 * Replies tabs (merged with private posts, 6.3.1) and Private tab hold
 * private posts;
 * a non-member's do not. Appending the member's DID to those keys means the
 * two never share a cache entry, so a membership change starts a fresh query
 * instead of mixing pages. Cache-wide and prefix filters built from the stock
 * key still reach the longer one.
 *
 * Membership is read from the published current-clients record (see
 * `routing/current-clients.ts`) so this also works outside render. During the
 * render after an account change in which the record is stale the key may
 * name the previous account; `usePrivateFeedSource` returns no source in that
 * render, and the publish re-renders the caller with the right key.
 */

import {getCurrentDid} from '#/horizon/routing/current-clients'
import {isPrivateMember} from '#/horizon/routing/membership'
import {PRIVATE_READING} from '#/horizon/switches'

/**
 * The filter of a profile's Private tab feed.
 */
export const PRIVATE_TAB_FILTER = 'horizon_private'

/**
 * The feed descriptor of `did`'s Private tab. Typed as a plain string so the
 * stock `FeedDescriptor` is not widened; callers cast where a stock prop
 * needs it.
 */
export function privateTabDescriptor(did: string): string {
  return `author|${did}|${PRIVATE_TAB_FILTER}`
}

/**
 * The DID a Private tab descriptor names, or `undefined` for any other
 * descriptor.
 */
export function privateTabDid(feedDesc: string): string | undefined {
  const [kind, did, filter, ...rest] = feedDesc.split('|')
  if (kind !== 'author' || filter !== PRIVATE_TAB_FILTER || rest.length) {
    return undefined
  }
  return did || undefined
}

function carriesPrivatePosts(feedDesc: string): boolean {
  return (
    feedDesc === 'following' ||
    (feedDesc.startsWith('author|') &&
      (feedDesc.endsWith('|posts_and_author_threads') ||
        feedDesc.endsWith('|posts_with_replies'))) ||
    privateTabDid(feedDesc) !== undefined
  )
}

/**
 * The stock feed key, with `{horizonPrivate: <did>}` appended for a member's
 * feeds that carry private posts. Unchanged otherwise, and with
 * `PRIVATE_READING` off.
 */
export function withPrivateKey<K extends unknown[]>(
  feedDesc: string,
  key: K,
): K | [...K, {horizonPrivate: string}] {
  if (!PRIVATE_READING || !carriesPrivatePosts(feedDesc)) return key
  const did = getCurrentDid()
  if (!isPrivateMember(did)) return key
  return [...key, {horizonPrivate: did}]
}
