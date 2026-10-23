/*
 * Private views in batches: the author merge (6.1.1), reply refs whose `cid`
 * prism omitted (rows indexed before its migration 0002) filled from the
 * referenced post, and feed items with their reply context hydrated (6.2), so
 * Following does not drop a private reply as an orphan. A view prism serves
 * as a member's repost of the post (`reason: #reasonRepost`, 2H design 6)
 * becomes a stock repost item; the same post can come as itself and as one
 * or more reposts.
 */

import {type $Typed, type Client} from '@atproto/lex'
import {type AtUriString} from '@atproto/syntax'

import {logger} from '#/logger'
import {
  embedViewFromRecord,
  recordQuoteUri,
  recordUsesPdsBlobs,
  withRecordPresentation,
} from '#/horizon/private/adapt/embed-view'
import {authorPdsUrl} from '#/horizon/private/adapt/pds'
import {
  type PrivateViewInput,
  toPostView,
} from '#/horizon/private/adapt/post-view'
import {fetchPublicAuthors, mergeAuthor} from '#/horizon/private/adapt/profiles'
import {getPrivatePosts} from '#/horizon/private/api/reads'
import {getPendingPost, type PendingPost} from '#/horizon/private/store'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

const GET_POSTS_BATCH = 25

/**
 * One private view to adapt, with what the adapter cannot read from it.
 */
export type AdaptInput = {
  view: PrivateViewInput
  /**
   * An embed view the caller already has (a pending post's, built at write
   * time). Without it the view prism serves is used (P-1), else one is built
   * from the record (6.1.3).
   */
  embed?: app.bsky.feed.defs.PostView['embed']
  isPending?: boolean
}

/**
 * The clients a batch reads with: prism for private refs, the public AppView
 * for public refs and the author merge.
 */
export type AdaptClients = {prism: Client; appview: Client}

/**
 * A member's private feed source, as `usePrivateFeedSource` returns it.
 */
export type PrivateSource = AdaptClients & {did: string}

type RawRef = {uri: string; cid?: string}

type ReplyRefs = {root: RawRef; parent: RawRef}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRef(value: unknown): RawRef | undefined {
  if (!isObject(value) || typeof value.uri !== 'string') return undefined
  return {
    uri: value.uri,
    cid: typeof value.cid === 'string' && value.cid ? value.cid : undefined,
  }
}

/**
 * The reply refs a served private record names, read loosely: prism's record
 * is `unknown` in its lexicon.
 */
export function readReplyRefs(record: unknown): ReplyRefs | undefined {
  if (!isObject(record) || !isObject(record.reply)) return undefined
  const root = readRef(record.reply.root)
  const parent = readRef(record.reply.parent)
  return root && parent ? {root, parent} : undefined
}

/**
 * The repost reason prism serves on a feed view (`reason`, a stock
 * `#reasonRepost` without `cid`), when it matches the stock schema.
 */
export function repostReasonOf(
  view: PrivateViewInput,
): app.bsky.feed.defs.ReasonRepost | undefined {
  const reason = (view as PrivateViewInput & {reason?: unknown}).reason
  if (reason === undefined) return undefined
  return app.bsky.feed.defs.reasonRepost.matches(reason) ? reason : undefined
}

/**
 * Whether a feed view is the post's own item: it carries no `reason`.
 */
export function isOwnItem(view: PrivateViewInput): boolean {
  return (view as PrivateViewInput & {reason?: unknown}).reason === undefined
}

/**
 * A pending post as adapter input: the record as sent, its stored CID and the
 * embed view the write path built.
 */
export function pendingAsInput(entry: PendingPost): AdaptInput {
  return {
    view: {
      uri: entry.uri,
      cid: entry.cid,
      author: entry.postView.author,
      record: entry.record,
      indexedAt: entry.createdAt,
      labels: [],
    },
    embed: entry.postView.embed,
    isPending: true,
  }
}

/**
 * `record` with each reply ref's missing `cid` filled by `cidOf`. `complete`
 * is false when a ref still has none.
 */
function fillReplyCids(
  record: unknown,
  cidOf: (uri: string) => string | undefined,
): {record: unknown; complete: boolean} {
  const refs = readReplyRefs(record)
  if (!refs || !isObject(record)) return {record, complete: true}
  if (refs.root.cid && refs.parent.cid) return {record, complete: true}
  const root = {uri: refs.root.uri, cid: refs.root.cid ?? cidOf(refs.root.uri)}
  const parent = {
    uri: refs.parent.uri,
    cid: refs.parent.cid ?? cidOf(refs.parent.uri),
  }
  return {
    record: {...record, reply: {root, parent}},
    complete: !!root.cid && !!parent.cid,
  }
}

/**
 * The embed view prism serves on a private view (P-1), when it carries one in
 * a stock view shape, with the record's video `presentation` that prism's
 * video view leaves out.
 */
