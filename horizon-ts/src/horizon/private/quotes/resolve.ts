/*
 * Quoted private posts resolved inside the page fetch (6.7), so a post and
 * its quote render in the same frame instead of the quote appearing after a
 * read of its own.
 *
 * After a page's data arrives, every private post it quotes without
 * hydrating is read in one `getPosts` (25 to a call) and put in the quote
 * cache (`cache.ts`), and the page is returned only then, or after
 * {@link QUOTE_DEADLINE_MS}, whichever is first; a read still running then
 * finishes in the cache and `PrivateQuote` shows it when it lands. A quote
 * the cache already holds does not hold the page: a fresh one is not read
 * again, a stale one is read again in the background. A read already running
 * for a quote is joined, not repeated.
 *
 * Only for a member, while `PRIVATE_READING`; anyone else's quotes are the
 * stand-in and nothing is read.
 */

import {type QueryClient} from '@tanstack/react-query'

import {readPrivatePostViews} from '#/horizon/private/links'
import {
  hasFreshQuote,
  privateQuoteQueryKey,
  privateQuoteQueryOptions,
  QUOTE_GC_MS,
  toQuoteData,
} from '#/horizon/private/quotes/cache'
import {
  feedItemPosts,
  privateQuoteUris,
  threadItemPosts,
} from '#/horizon/private/quotes/collect'
import {
  type CurrentClients,
  getCurrentClients,
} from '#/horizon/routing/current-clients'
import {isPrivateMember} from '#/horizon/routing/membership'
import {PRIVATE_READING} from '#/horizon/switches'
import {type app} from '#/lexicons'

/**
 * How long a page waits for its quotes before it is returned without them.
 */
export const QUOTE_DEADLINE_MS = 2_000

/**
 * What a resolution reads with; the published current-clients record unless
 * a test passes its own.
 */
export type QuoteResolutionContext = {
  clients: Pick<CurrentClients, 'did' | 'prismClient' | 'appviewClient'>
  queryClient: QueryClient
  deadlineMs?: number
}

function currentContext(): QuoteResolutionContext | undefined {
  const clients = getCurrentClients()
  if (!clients?.queryClient) return undefined
  return {clients, queryClient: clients.queryClient}
}

/**
 * Settle when every promise has, or after `ms`, whichever is first.
 */
async function settleWithin(promises: Promise<unknown>[], ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
}

/**
 * Read and cache every private post `posts` quote without hydrating, and
 * resolve when the ones the cache did not hold are in, or at the deadline.
 * Never rejects: a failed read leaves the quote to `PrivateQuote`.
 */
export async function resolvePrivateQuotes(
  posts: Iterable<app.bsky.feed.defs.PostView | undefined>,
  context: QuoteResolutionContext | undefined = currentContext(),
): Promise<void> {
  if (!PRIVATE_READING || !context) return
  const {clients, queryClient, deadlineMs = QUOTE_DEADLINE_MS} = context
  if (!isPrivateMember(clients.did)) return
  const uris = privateQuoteUris(posts)
  if (uris.length === 0) return

  const now = Date.now()
  const waits: Promise<unknown>[] = []
  const toRead: string[] = []
  const held = new Set<string>()
  for (const uri of uris) {
    const state = queryClient.getQueryState(privateQuoteQueryKey(uri))
    const hasData = state?.data !== undefined
    if (state?.fetchStatus === 'fetching') {
      // Joins the read already running.
      if (!hasData)
        waits.push(queryClient.fetchQuery(privateQuoteQueryOptions(uri)))
      continue
    }
    if (hasFreshQuote(queryClient, uri, now)) continue
    toRead.push(uri)
    if (hasData) held.add(uri)
  }

  if (toRead.length > 0) {
    const read = readPrivatePostViews(clients, toRead)
    // Each quote's query reports the failure; the page goes on.
    read.catch(() => {})
    for (const uri of toRead) {
      const fetched = queryClient.fetchQuery({
        queryKey: privateQuoteQueryKey(uri),
        queryFn: async () => toQuoteData((await read).get(uri)),
        staleTime: 0,
        gcTime: QUOTE_GC_MS,
      })
      if (held.has(uri)) {
        fetched.catch(() => {})
      } else {
        waits.push(fetched)
      }
    }
  }

  if (waits.length > 0) await settleWithin(waits, deadlineMs)
}

/**
 * {@link resolvePrivateQuotes} for a thread's items.
 */
export function resolveThreadQuotes(
  thread: readonly {value: unknown}[],
): Promise<void> {
  return resolvePrivateQuotes(threadItemPosts(thread))
}

/**
 * A page of the public bookmarks, returned once the private posts its items
 * quote are resolved.
 */
export async function withBookmarkQuotes<
  T extends {bookmarks: {item: unknown}[]},
>(page: T): Promise<T> {
  await resolvePrivateQuotes(
    page.bookmarks.map(bookmark => {
      const item = bookmark.item as {$type?: unknown}
      return item?.$type === 'app.bsky.feed.defs#postView'
        ? (item as app.bsky.feed.defs.PostView)
        : undefined
    }),
  )
  return page
}

type FeedFetcher = {
  fetch: (
    ...args: never[]
  ) => Promise<{feed: app.bsky.feed.defs.FeedViewPost[]}>
}

const wrapped = new WeakMap<object, object>()

/**
 * A feed API whose every page is returned with the private posts it quotes
 * resolved. Any other member is the API's own, bound to it.
 */
export function withPrivateQuotes<A extends FeedFetcher>(api: A): A {
  const proxy = new Proxy(api, {
    get(target, prop) {
      if (prop === 'fetch') {
        return async (...args: never[]) => {
          const res = await target.fetch(...args)
          await resolvePrivateQuotes(feedItemPosts(res.feed))
          return res
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrapped.set(proxy, api)
  return proxy
}

/**
 * The API {@link withPrivateQuotes} wrapped, or `api` itself (tests).
 */
export function unwrapPrivateQuotes<A extends object>(api: A): A {
  return (wrapped.get(api) as A | undefined) ?? api
}
