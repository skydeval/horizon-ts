/*
 * Pre-warming a page's identities as it arrives (Phase 5 design 4.6, B-6,
 * ID-23). Feed, profile feed, search, thread and notification query
 * functions hand their page to `prefetchPageIdentities`, which finds every
 * post on it (the posts, the posts they quote, the reply parents and roots
 * a feed item carries), and asks one batched S-2 call for the pronouns and
 * system of each author and the members its fronter posts name. Not the
 * front: posts never show it (U-6).
 *
 * A later page (fetched ahead of the scroll, before it shows) whose posts
 * name fronters waits up to 250 ms for those answers inside its query
 * function, so it paints with the members. A first page, a refetch and a
 * pull-to-refresh never wait (P5R1-N10): they paint the account as stock
 * and swap to the members when the answers land. Pronouns never hold a
 * page; they ride in the same call.
 */

import {type QueryClient, type QueryKey} from '@tanstack/react-query'

import {readFronters} from '#/horizon/identity/fronters'
import {type IdentityPage, prefetchIdentities} from '#/horizon/identity/queries'
import {PLURAL_DISPLAY, PRONOUNS} from '#/horizon/switches'

/** How long a later page waits for its fronters' answers. */
export const LATER_PAGE_WAIT_MS = 250

/** How deep the page walk looks for posts. */
const MAX_DEPTH = 12

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A post view (`record`) or an embedded view record (`value`): a `uri`, an
 * `author` with a DID, and the record.
 */
function postOf(
  value: Record<string, unknown>,
): {did: string; record: unknown} | undefined {
  if (typeof value.uri !== 'string') return undefined
  const author = value.author
  if (!isObject(author) || typeof author.did !== 'string') return undefined
  if ('record' in value) return {did: author.did, record: value.record}
  if ('value' in value) return {did: author.did, record: value.value}
  return undefined
}

/**
 * What a page names: every post author's DID and, by author, the member
 * rkeys its posts name as fronters. Walks any shape (feed items, thread
 * items, hydrated notification pages), so each query hands over its page as
 * it is.
 */
export function collectPageIdentities(page: unknown): IdentityPage {
  const dids = new Set<string>()
  const fronters = new Map<string, Set<string>>()
  const seen = new Set<object>()
  const walk = (value: unknown, depth: number) => {
    if (!isObject(value) || depth > MAX_DEPTH || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const post = postOf(value)
    if (post) {
      dids.add(post.did)
      const rkeys = readFronters(post.record)
      if (rkeys) {
        let set = fronters.get(post.did)
        if (!set) fronters.set(post.did, (set = new Set()))
        for (const rkey of rkeys) set.add(rkey)
      }
    }
    for (const key of Object.keys(value)) {
      // A record's own fields hold no further posts.
      if (post && (key === 'record' || key === 'value')) continue
      walk(value[key], depth + 1)
    }
  }
  walk(page, 0)
  return {
    dids: [...dids],
    fronters: [...fronters].map(([did, rkeys]) => ({did, rkeys: [...rkeys]})),
  }
}

/**
 * Whether the page being fetched is a later page: one asked for with the
 * cursor the cached query's last page ends with (a fetch of the next page).
 * A first page has no cursor; a refetch asks each page again with the
 * cursor of the page before it, never the last one's.
 */
export function isLaterPage(
  queryClient: QueryClient,
  queryKey: QueryKey,
  cursor: string | undefined,
): boolean {
  if (!cursor) return false
  const data = queryClient.getQueryData<{pages?: unknown[]}>(queryKey)
  const last = data?.pages?.at(-1)
  return isObject(last) && last.cursor === cursor
}

/**
 * Warm the identities of a page that just arrived. With `later`, and when
 * the page names fronters, resolves once their answers land or after
 * {@link LATER_PAGE_WAIT_MS}, whichever is first; otherwise at once. Never
 * throws: a failed ask only leaves the account as stock.
 */
export async function prefetchPageIdentities(
  queryClient: QueryClient,
  page: unknown,
  {later = false}: {later?: boolean} = {},
): Promise<void> {
  if (!PRONOUNS && !PLURAL_DISPLAY) return
  let asks: Promise<void>
  let namesFronters: boolean
  try {
    const identities = collectPageIdentities(page)
    namesFronters = PLURAL_DISPLAY && (identities.fronters?.length ?? 0) > 0
    if (identities.dids.length === 0) return
    asks = prefetchIdentities(queryClient, {
      dids: identities.dids,
      fronters: PLURAL_DISPLAY ? identities.fronters : [],
    }).catch(() => undefined)
  } catch {
    return
  }
  if (!later || !namesFronters) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    asks,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, LATER_PAGE_WAIT_MS)
    }),
  ])
  clearTimeout(timer)
}
