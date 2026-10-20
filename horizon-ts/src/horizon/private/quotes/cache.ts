/*
 * The quoted private post cache (6.7). A quoted private post is held per URI
 * in the account's query cache under a persisted key, so a launch or refresh
 * paints a quote it has seen at once while it is read again in the
 * background. The page fetches fill it for every quote they carry
 * (`resolve.ts`); `PrivateQuote` reads it, and fetches the one post itself
 * only for a quote no page fetch filled.
 *
 * The cache holds JSON (CIDs as `{$link}`), as the persister writes JSON;
 * `null` is a post the reader may not view (or that does not exist).
 */

import {jsonToLex, type JsonValue, lexToJson} from '@atproto/lex'
import {type QueryClient, useQuery} from '@tanstack/react-query'

import {logger} from '#/logger'
import {STALE} from '#/state/queries'
import {createQueryKey} from '#/state/queries/util'
import {readPrivatePost} from '#/horizon/private/links'
import {type app} from '#/lexicons'

/**
 * How long a quote read is used before it is read again.
 */
export const QUOTE_STALE_MS = STALE.MINUTES.FIVE

/**
 * How long an unused quote stays in the cache, and on disk.
 */
export const QUOTE_GC_MS = 24 * 60 * 60 * 1000

/**
 * A quoted private post as cached: JSON, or `null` when it is not viewable.
 */
export type QuoteData = JsonValue | null

/**
 * The persisted query key of the quoted private post at `uri`. Version 2
 * drops quotes cached with a video on the video service's CDN, from before a
 * private video played from its author's PDS. Version 3 drops quotes cached
 * with a quoted private post of their own left unconverted (no spoilers or
 * content warning).
 */
export function privateQuoteQueryKey(uri: string) {
  return createQueryKey('horizon-private-quote', {uri}, {persistedVersion: 3})
}

/**
 * A read post as cached.
 */
export function toQuoteData(
  post: app.bsky.feed.defs.PostView | undefined,
): QuoteData {
  if (!post) return null
  try {
    return lexToJson(post)
  } catch (error) {
    logger.warn('private quote not cacheable', {safeMessage: error})
    return null
  }
}

/**
 * A cached quote as a post view, or `undefined` when it is not viewable.
 */
export function fromQuoteData(
  data: QuoteData | undefined,
): app.bsky.feed.defs.PostView | undefined {
  if (!data) return undefined
  return jsonToLex(data) as unknown as app.bsky.feed.defs.PostView
}

/**
 * The quote's own read, for a quote no page fetch filled.
 */
async function fetchQuote(uri: string): Promise<QuoteData> {
  return toQuoteData(await readPrivatePost(uri))
}

/**
 * The query options of the quote at `uri`, shared by the hook and by a page
 * fetch that waits on a read already running.
 */
export function privateQuoteQueryOptions(uri: string) {
  return {
    queryKey: privateQuoteQueryKey(uri),
    queryFn: () => fetchQuote(uri),
    staleTime: QUOTE_STALE_MS,
    gcTime: QUOTE_GC_MS,
  }
}

/**
 * The quoted private post at `uri`, from the cache when a page fetch filled
 * it, else read on its own. Only enabled for a member.
 */
export function usePrivateQuoteQuery(uri: string, enabled: boolean) {
  return useQuery({
    ...privateQuoteQueryOptions(uri),
    enabled,
    select: fromQuoteData,
  })
}

/**
 * Whether the cache holds a fresh read of the quote at `uri`.
 */
export function hasFreshQuote(
  queryClient: QueryClient,
  uri: string,
  now = Date.now(),
): boolean {
  const state = queryClient.getQueryState(privateQuoteQueryKey(uri))
  return (
    !!state &&
    state.data !== undefined &&
    !state.isInvalidated &&
    now - state.dataUpdatedAt < QUOTE_STALE_MS
  )
}
