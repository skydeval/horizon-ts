/*
 * Bookmarks of private posts (10.2): saved through prism's private bookmark
 * methods (P-8) instead of the AppView's, and listed under Saved's Private
 * tab from their own query, never under the stock `bookmarks` root, so
 * stock cache-wide bookmark operations never receive a private post.
 *
 * Writing goes through the stock bookmark mutation (Bkm 4, Bkm 5), whose
 * shadow updates and error handling stay stock. Private posts show the stock
 * bookmark control and menu item (v2 round 2, fix 6, reversing O-24). Until
 * prism answers `private.bookmarks` in this run a press on either is refused
 * with a toast before the mutation runs (`refusesPrivateBookmark`, Ctl 4 and
 * Menu 8), so nothing here writes; Saved's Private tab queries while the
 * feature is listed (2H design 5.3).
 */

import {type $Typed, type Client} from '@atproto/lex'
import {type AtUriString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type InfiniteData, type QueryClient} from '@tanstack/react-query'

import {updatePostShadow} from '#/state/cache/post-shadow'
import * as Toast from '#/components/Toast'
import {nearhorizon} from '#/horizon/lexicons'
import {adaptPosts, type PrivateSource} from '#/horizon/private/adapt/feed-view'
import {
  getPrivateBookmarks,
  reportedPrismWrite,
} from '#/horizon/private/api/reads'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {resolvePrivateQuotes} from '#/horizon/private/quotes/resolve'
import {privateBookmarksServed} from '#/horizon/private/server-support'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {requireCurrentClients} from '#/horizon/routing/current-clients'
import {PRIVATE_READING} from '#/horizon/switches'
import {type app} from '#/lexicons'

/**
 * The root of the private bookmark list's query keys.
 */
export const PRIVATE_BOOKMARKS_ROOT = 'horizon-private-bookmarks'

/**
 * The private bookmark list of `did`.
 */
export function privateBookmarksQueryKey(did: string) {
  return [PRIVATE_BOOKMARKS_ROOT, did]
}

/**
 * The size of a private bookmarks page.
 */
export const PRIVATE_BOOKMARKS_PAGE_LIMIT = 30

/**
 * A bookmark as Saved lists it, in the stock page shape.
 */
export type PrivateBookmarkView = {
  createdAt: string
  subject: {uri: string; cid: string}
  item: $Typed<app.bsky.feed.defs.PostView>
}

/**
 * One page of the private list, in the stock page shape.
 */
export type PrivateBookmarksPage = {
  bookmarks: PrivateBookmarkView[]
  cursor?: string
  /** When the page's fetch completed (the load gate's stamp, prism busy 4.1). */
  fetchedAt?: number
}

/**
 * The stock bookmark mutation's arguments, as far as this module reads them.
 */
export type PrivateBookmarkArgs =
  | {action: 'create'; post: {uri: string; cid: string}}
  | {action: 'delete'; uri: string}

function argsUri(args: PrivateBookmarkArgs): string {
  return args.action === 'create' ? args.post.uri : args.uri
}

/**
 * Whether the stock bookmark mutation's arguments name a private post
 * (Bkm 4, Bkm 5). `false` with `PRIVATE_READING` off.
 */
export function isPrivateBookmarkArgs(args: PrivateBookmarkArgs): boolean {
  return PRIVATE_READING && isPrivatePostUri(argsUri(args))
}

/**
 * The bookmark press guard (Ctl 4, Menu 8): `true`, after a toast, when the
 * post at `uri` would be saved or removed with prism and prism does not
 * store private bookmarks (P-8: `private.bookmarks` not answered in this
 * run, 2H design 4.7). The caller then does nothing: no save, no toggle, no
 * shadow update. `false` for every other post, and for private posts once
 * the feature is answered, so the press takes the stock path into
 * `privateBookmarkMutationFn`.
 */
export function refusesPrivateBookmark(uri: string): boolean {
  if (
    privateBookmarksServed({forWrite: true}) ||
    !isPrivateBookmarkArgs({action: 'delete', uri})
  ) {
    return false
  }
  Toast.show(t`Saving private posts isn’t available yet.`, {type: 'info'})
  return true
}

/**
 * Save a private post with prism.
 */
export async function createPrivateBookmark(
  prism: Client,
  {uri, cid}: {uri: string; cid: string},
): Promise<void> {
  await reportedPrismWrite(nearhorizon.privateCreateBookmark, {
    send: () =>
      prism.call(nearhorizon.privateCreateBookmark, {
        uri: uri as AtUriString,
        cid,
      }),
  })
}

/**
 * Remove a private post's bookmark with prism.
 */
export async function deletePrivateBookmark(
  prism: Client,
  {uri}: {uri: string},
): Promise<void> {
  await reportedPrismWrite(nearhorizon.privateDeleteBookmark, {
    send: () =>
      prism.call(nearhorizon.privateDeleteBookmark, {uri: uri as AtUriString}),
  })
}