function servedEmbed(
  view: PrivateViewInput,
): app.bsky.feed.defs.PostView['embed'] | undefined {
  const embed = (view as PrivateViewInput & {embed?: unknown}).embed
  if (!isObject(embed) || typeof embed.$type !== 'string') return undefined
  if (!/^app\.bsky\.embed\.[A-Za-z]+#view$/.test(embed.$type)) return undefined
  return withRecordPresentation(
    embed as NonNullable<app.bsky.feed.defs.PostView['embed']>,
    view.record,
  )
}

/**
 * What building record embeds needs for a batch (6.1.3): the PDS of each
 * author whose embed shows blobs, and the public posts the batch quotes.
 */
async function embedContext(
  inputs: AdaptInput[],
  appview: Client,
): Promise<{
  pdsUrls: Map<string, string | undefined>
  quoteViews: Map<string, app.bsky.feed.defs.PostView>
}> {
  const pdsDids = new Set<string>()
  const quoteUris = new Set<string>()
  for (const input of inputs) {
    if (input.embed || servedEmbed(input.view)) continue
    const record = input.view.record
    if (recordUsesPdsBlobs(record)) pdsDids.add(input.view.author.did)
    const quoted = recordQuoteUri(record)
    if (quoted && !isPrivatePostUri(quoted)) quoteUris.add(quoted)
  }
  const [pdsEntries, quoteViews] = await Promise.all([
    Promise.all(
      Array.from(pdsDids, async did => [did, await authorPdsUrl(did)] as const),
    ),
    quoteUris.size
      ? fetchPublicPosts(appview, quoteUris)
      : Promise.resolve(new Map<string, app.bsky.feed.defs.PostView>()),
  ])
  return {pdsUrls: new Map(pdsEntries), quoteViews}
}

/**
 * Adapt private views with the author merge. Each reply ref without a `cid`
 * is filled from `cidOf`; a view whose refs stay incomplete is still adapted
 * and named in `incomplete`, for the caller to drop or keep. A view without
 * an embed view gets one built from its record (6.1.3).
 *
 * `authors` is the author merge's profile fetch when the caller started it
 * already (alongside the read that gave `inputs`); it must cover every
 * author of `inputs`.
 */
export async function adaptPosts(
  inputs: AdaptInput[],
  appview: Client,
  cidOf: (uri: string) => string | undefined,
  {
    authors: startedAuthors,
  }: {
    authors?: Promise<Map<string, app.bsky.actor.defs.ProfileViewBasic>>
  } = {},
): Promise<{
  views: Map<string, app.bsky.feed.defs.PostView>
  incomplete: Set<string>
}> {
  const [authors, embeds] = await Promise.all([
    startedAuthors ??
      fetchPublicAuthors(
        appview,
        inputs.map(input => input.view.author.did),
      ),
    embedContext(inputs, appview),
  ])
  const views = new Map<string, app.bsky.feed.defs.PostView>()
  const incomplete = new Set<string>()
  for (const input of inputs) {
    if (views.has(input.view.uri)) continue
    const filled = fillReplyCids(input.view.record, cidOf)
    if (!filled.complete) incomplete.add(input.view.uri)
    const authorDid = input.view.author.did
    const embed =
      input.embed ??
      servedEmbed(input.view) ??
      embedViewFromRecord(input.view.record, {
        authorDid,
        pdsUrl: embeds.pdsUrls.get(authorDid),
        quoteViews: embeds.quoteViews,
      })
    const post = toPostView(
      {...input.view, record: filled.record},
      {
        embed,
        isPending: input.isPending,
        author: mergeAuthor(input.view.author, authors),
      },
    )
    if (post) views.set(post.uri, post)
  }
  return {views, incomplete}
}

/**
 * Public posts by URI from the public AppView, 25 at a time. A URI it does
 * not return, or one whose batch failed, is absent. With `strict` (Thread
 * Lens's public-view pass, Phase 4 design 6.2) a failed batch rethrows
 * instead, since an absent URI there means "unavailable", not "unknown".
 */
export async function fetchPublicPosts(
  appview: Client,
  uris: Iterable<string>,
  {strict = false}: {strict?: boolean} = {},
): Promise<Map<string, app.bsky.feed.defs.PostView>> {
  const unique = Array.from(new Set(uris))
  const found = new Map<string, app.bsky.feed.defs.PostView>()
  const batches: string[][] = []
  for (let i = 0; i < unique.length; i += GET_POSTS_BATCH) {
    batches.push(unique.slice(i, i + GET_POSTS_BATCH))
  }
  await Promise.all(
    batches.map(async batch => {
      try {
        const res = await appview.call(app.bsky.feed.getPosts, {
          uris: batch as AtUriString[],
        })
        for (const post of res.posts) found.set(post.uri, post)
      } catch (error) {
        if (strict) throw error
        logger.warn('private replies: public parents unavailable', {
          safeMessage: error,
        })
      }
    }),
  )
  return found
}

/**
 * The private views prism serves for `uris`, or none when the read fails.
 */
async function fetchPrivateRefs(
  prism: Client,
  uris: string[],
): Promise<AdaptInput[]> {
  if (uris.length === 0) return []
  try {
    const posts = await getPrivatePosts(prism, uris)
    return posts.map(view => ({view}))
  } catch (error) {
    logger.warn('private replies: private parents unavailable', {
      safeMessage: error,
    })
    return []
  }
}

function notFound(uri: string): $Typed<app.bsky.feed.defs.NotFoundPost> {
  return {
    $type: 'app.bsky.feed.defs#notFoundPost',
    uri: uri as AtUriString,
    notFound: true,
  }
}

function asRefView(
  post: app.bsky.feed.defs.PostView,
): $Typed<app.bsky.feed.defs.PostView> {
  return {...post, $type: 'app.bsky.feed.defs#postView'}
}

/**
 * Feed items for private views, in order, with the reply context of each
 * private reply hydrated: private parents and roots through prism (or the
 * batch itself, or the current account's pending posts), public ones through
 * the public AppView, and either becomes `notFoundPost` when it is not
 * returned. A repost view becomes a repost item, its reposter merged with the
 * public profile. One public profile fetch covers every post author and
 * reposter of the batch. An item whose record still lacks a reply `cid`,
 * whose adapted record is not a valid post record, or whose `reason` does not
 * match the stock repost reason, is dropped.
 */
export async function toFeedViewPosts(
  inputs: AdaptInput[],
  {prism, appview}: AdaptClients,
): Promise<app.bsky.feed.defs.FeedViewPost[]> {
  const inBatch = new Map<string, AdaptInput>()
  for (const input of inputs) {
    if (!inBatch.has(input.view.uri)) inBatch.set(input.view.uri, input)
  }

  const privateRefs = new Set<string>()
  const publicRefs = new Set<string>()
  for (const input of inputs) {
    const refs = readReplyRefs(input.view.record)
    if (!refs) continue
    for (const ref of [refs.parent, refs.root]) {
      if (isPrivatePostUri(ref.uri)) {
        if (!inBatch.has(ref.uri)) privateRefs.add(ref.uri)
      } else {
        publicRefs.add(ref.uri)
      }
    }
  }

  const pendingRefs: AdaptInput[] = []
  const toFetch: string[] = []
  for (const uri of privateRefs) {
    const pending = getPendingPost(uri)
    if (pending) pendingRefs.push(pendingAsInput(pending))
    else toFetch.push(uri)
  }

  const [fetchedRefs, publicPosts] = await Promise.all([
    fetchPrivateRefs(prism, toFetch),
    publicRefs.size
      ? fetchPublicPosts(appview, publicRefs)
      : Promise.resolve(new Map<string, app.bsky.feed.defs.PostView>()),
  ])

  const allPrivate = [...inBatch.values(), ...pendingRefs, ...fetchedRefs]
  const privateCids = new Map<string, string>()
  for (const input of allPrivate) {
    privateCids.set(input.view.uri, input.view.cid)
  }
  const cidOf = (uri: string) =>
    privateCids.get(uri) ?? publicPosts.get(uri)?.cid

  const reposters = inputs
    .map(input => repostReasonOf(input.view)?.by.did)
    .filter((did): did is NonNullable<typeof did> => !!did)
  const authors = fetchPublicAuthors(appview, [
    ...allPrivate.map(input => input.view.author.did),
    ...reposters,
  ])
  const {views, incomplete} = await adaptPosts(allPrivate, appview, cidOf, {
    authors,
  })
  const shownAuthors = await authors

  const refView = (uri: string) => {
    const post = isPrivatePostUri(uri) ? views.get(uri) : publicPosts.get(uri)
    return post ? asRefView(post) : notFound(uri)
  }

  const items: app.bsky.feed.defs.FeedViewPost[] = []
  for (const input of inputs) {
    const uri = input.view.uri
    const post = views.get(uri)
    if (!post) continue
    const reason = repostReasonOf(input.view)
    if (!reason && !isOwnItem(input.view)) {
      // Kept as a plain post it would show at the repost's place.
      logger.warn('private feed item dropped: unexpected reason', {uri})
      continue
    }
    if (incomplete.has(uri)) {
      logger.warn('private post dropped: a reply ref has no cid', {uri})
      continue
    }
    if (!bsky.matches(app.bsky.feed.post, post.record)) {
      logger.warn('private post dropped: not a valid post record', {uri})
      continue
    }
    const refs = readReplyRefs(input.view.record)
    const item: app.bsky.feed.defs.FeedViewPost = refs
      ? {
          post,
          reply: {
            root: refView(refs.root.uri),
            parent: refView(refs.parent.uri),
          },
        }
      : {post}
    if (reason) {
      item.reason = {
        ...reason,
        $type: 'app.bsky.feed.defs#reasonRepost',
        by: mergeAuthor(reason.by, shownAuthors),
      }
    }
    items.push(item)
  }
  return items
}
