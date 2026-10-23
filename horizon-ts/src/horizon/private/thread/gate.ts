/*
 * The load gate on a thread's items (prism busy design 4.1, 6.1, BR10-L4): pure
 * functions over the stock thread items, kept apart from the thread's hook
 * (`busy.ts`) so they load without the stock thread cache.
 */

import {isOwnAbsent, isOwnPrivateUri} from '#/horizon/private/known'
import {fetchStamp, isGatedOut} from '#/horizon/private/load-gate'
import {unavailableItem} from '#/horizon/private/thread/fetch'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** The thread's (or the further replies') completion stamp, as written. */
export type Stamped = {horizonFetchedAt?: number}

/** The stamp the thread query's `queryFn` puts on its result (4.1). */
export function threadStamp(): Stamped {
  return {horizonFetchedAt: fetchStamp()}
}

/** The post of a thread item, when it shows one. */
export function postOf(item: {value: unknown}): PostView | undefined {
  const value = item.value as {$type?: unknown; post?: unknown}
  return value?.$type === 'app.bsky.unspecced.defs#threadItemPost'
    ? (value.post as PostView)
    : undefined
}

/** The private post URIs of a thread's items. */
export function threadPrivateUris(items: readonly {value: unknown}[]): string[] {
  const uris: string[] = []
  for (const item of items) {
    const uri = postOf(item)?.uri
    if (uri && isPrivatePostUri(uri)) uris.push(uri)
  }
  return uris
}

/**
 * A thread's items as a gated load shows them (4.1, BR10-L4), and how many it
 * hid: another author's private post fetched before `loadSince` (by the
 * item's own `horizonFromCache`, else the data's `stamp`) becomes the quiet
 * item at the anchor or above (`pending` while the load's fetch runs, so the
 * skeleton shows), and is left out with its replies below. The reader's own
 * post the PDS says is gone becomes the stock not-found item (the tombstone).
 */
export function gateThreadItems<I extends {uri: string; depth: number; value: unknown}>(
  items: readonly I[],
  did: string | undefined,
  stamp: number | undefined,
  loadSince: number | undefined,
  {pending = false}: {pending?: boolean} = {},
): {items: I[]; hidden: number} {
  if (!did) return {items: [...items], hidden: 0}
  const out: I[] = []
  let hidden = 0
  let dropBelow: number | undefined
  for (const item of items) {
    if (dropBelow !== undefined && item.depth > dropBelow) continue
    dropBelow = undefined
    const post = postOf(item)
    const uri = post?.uri
    if (!post || !uri || !isPrivatePostUri(uri)) {
      out.push(item)
      continue
    }
    if (isOwnPrivateUri(uri, did)) {
      out.push(
        isOwnAbsent(did, uri)
          ? ({
              ...item,
              value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'},
            })
          : item,
      )
      continue
    }
    const carried = (post as {horizonFromCache?: unknown}).horizonFromCache
    if (
      isGatedOut(
        did,
        {
          uri,
          horizonFromCache: typeof carried === 'number' ? carried : undefined,
        },
        stamp,
        loadSince,
      )
    ) {
      hidden++
      if (item.depth <= 0) {
        out.push({...item, ...unavailableItem(uri, item.depth, {pending})})
      } else {
        dropBelow = item.depth
      }
      continue
    }
    out.push(item)
  }
  return {items: out, hidden}
}

/**
 * The further replies' items as a gated load shows them (6.1, BR13-L3):
 * stamped apart, judged against the thread's `loadSince`.
 */
export function gateOtherReplies<I extends {uri: string; depth: number; value: unknown}>(
  items: readonly I[],
  did: string | undefined,
  stamp: number | undefined,
  loadSince: number | undefined,
): I[] {
  return gateThreadItems(items, did, stamp, loadSince).items
}