/**
 * The stock mutation's work for a private post (Bkm 4): the same shadow
 * update, then prism's method with the current account's prism client in
 * place of the AppView's.
 */
export async function privateBookmarkMutationFn(
  qc: QueryClient,
  args: PrivateBookmarkArgs,
): Promise<void> {
  const prism = requireCurrentClients().prismClient
  if (args.action === 'create') {
    updatePostShadow(qc, args.post.uri, {bookmarked: true})
    await createPrivateBookmark(prism, args.post)
  } else {
    updatePostShadow(qc, args.uri, {bookmarked: false})
    await deletePrivateBookmark(prism, {uri: args.uri})
  }
}

/**
 * `post` as the private list holds it: every item of the list is bookmarked
 * by the reader, which prism's views do not say until P-2 serves
 * `viewer.bookmarked`. Without it a row's stock bookmark control would show
 * "save" and a press would save again instead of removing it.
 */
export function asBookmarkedItem(
  post: app.bsky.feed.defs.PostView,
): $Typed<app.bsky.feed.defs.PostView> {
  return {
    ...post,
    $type: 'app.bsky.feed.defs#postView',
    viewer: {...post.viewer, bookmarked: true},
  }
}

/**
 * The stock mutation's success step for a private post (Bkm 5): the private
 * list's cache gains or loses the post, and the stock `bookmarks` caches are
 * left alone.
 */
export function onPrivateBookmarkSuccess(
  qc: QueryClient,
  args: PrivateBookmarkArgs,
): void {
  qc.setQueriesData<InfiniteData<PrivateBookmarksPage>>(
    {queryKey: [PRIVATE_BOOKMARKS_ROOT]},
    data => {
      if (!data) return data
      if (args.action === 'delete') {
        return {
          ...data,
          pages: data.pages.map(page => ({
            ...page,
            bookmarks: page.bookmarks.filter(b => b.subject.uri !== args.uri),
          })),
        }
      }
      const post = args.post as app.bsky.feed.defs.PostView
      if (!post.author) return data
      const exists = data.pages.some(page =>
        page.bookmarks.some(b => b.subject.uri === post.uri),
      )
      if (exists) return data
      const bookmark: PrivateBookmarkView = {
        createdAt: new Date().toISOString(),
        subject: {uri: post.uri, cid: post.cid},
        item: asBookmarkedItem(post),
      }
      return {
        ...data,
        pages: data.pages.map((page, index) =>
          index === 0
            ? {...page, bookmarks: [bookmark, ...page.bookmarks]}
            : page,
        ),
      }
    },
  )
}

/**
 * The posts of the private list's caches at `uri`, for the stock post shadow
 * (Shadow 1), so likes, reposts and bookmark toggles show there too.
 */
export function* findPrivateBookmarkPosts(
  qc: QueryClient,
  uri: string,
): Generator<app.bsky.feed.defs.PostView, undefined> {
  const datas = qc.getQueriesData<InfiniteData<PrivateBookmarksPage>>({
    queryKey: [PRIVATE_BOOKMARKS_ROOT],
  })
  for (const [, data] of datas) {
    for (const page of data?.pages ?? []) {
      for (const bookmark of page.bookmarks) {
        if (bookmark.item.uri === uri) yield bookmark.item
      }
    }
  }
}

/**
 * One page of the private list: prism's bookmarks, each item adapted (one
 * author merge per page) and marked bookmarked, returned with the private
 * posts they quote resolved. An item that does not adapt is left out.
 */
export async function fetchPrivateBookmarksPage(
  source: PrivateSource,
  cursor: string | undefined,
): Promise<PrivateBookmarksPage> {
  // A short or empty page with a cursor is followed (feed/paging.ts).
  const page = await fetchUntilItems(async pageCursor => {
    const res = await getPrivateBookmarks(source.prism, {
      limit: PRIVATE_BOOKMARKS_PAGE_LIMIT,
      cursor: pageCursor,
    })
    return {items: res.bookmarks, cursor: res.cursor}
  }, cursor)
  const {views} = await adaptPosts(
    page.items.map(bookmark => ({view: bookmark.item})),
    source.appview,
    () => undefined,
  )
  const bookmarks: PrivateBookmarkView[] = []
  for (const bookmark of page.items) {
    const view = views.get(bookmark.item.uri)
    if (!view) continue
    bookmarks.push({
      createdAt: bookmark.createdAt,
      subject: {uri: bookmark.subject.uri, cid: bookmark.subject.cid},
      item: asBookmarkedItem(view),
    })
  }
  // The page comes back with the private posts its items quote.
  await resolvePrivateQuotes(views.values())
  return {bookmarks, cursor: page.cursor}
}
