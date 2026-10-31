/*
 * The signed-in account joins the keys of the feeds that can carry private
 * posts (O-9): Following, the Posts and Replies tabs (merged with private
 * posts, 6.3.1) and the Private tab. Cache-wide and prefix filters built
 * from the stock key still reach the longer one.
 *
 * The key names the account, never its membership. A key that changed with
 * membership started a fresh, empty query whenever membership flickered (a
 * read answering NotEnrolled, a re-check): the whole feed blanked and
 * remounted, which flashed the screen and killed every video playing in it.
 * A membership change now updates the same query in place instead
 * (`membership-sync.ts`): private posts leave the cached pages at once when
 * membership is lost, and the pages are fetched again either way.
 *
 * The account is read from the published current-clients record (see
 * `routing/current-clients.ts`) so this also works outside render. During the
 * render after an account change in which the record is stale the key may
 * name the previous account; `usePrivateFeedSource` returns no source in that
 * render, and the publish re-renders the caller with the right key.
 */

import {getCurrentDid} from '#/horizon/routing/current-clients'
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

/** Whether a feed descriptor names a feed that can carry private posts. */
export function carriesPrivatePosts(feedDesc: string): boolean {
  return (
    feedDesc === 'following' ||
    (feedDesc.startsWith('author|') &&
      (feedDesc.endsWith('|posts_and_author_threads') ||
        feedDesc.endsWith('|posts_with_replies'))) ||
    privateTabDid(feedDesc) !== undefined
  )
}

/**
 * The stock feed key, with `{horizonPrivate: <did>}` appended for the
 * signed-in account's feeds that can carry private posts, member or not.
 * Unchanged when signed out, for other feeds, and with `PRIVATE_READING`
 * off.
 */
export function withPrivateKey<K extends unknown[]>(
  feedDesc: string,
  key: K,
): K | [...K, {horizonPrivate: string}] {
  if (!PRIVATE_READING || !carriesPrivatePosts(feedDesc)) return key
  const did = getCurrentDid()
  if (!did) return key
  return [...key, {horizonPrivate: did}]
}

/** The account a feed key from `withPrivateKey` names, or `undefined`. */
export function privateKeyDid(queryKey: readonly unknown[]): string | undefined {
  const last = queryKey[queryKey.length - 1]
  if (typeof last !== 'object' || last === null) return undefined
  const did = (last as {horizonPrivate?: unknown}).horizonPrivate
  return typeof did === 'string' ? did : undefined
}
