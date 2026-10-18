/*
 * Hand-written schemas for prism's private reads (`app.nearhorizon.private.*`)
 * and `app.nearhorizon.index.requestRecord`, from prism's lexicon files. The
 * private post view's `record` is `unknown` in prism's lexicon, so it is any
 * object here (as generated schemas type `unknown`) and the adapter checks
 * it.
 */

import {l} from '@atproto/lex'

import {app, com} from '#/lexicons'

const NOT_MEMBER_ERRORS = ['NotEnrolled', 'NotReady'] as const

/**
 * `app.nearhorizon.private.defs#privatePostView`, its base fields. The
 * fields prism serves beyond them (counts, `viewer`, `threadgate`,
 * `audience`, `reason`, `embed`) pass through the object schema, which
 * copies undeclared keys unchanged, and are checked one by one where they are
 * adapted, so one malformed field never fails a page.
 */
export const privatePostView = l.object({
  uri: l.string({format: 'at-uri'}),
  cid: l.string({format: 'cid'}),
  author: app.bsky.actor.defs.profileViewBasic,
  /**
   * The decoded `tools.kryphocron.feed.postPrivate` record. `audienceList`
   * may be absent: a self-only post, served only to its owner.
   */
  record: l.lexMap(),
  indexedAt: l.string({format: 'datetime'}),
  labels: l.array(com.atproto.label.defs.label),
})

export type PrivatePostView = l.InferOutput<typeof privatePostView>

/**
 * `app.nearhorizon.private.defs#publicParent`.
 */
export type PublicParent = {
  $type: 'app.nearhorizon.private.defs#publicParent'
  post: app.bsky.feed.defs.PostView
}

/**
 * `app.nearhorizon.private.defs#privateThreadView`. The schema below types
 * the thread as an object only (the type is recursive); its nodes are
 * checked where they are adapted.
 */
export type PrivateThreadView = {
  $type?: 'app.nearhorizon.private.defs#privateThreadView'
  post: PrivatePostView
  parent?: PrivateThreadView | PublicParent | {$type: string}
  replies?: PrivateThreadView[]
}

/**
 * `app.nearhorizon.private.getPosts`: at most 25 URIs; a URI that does not
 * exist or may not be read is omitted.
 */
