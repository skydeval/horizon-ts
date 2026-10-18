/*
 * A private post as `app.bsky.feed.defs#postView`, which every stock renderer
 * takes: the record converted, the author as given (the batch adapters pass
 * the public-profile merge, 6.1.1), the counts, the reader's viewer state and
 * the root's threadgate when prism serves them (2H design 5.1: a field is
 * used when present and well formed), `viewer.pinned` for the account's own
 * pinned post, and the post's facts written to the side store (with
 * `countsServed` and the audience prism serves). Reply context (6.2) is
 * layered on by the feed and thread adapters.
 */

import {
  type AtUriString,
  type DatetimeString,
  type DidString,
  type UriString,
} from '@atproto/syntax'

import {logger} from '#/logger'
import {
  privateSelfLabelValues,
  toBskyRecord,
} from '#/horizon/private/adapt/record'
import {privateGatesServed} from '#/horizon/private/server-support'
import {type ServedAudience, setPrivatePostFacts} from '#/horizon/private/store'
import {isAudienceUri} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {app, type com} from '#/lexicons'

/**
 * The fields of a prism private post view the adapter reads. A pending post
 * is built in the same shape from the record as sent.
 */
export type PrivateViewInput = {
  uri: string
  cid: string
  author: app.bsky.actor.defs.ProfileViewBasic
  record: unknown
  indexedAt: string
  labels?: com.atproto.label.defs.Label[]
}

/**
 * The fields prism serves beyond the base view (P-2, P-3, P-18), each
 * checked before use.
 */
type ServedState = {
  likeCount?: unknown
  repostCount?: unknown
  replyCount?: unknown
  quoteCount?: unknown
  viewer?: unknown
  threadgate?: unknown
  audience?: unknown
}

function audienceOf(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const audience = (record as {audienceList?: unknown}).audienceList
  return typeof audience === 'string' ? audience : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/**
 * The four counts, only when all four are served well formed.
 */
function servedCounts(served: ServedState) {
  const replyCount = count(served.replyCount)
  const repostCount = count(served.repostCount)
  const likeCount = count(served.likeCount)
  const quoteCount = count(served.quoteCount)
  if (
    replyCount === undefined ||
    repostCount === undefined ||
    likeCount === undefined ||
    quoteCount === undefined
  ) {
    return undefined
  }
  return {replyCount, repostCount, likeCount, quoteCount}
}

/**
 * The reader's viewer state as prism serves it, field by field; other keys
 * (`pinned`, `knownLikers`) are left out (`pinned` is Horizon's).
 */
function servedViewer(value: unknown): app.bsky.feed.defs.ViewerState {
  const viewer: app.bsky.feed.defs.ViewerState = {}
  if (typeof value !== 'object' || value === null) return viewer
  const served = value as Record<string, unknown>
  const isAtUri = (v: unknown): v is AtUriString =>
    typeof v === 'string' && v.startsWith('at://')
  if (typeof served.bookmarked === 'boolean') {
    viewer.bookmarked = served.bookmarked
  }
  if (isAtUri(served.like)) viewer.like = served.like
  if (isAtUri(served.repost)) viewer.repost = served.repost
  if (typeof served.threadMuted === 'boolean') {
    viewer.threadMuted = served.threadMuted
  }
  if (typeof served.replyDisabled === 'boolean') {
    viewer.replyDisabled = served.replyDisabled
  }
  if (typeof served.embeddingDisabled === 'boolean') {
    viewer.embeddingDisabled = served.embeddingDisabled
  }
  return viewer
}

/**
 * The audience prism serves, when it is an audience URI with optional
 * string `mode` and `name`.
 */
function servedAudienceOf(value: unknown): ServedAudience | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const {uri, mode, name} = value as Record<string, unknown>
  if (typeof uri !== 'string' || !isAudienceUri(uri)) return undefined
  if (mode !== undefined && typeof mode !== 'string') return undefined
  if (name !== undefined && typeof name !== 'string') return undefined
  const audience: ServedAudience = {uri}
  if (mode !== undefined) audience.mode = mode
  if (name !== undefined) audience.name = name
  return audience
}

