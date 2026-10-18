/*
 * The private posts a page quotes and has not hydrated: what `PrivateQuote`
 * would otherwise read one by one after the page renders. A quote is a
 * record embed view (alone, or the record of a quote with media) whose record
 * is not a hydrated `#viewRecord` and whose URI is a private post, whether
 * the quoting post came from the public AppView or was adapted from prism.
 * Quotes inside quotes are not collected; the stock embed does not show them
 * in a feed.
 */

import {isPrivateRead} from '#/horizon/private/uri'
import {type app} from '#/lexicons'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unhydratedPrivateUri(recordView: unknown): string | undefined {
  if (!isObject(recordView) || !isObject(recordView.record)) return undefined
  const record = recordView.record
  if (record.$type === 'app.bsky.embed.record#viewRecord') return undefined
  const uri = record.uri
  return typeof uri === 'string' && isPrivateRead(uri) ? uri : undefined
}

/**
 * The private post an embed view quotes without hydrating it, if any.
 */
export function privateQuoteUriOf(embed: unknown): string | undefined {
  if (!isObject(embed)) return undefined
  if (embed.$type === 'app.bsky.embed.record#view') {
    return unhydratedPrivateUri(embed)
  }
  if (embed.$type === 'app.bsky.embed.recordWithMedia#view') {
    return unhydratedPrivateUri(embed.record)
  }
  return undefined
}

/**
 * Every private post `posts` quote without hydrating, once each, in order.
 */
export function privateQuoteUris(
  posts: Iterable<app.bsky.feed.defs.PostView | undefined>,
): string[] {
  const uris = new Set<string>()
  for (const post of posts) {
    const uri = privateQuoteUriOf(post?.embed)
    if (uri) uris.add(uri)
  }
  return Array.from(uris)
}

function asPostView(value: unknown): app.bsky.feed.defs.PostView | undefined {
  return isObject(value) && value.$type === 'app.bsky.feed.defs#postView'
    ? (value as app.bsky.feed.defs.PostView)
    : undefined
}

/**
 * The posts a page of feed items renders: each item's post and, for a reply,
 * its parent and root.
 */
export function* feedItemPosts(
  feed: readonly app.bsky.feed.defs.FeedViewPost[],
): Generator<app.bsky.feed.defs.PostView> {
  for (const item of feed) {
    yield item.post
    const parent = asPostView(item.reply?.parent)
    if (parent) yield parent
    const root = asPostView(item.reply?.root)
    if (root) yield root
  }
}

/**
 * The posts of a thread's items.
 */
export function* threadItemPosts(
  thread: readonly {value: unknown}[],
): Generator<app.bsky.feed.defs.PostView> {
  for (const item of thread) {
    const value = item.value
    if (
      isObject(value) &&
      value.$type === 'app.bsky.unspecced.defs#threadItemPost' &&
      isObject(value.post)
    ) {
      yield value.post as app.bsky.feed.defs.PostView
    }
  }
}