export const privateGetPosts = l.query(
  'app.nearhorizon.private.getPosts',
  l.params({
    uris: l.array(l.string({format: 'at-uri'}), {minLength: 1, maxLength: 25}),
  }),
  l.jsonPayload({posts: l.array(privatePostView)}),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.getTimeline`: the reader's own private posts and
 * those of the accounts they follow, newest first.
 */
export const privateGetTimeline = l.query(
  'app.nearhorizon.private.getTimeline',
  l.params({
    limit: l.optional(l.integer({minimum: 1, maximum: 50})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    feed: l.array(privatePostView),
    cursor: l.optional(l.string()),
  }),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.getAuthorFeed`. `filter` is the stock author-feed
 * filter (P-20); it is sent only while prism lists `private.paging`.
 */
export const privateGetAuthorFeed = l.query(
  'app.nearhorizon.private.getAuthorFeed',
  l.params({
    actor: l.string({format: 'did'}),
    limit: l.optional(l.integer({minimum: 1, maximum: 50})),
    cursor: l.optional(l.string()),
    filter: l.optional(l.string()),
  }),
  l.jsonPayload({
    feed: l.array(privatePostView),
    cursor: l.optional(l.string()),
  }),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.getPostThread`. `NotFound` is answered alike for
 * a missing anchor and one the reader may not see.
 */
export const privateGetPostThread = l.query(
  'app.nearhorizon.private.getPostThread',
  l.params({
    uri: l.string({format: 'at-uri'}),
    depth: l.optional(l.integer({minimum: 0, maximum: 10})),
    parentHeight: l.optional(l.integer({minimum: 0, maximum: 30})),
  }),
  l.jsonPayload({thread: l.lexMap()}),
  ['NotFound', ...NOT_MEMBER_ERRORS],
)

/**
 * `app.nearhorizon.private.createBookmark` (P-8). Idempotent.
 */
export const privateCreateBookmark = l.procedure(
  'app.nearhorizon.private.createBookmark',
  l.params(),
  l.jsonPayload({
    uri: l.string({format: 'at-uri'}),
    cid: l.string({format: 'cid'}),
  }),
  l.jsonPayload({}),
  ['InvalidRequest', ...NOT_MEMBER_ERRORS],
)

/**
 * `app.nearhorizon.private.deleteBookmark` (P-8). Idempotent.
 * `InvalidRequest`: the URI is not a `postPrivate`.
 */
export const privateDeleteBookmark = l.procedure(
  'app.nearhorizon.private.deleteBookmark',
  l.params(),
  l.jsonPayload({uri: l.string({format: 'at-uri'})}),
  l.jsonPayload({}),
  ['InvalidRequest', ...NOT_MEMBER_ERRORS],
)

/**
 * `app.nearhorizon.private.getBookmarks` (P-8): the reader's private
 * bookmarks, newest first, only posts the reader may read now.
 */
export const privateGetBookmarks = l.query(
  'app.nearhorizon.private.getBookmarks',
  l.params({
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    bookmarks: l.array(
      l.object({
        createdAt: l.string({format: 'datetime'}),
        subject: l.object({
          uri: l.string({format: 'at-uri'}),
          cid: l.string({format: 'cid'}),
        }),
        item: privatePostView,
      }),
    ),
    cursor: l.optional(l.string()),
  }),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.actor.getMembership`: the requester's status (`member`,
 * `indexing`, `notEligible`; others may come) and the private-tier feature
 * families prism serves, whatever the status. Enrolls an eligible caller. A
 * body that does not match (a non-string feature, say) fails as a whole.
 */
export const getMembership = l.query(
  'app.nearhorizon.actor.getMembership',
  l.params(),
  l.jsonPayload({status: l.string(), features: l.array(l.string())}),
  ['RateLimitExceeded'],
)

/**
 * `app.nearhorizon.index.requestRecord`: ask prism to index one record from
 * the caller's own repo now. `caughtUp: true` means every private read
 * sees the record's state (`private.freshIndex`); optional, so an older
 * prism still parses.
 */
export const requestRecord = l.procedure(
  'app.nearhorizon.index.requestRecord',
  l.params(),
  l.jsonPayload({uri: l.string({format: 'at-uri'})}),
  l.jsonPayload({status: l.string(), caughtUp: l.optional(l.boolean())}),
  ['InvalidRequest'],
)

/*
 * The 2H reads (2H design 2.2). Arrays whose items carry `unknown` or differ
 * in shape are typed as maps and each item is checked where it is used, so
 * one malformed item never fails a page.
 */

/**
 * `app.nearhorizon.private.listNotifications` (P-9): the reader's private
 * notifications, newest first, in the stock notification shape. A page may
 * be short or empty and still carry a cursor.
 */
export const privateListNotifications = l.query(
  'app.nearhorizon.private.listNotifications',
  l.params({
    reasons: l.optional(l.array(l.string())),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    notifications: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
    seenAt: l.optional(l.string({format: 'datetime'})),
  }),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.getUnreadCount` (P-9): private notifications newer
 * than the last `updateSeen`.
 */
export const privateGetUnreadCount = l.query(
  'app.nearhorizon.private.getUnreadCount',
  l.params(),
  l.jsonPayload({count: l.integer()}),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.updateSeen` (P-9): the stored time never moves
 * back.
 */
export const privateUpdateSeen = l.procedure(
  'app.nearhorizon.private.updateSeen',
  l.params(),
  l.jsonPayload({seenAt: l.string({format: 'datetime'})}),
  l.jsonPayload({}),
  ['InvalidRequest', ...NOT_MEMBER_ERRORS],
)

/**
 * `app.nearhorizon.private.searchPosts` (P-7): words, each contained in the
 * text, and `from:<did>`; newest first whatever `sort` says. A page may be
 * short or empty and still carry a cursor.
 */
export const privateSearchPosts = l.query(
  'app.nearhorizon.private.searchPosts',
  l.params({
    q: l.string(),
    sort: l.optional(l.string()),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    posts: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
  }),
  NOT_MEMBER_ERRORS,
)

const interactionParams = l.params({
  uri: l.string({format: 'at-uri'}),
  limit: l.optional(l.integer({minimum: 1, maximum: 100})),
  cursor: l.optional(l.string()),
})

/**
 * `app.nearhorizon.private.getLikes` (P-5): members' likes of a private post,
 * newest first, in `app.bsky.feed.getLikes`'s shape.
 */
export const privateGetLikes = l.query(
  'app.nearhorizon.private.getLikes',
  interactionParams,
  l.jsonPayload({
    uri: l.string({format: 'at-uri'}),
    likes: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
  }),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.getRepostedBy` (P-5): members who reposted a
 * private post, in `app.bsky.feed.getRepostedBy`'s shape.
 */
export const privateGetRepostedBy = l.query(
  'app.nearhorizon.private.getRepostedBy',
  interactionParams,
  l.jsonPayload({
    uri: l.string({format: 'at-uri'}),
    repostedBy: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
  }),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.getQuotes` (P-5): private quoting posts as
 * `#privatePostView`, public ones as `#publicPostRef` (each with its
 * `$type`). A page may be short or empty and still carry a cursor.
 */
export const privateGetQuotes = l.query(
  'app.nearhorizon.private.getQuotes',
  interactionParams,
  l.jsonPayload({
    uri: l.string({format: 'at-uri'}),
    posts: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
  }),
  ['InvalidRequest', ...NOT_MEMBER_ERRORS],
)

/**
 * `app.nearhorizon.private.getReplies` (P-6, P-14): the private replies to a
 * private or public post, oldest first, each a thread node expanded `depth`
 * levels. A page may be short or empty and still carry a cursor.
 */
export const privateGetReplies = l.query(
  'app.nearhorizon.private.getReplies',
  l.params({
    uri: l.string({format: 'at-uri'}),
    limit: l.optional(l.integer({minimum: 1, maximum: 50})),
    cursor: l.optional(l.string()),
    depth: l.optional(l.integer({minimum: 0, maximum: 6})),
  }),
  l.jsonPayload({
    replies: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
  }),
  ['InvalidRequest', ...NOT_MEMBER_ERRORS],
)
