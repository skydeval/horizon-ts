/*
 * The quoted private post cache (6.7). A quoted private post is held per URI
 * in the account's query cache under a persisted key, so a launch or refresh
 * paints a quote it has seen at once while it is read again in the
 * background. The page fetches fill it for every quote they carry
 * (`resolve.ts`), and prism's verdicts on the quotes of every answer land in
 * it (`verdicts.ts`); `PrivateQuote` reads it, and fetches the one post itself
 * only for a quote no page fetch filled.
 *
 * The cache holds JSON (CIDs as `{$link}`), as the persister writes JSON;
 * `null` is a post the reader may not view (or that does not exist), and
 * `{unavailable: true, uri}` one prism cannot answer for now (prism busy
 * design 6.3).
 *
 * Freshness reads one rule (`isFreshQuote`): never the quiet card, never a
 * value restored from disk, never older than {@link QUOTE_STALE_MS}, and,
 * where a floor applies, answered since it.
 */

import {type QueryClient, useQuery} from '@tanstack/react-query'

import {keepOverData, PRIVATE_RETRY} from '#/horizon/private/api/transient'
import {readPrivatePostViewsAnswered} from '#/horizon/private/links'
import {gatherQuoteRead, watchQuotes} from '#/horizon/private/quotes/batch'
import {
  isFreshQuote,
  isFreshQuoteState,
  privateQuoteQueryKey,
  QUOTE_GC_MS,
  QUOTE_STALE_MS,
  type QuoteData,
  quoteFromRead,
} from '#/horizon/private/quotes/verdicts'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {isPrismConfirmed} from '#/horizon/routing/health'
import {isPrivateMember} from '#/horizon/routing/membership'

export {
  fromQuoteData,
  isQuoteView,
  isUnavailableQuote,
  privateQuoteQueryKey,
  QUOTE_GC_MS,
  QUOTE_STALE_MS,
  type QuoteData,
  toQuoteData,
} from '#/horizon/private/quotes/verdicts'

/**
 * The quote's own read, for a quote no page fetch filled, judged by
 * `quoteFromRead`. While the account is not confirmed it goes through the
 * gather, so late slots read together.
 */
async function fetchQuote(
  uri: string,
  previous: () => QuoteData | undefined,
): Promise<QuoteData> {
  const clients = getCurrentClients()
  if (!clients || !isPrivateMember(clients.did)) return null
  watchQuotes()
  if (!isPrismConfirmed(clients.did)) {
    return gatherQuoteRead(clients.did, uri, previous)
  }
  const read = await readPrivatePostViewsAnswered(clients, [uri])
  return quoteFromRead(uri, read, previous(), clients.queryClient)
}

function previousOf(queryClient: QueryClient | undefined, uri: string) {
  return () => queryClient?.getQueryData<QuoteData>(privateQuoteQueryKey(uri))
}

/**
 * The query options of the quote at `uri`, shared by the hook and by a page
 * fetch that waits on a read already running.
 */
export function privateQuoteQueryOptions(uri: string) {
  return {
    queryKey: privateQuoteQueryKey(uri),
    queryFn: () =>
      fetchQuote(uri, previousOf(getCurrentClients()?.queryClient, uri)),
    staleTime: QUOTE_STALE_MS,
    gcTime: QUOTE_GC_MS,
  }
}

/**
 * The quoted private post at `uri`, from the cache when a page fetch filled
 * it, else read on its own. Only enabled for a member. `floor` is the slot's
 * (4.1): a quote not answered since it is stale, so the slot reads it.
 */
export function usePrivateQuoteQuery(
  uri: string,
  enabled: boolean,
  floor?: number,
) {
  return useQuery({
    ...privateQuoteQueryOptions(uri),
    // Retried while prism is busy, never over a kept copy (busy design 5).
    queryFn: context =>
      keepOverData(context, () => fetchQuote(uri, previousOf(context.client, uri))),
    ...PRIVATE_RETRY,
    staleTime: query =>
      isFreshQuoteState(query.state, uri, {floor}) ? QUOTE_STALE_MS : 0,
    enabled,
  })
}

/**
 * Whether the cache holds a fresh read of the quote at `uri` (6.3): see
 * `isFreshQuote`; `floor` is an unconfirmed page fetch's start.
 */
export function hasFreshQuote(
  queryClient: QueryClient,
  uri: string,
  now = Date.now(),
  floor?: number,
): boolean {
  return isFreshQuote(queryClient, uri, {now, floor})
}