/*
 * The profile query's key, as `RQKEY` in `#/state/queries/profile` builds it.
 * Spelled out because importing that module pulls the session into the
 * non-React private modules (the link resolver and the post query load this
 * one).
 */
function profileQueryKey(did: string) {
  return ['profile', did]
}

/**
 * The URI of the current account's own pinned post, from its cached profile.
 */
function ownPinnedUri(authorDid: string): string | undefined {
  const current = getCurrentClients()
  if (!current || current.did !== authorDid || !current.queryClient) {
    return undefined
  }
  const profile =
    current.queryClient.getQueryData<app.bsky.actor.defs.ProfileViewDetailed>(
      profileQueryKey(authorDid),
    )
  return profile?.pinnedPost?.uri
}

/**
 * The view's labels with the record's self-labels (K-1) added as the
 * author's own labels, as the public AppView puts a post's self-labels on
 * its view, so the stock moderation hides or warns as the author asked.
 * prism may serve them already (P-1); a value it serves is not repeated.
 */
function withSelfLabels(
  view: PrivateViewInput,
  authorDid: string,
): com.atproto.label.defs.Label[] {
  const labels = view.labels ?? []
  const values = privateSelfLabelValues(view.record)
  if (values.length === 0) return labels
  const served = new Set(
    labels.filter(label => label.src === authorDid).map(label => label.val),
  )
  const createdAt = (view.record as {createdAt?: unknown}).createdAt
  const cts = (
    typeof createdAt === 'string' ? createdAt : view.indexedAt
  ) as DatetimeString
  const added: com.atproto.label.defs.Label[] = values
    .filter(val => !served.has(val))
    .map(val => ({
      src: authorDid as DidString,
      uri: view.uri as UriString,
      cid: view.cid,
      val,
      cts,
    }))
  return [...labels, ...added]
}

/**
 * Adapt one private view. Returns `undefined`, and logs, when its record is
 * not a private post record with string text.
 */
export function toPostView(
  view: PrivateViewInput,
  {
    embed,
    isPending = false,
    author,
  }: {
    embed?: app.bsky.feed.defs.PostView['embed']
    isPending?: boolean
    /** The author to show, when the caller merged the public profile. */
    author?: app.bsky.actor.defs.ProfileViewBasic
  } = {},
): app.bsky.feed.defs.PostView | undefined {
  const record = toBskyRecord(view.record)
  if (!record) {
    logger.warn('private post view dropped: unexpected record shape', {
      uri: view.uri,
    })
    return undefined
  }
  const served = view as PrivateViewInput & ServedState
  const counts = isPending ? undefined : servedCounts(served)
  const servedAudience = isPending
    ? undefined
    : servedAudienceOf(served.audience)
  setPrivatePostFacts(view.uri, {
    audienceUri: audienceOf(view.record),
    isPending,
    ...(counts ? {countsServed: true} : {}),
    ...(servedAudience ? {servedAudience} : {}),
  })
  const shownAuthor = author ?? view.author
  const viewer = isPending ? {} : servedViewer(served.viewer)
  /*
   * prism computes `embeddingDisabled` per post from its own postgate, so
   * with the gates served its absence means allowed.
   */
  if (
    !isPending &&
    viewer.embeddingDisabled === undefined &&
    privateGatesServed()
  ) {
    viewer.embeddingDisabled = false
  }
  if (ownPinnedUri(shownAuthor.did) === view.uri) viewer.pinned = true
  const postView: app.bsky.feed.defs.PostView = {
    $type: 'app.bsky.feed.defs#postView',
    uri: view.uri as AtUriString,
    cid: view.cid,
    author: shownAuthor,
    record,
    indexedAt: view.indexedAt as DatetimeString,
    labels: withSelfLabels(view, shownAuthor.did),
    viewer,
  }
  if (counts) {
    postView.replyCount = counts.replyCount
    postView.repostCount = counts.repostCount
    postView.likeCount = counts.likeCount
    postView.quoteCount = counts.quoteCount
  }
  if (
    !isPending &&
    served.threadgate !== undefined &&
    app.bsky.feed.defs.threadgateView.matches(served.threadgate)
  ) {
    postView.threadgate = served.threadgate
  }
  if (embed) postView.embed = embed
  return postView
}
