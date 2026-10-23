/*
 * `spliceRestoredReplies` (refract client design 4.2 step 2 and 3, RF-B5b):
 * the pure merge of a stock thread with the replies Bluesky drops. Its
 * inputs are the `getReplies` posts (RF-S7's children included), the
 * reader's own replies under restored parents, and the filled hidden parents
 * and root. Stock items keep their order; the posts placed are the
 * restored-post store's objects, so shadows and placeholders reach them.
 *
 * - Only visible post items count as "on screen". A stock
 *   `threadItemNotFound` with the same URI is replaced by the restored post;
 *   a `threadItemBlocked` is kept (RF-7).
 * - Each remaining post is placed under its parent when that parent is the
 *   anchor, a descendant on screen, or another placed post, at the parent's
 *   depth plus one. Past `below`, or over the branching factor below the
 *   first level, it is counted into the parent's "more replies". Anything
 *   else is dropped. URIs are deduped.
 * - Siblings: for `newest` and `oldest`, restored replies interleave with
 *   stock's by time; for ranked sorts they go after stock's siblings, by like
 *   count and then time.
 *
 * Wiring this into the thread hook waits on Thread Lens 4C (same hook); the
 * function and its tests stand alone.
 */

import {postItem} from '#/horizon/private/thread/fetch'
import {orderSiblings} from '#/horizon/refract/thread/anchor'
import {type app} from '#/lexicons'

type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem
type PostView = app.bsky.feed.defs.PostView

const POST = 'app.bsky.unspecced.defs#threadItemPost'
const NOT_FOUND = 'app.bsky.unspecced.defs#threadItemNotFound'

export type SpliceInputs = {
  /** `getReplies` posts, newest first as prism sends them. */
  replies: readonly PostView[]
  /** The reader's own replies under restored parents (5.6). */
  ownReplies: readonly PostView[]
  /** Filled hidden parents and root (step 3). */
  parents: readonly PostView[]
}

export type SpliceOptions = {
  below: number
  branchingFactor: number
  sort?: string
}

type Node = {
  item: ThreadItem
  children: Node[]
  placed: boolean
}

function parentUriOf(post: PostView): string | undefined {
  const reply = (post.record as {reply?: {parent?: {uri?: unknown}}})?.reply
  const uri = reply?.parent?.uri
  return typeof uri === 'string' ? uri : undefined
}

function createdAt(post: PostView): number {
  const value = (post.record as {createdAt?: unknown} | undefined)?.createdAt
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

function postOf(node: Node): PostView | undefined {
  const value = node.item.value as {$type?: string; post?: PostView}
  return value.$type === POST ? value.post : undefined
}

function addMore(node: Node, count: number) {
  const value = node.item.value as {$type?: string; moreReplies?: number}
  if (value.$type !== POST) return
  node.item = {
    ...node.item,
    value: {
      ...(node.item.value as object),
      moreReplies: (value.moreReplies ?? 0) + count,
    } as ThreadItem['value'],
  }
}

/** Merge stock children (in their order) with placed ones by time. */
function interleave(stock: Node[], placed: Node[], newest: boolean): Node[] {
  const out: Node[] = []
  let i = 0
  let j = 0
  const time = (node: Node) => {
    const post = postOf(node)
    return post ? createdAt(post) : 0
  }
  while (i < stock.length || j < placed.length) {
    if (j >= placed.length) out.push(stock[i++])
    else if (i >= stock.length) out.push(placed[j++])
    else {
      const placedFirst = newest
        ? time(placed[j]) > time(stock[i])
        : time(placed[j]) < time(stock[i])
      out.push(placedFirst ? placed[j++] : stock[i++])
    }
  }
  return out
}

/**
 * Merge the restored inputs into the stock thread's items (4.2). Returns
 * the stock items unchanged when nothing is placed.
 */
export function spliceRestoredReplies(
  stockItems: readonly ThreadItem[],
  inputs: SpliceInputs,
  {below, branchingFactor, sort}: SpliceOptions,
): ThreadItem[] {
  const onScreen = new Set(
    stockItems
      .filter(item => item.value.$type === POST)
      .map(item => item.uri as string),
  )
  // Step 3 and same-URI replacements: a not-found item becomes the post.
  const byUri = new Map<string, PostView>()
  for (const post of [
    ...inputs.parents,
    ...inputs.replies,
    ...inputs.ownReplies,
  ]) {
    if (!byUri.has(post.uri)) byUri.set(post.uri, post)
  }
  const items = stockItems.map(item => {
    if (item.value.$type !== NOT_FOUND) return item
    const post = byUri.get(item.uri)
    if (!post) return item
    onScreen.add(post.uri)
    return postItem(post, item.depth, {})
  })

  // The anchor's subtree as a tree; parents above it stay in front.
  const head = items.filter(item => item.depth < 0)
  const roots: Node[] = []
  const stack: Node[] = []
  const nodes = new Map<string, Node>()
  for (const item of items) {
    if (item.depth < 0) continue
    const node: Node = {item, children: [], placed: false}
    while (
      stack.length > 0 &&
      stack[stack.length - 1].item.depth >= item.depth
    ) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
    if (item.value.$type === POST) nodes.set(item.uri, node)
  }

  // Place the rest: repeat while a pass places something (chains).
  const pending = [...inputs.replies, ...inputs.ownReplies].filter(
    (post, index, all) =>
      !onScreen.has(post.uri) &&
      all.findIndex(other => other.uri === post.uri) === index,
  )
  const placedChildren = new Map<Node, Node[]>()
  let progress = true
  const remaining = new Set(pending)
  while (progress && remaining.size > 0) {
    progress = false
    for (const post of Array.from(remaining)) {
      const parentUri = parentUriOf(post)
      const parent = parentUri ? nodes.get(parentUri) : undefined
      if (!parent) continue
      remaining.delete(post)
      progress = true
      const depth = parent.item.depth + 1
      const node: Node = {
        item: postItem(post, depth, {}),
        children: [],
        placed: true,
      }
      nodes.set(post.uri, node)
      const list = placedChildren.get(parent) ?? []
      list.push(node)
      placedChildren.set(parent, list)
    }
  }

  if (placedChildren.size === 0 && items === stockItems) return [...stockItems]

  const ranked = sort !== 'newest' && sort !== 'oldest'
  const flat: ThreadItem[] = [...head]
  const emit = (node: Node) => {
    let children = node.children
    const extra = placedChildren.get(node)
    if (extra && extra.length > 0) {
      const ordered = orderSiblings(extra, child => postOf(child)!, sort)
      children = ranked
        ? [...children, ...ordered]
        : interleave(children, ordered, sort === 'newest')
      const depth = node.item.depth + 1
      const limit = node.item.depth === 0 ? Infinity : branchingFactor
      const kept: Node[] = []
      let over = 0
      let count = 0
      for (const child of children) {
        if (!child.placed) {
          kept.push(child)
          count++
          continue
        }
        if (depth > below || count >= limit) {
          over++
          continue
        }
        kept.push(child)
        count++
      }
      if (over > 0) addMore(node, over)
      children = kept
    }
    flat.push(node.item)
    children.forEach(emit)
  }
  roots.forEach(emit)
  return flat
}
