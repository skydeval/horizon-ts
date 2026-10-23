/*
 * List names for the blocked-by-list gap row (Phase 4 design 8.3, TL-18).
 *
 * prism names one list on a `blocked-by-you` gap (`blockingByListUri`, P-10).
 * Its name and owner come from the public AppView, never from anything about
 * the hidden post: first the reader's own subscribed block lists
 * (`app.bsky.graph.getListBlocks`, every page), read once per session for the
 * account and cached in its own entry; for a URI not in that answer (a
 * subscription changed since), one `app.bsky.graph.getList` with `limit: 1`,
 * cached by URI for the session. Both take only list URIs or the reader's
 * own identity. On a post node whose public view carries
 * `author.viewer.blockingByList`, that view is used and nothing is read.
 *
 * The entries have their own root (`horizon-thread-lens-lists`), per query
 * client, so per account; a failure only drops the name from the row (11.4).
 */

import {AtUri, type AtUriString} from '@atproto/syntax'
import {useQuery} from '@tanstack/react-query'

import {makeListLink} from '#/lib/routes/links'
import {isInvalidHandle} from '#/lib/strings/handles'
import {useAppviewClient} from '#/state/session'
import {THREAD_LENS} from '#/horizon/switches'
import {app} from '#/lexicons'

type ListView = app.bsky.graph.defs.ListView
type ListViewBasic = app.bsky.graph.defs.ListViewBasic

/** The list names' query root, apart from the lens root. */
export const LENS_LISTS_ROOT = 'horizon-thread-lens-lists'

/** The reader's subscribed block lists. */
export const lensListBlocksKey = [LENS_LISTS_ROOT, 'blocks'] as const

/** One list read by URI. */
export function lensListKey(uri: string) {
  return [LENS_LISTS_ROOT, 'list', uri] as const
}

/** The most `getListBlocks` pages read. */
export const LENS_LIST_BLOCK_PAGES = 20

/** What the row shows about its list: a name when one was read, and its page. */
export type LensListName = {
  name?: string
  href: string
}

/** The stock list page, `/profile/<owner>/lists/<rkey>` (the handle when known). */
function hrefOf(uri: string, handle?: string): string {
  const parsed = new AtUri(uri)
  const owner = handle && !isInvalidHandle(handle) ? handle : parsed.host
  return makeListLink(owner, parsed.rkey)
}

/**
 * The name and page of the list `listUri` (8.3). `list` is the list view the
 * public view carried, used as it is when given.
 */
export function useLensListName(
  listUri: string | undefined,
  list?: ListViewBasic,
): LensListName | undefined {
  const client = useAppviewClient()
  const needsRead = THREAD_LENS && !!listUri && !list
  const blocks = useQuery({
    queryKey: lensListBlocksKey,
    enabled: needsRead,
    staleTime: Infinity,
    gcTime: Infinity,
    async queryFn() {
      const lists: ListView[] = []
      let cursor: string | undefined
      for (let page = 0; page < LENS_LIST_BLOCK_PAGES; page++) {
        const res = await client.call(app.bsky.graph.getListBlocks, {
          limit: 100,
          cursor,
        })
        lists.push(...res.lists)
        if (!res.cursor || res.cursor === cursor) break
        cursor = res.cursor
      }
      return lists
    },
  })
  const found = listUri
    ? blocks.data?.find(view => view.uri === listUri)
    : undefined
  const single = useQuery({
    queryKey: lensListKey(listUri ?? ''),
    enabled: needsRead && (blocks.isError || (blocks.isSuccess && !found)),
    staleTime: Infinity,
    gcTime: Infinity,
    async queryFn() {
      const res = await client.call(app.bsky.graph.getList, {
        list: listUri as AtUriString,
        limit: 1,
      })
      return res.list
    },
  })
  if (!listUri) return undefined
  if (list) return {name: list.name, href: hrefOf(listUri)}
  const view = found ?? single.data
  return {name: view?.name, href: hrefOf(listUri, view?.creator.handle)}
}
