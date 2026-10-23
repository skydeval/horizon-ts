/*
 * Hand-written schemas for prism's private reads (`app.nearhorizon.private.*`)
 * and `app.nearhorizon.index.requestRecord`, from prism's lexicon files. The
 * private post view's `record` is `unknown` in prism's lexicon, so it is any
 * object here (as generated schemas type `unknown`) and the adapter checks
 * it.
 */

import {l} from '@atproto/lex'

import {app, com} from '#/lexicons'

/**
 * The account-level errors every private method declares. `Reindexing`
 * (`private.reindexing`, prism busy design 7): a member being re-indexed
 * after an interruption, a 503 with `retryAfter` in the body; it never moves
 * membership (BR-1), unlike `NotReady` from the probe.
 */
const NOT_MEMBER_ERRORS = ['NotEnrolled', 'NotReady', 'Reindexing'] as const

/**
 * `app.nearhorizon.private.defs#unavailablePost` (`private.degraded`): one
 * of the reader's own private posts an answer read and could not serve yet.
 * `reason` is `syncing` or `indexing`; others may come.
 */
export const unavailablePost = l.object({
  uri: l.string({format: 'at-uri'}),
  reason: l.string<{knownValues: ['syncing', 'indexing']}>(),
})

export type UnavailablePost = l.InferOutput<typeof unavailablePost>

/**
 * `app.nearhorizon.private.defs#viewUnavailable` (`private.degraded`): a
 * quoted private post prism cannot show yet, in a post view's
 * `embed.record`, in place of `app.bsky.embed.record#viewNotFound`. Not a
 * statement that the post is gone.
 */
export const viewUnavailable = l.object({
  uri: l.string({format: 'at-uri'}),
  unavailable: l.boolean(),
  retryAfter: l.integer(),
})

export const VIEW_UNAVAILABLE_TYPE =
  'app.nearhorizon.private.defs#viewUnavailable'

/**
 * The top-level fields of the eleven listed answers (`private.degraded`,
 * prism busy design 7): `degraded` (true while prism is behind, never
 * `false`), `retryAfter` (seconds, with `degraded`) and `unavailable` (the
 * reader's own posts it could not serve yet, `#unavailablePost`). Each item
 * of `unavailable` is a map, checked where it is read (`api/degraded.ts`),
 * and `retryAfter` takes any integer, so one odd value never fails a page.
 */
const answerSignals = {
  degraded: l.optional(l.boolean()),
  retryAfter: l.optional(l.integer()),
  unavailable: l.optional(l.array(l.lexMap())),
}

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
  l.jsonPayload({posts: l.array(privatePostView), ...answerSignals}),
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
    ...answerSignals,
  }),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.getAuthorFeed`. `filter` is the stock author-feed
 * filter (P-20); `posts_and_author_threads` and `posts_with_replies` are
 * sent only while prism lists `private.paging`, `posts_with_media` (images
 * and galleries, a quote with them included, no video) and
 * `posts_with_video` (video, a quote with video included) only while it
 * lists `private.mediaFilters` (P-30). Reposts are left out of the media
 * filters. Any other value is a 400.
 */
export const privateGetAuthorFeed = l.query(
  'app.nearhorizon.private.getAuthorFeed',
  l.params({
    actor: l.string({format: 'did'}),
    limit: l.optional(l.integer({minimum: 1, maximum: 50})),
    cursor: l.optional(l.string()),
    filter: l.optional(
      l.string<{
        knownValues: [
          'posts_and_author_threads',
          'posts_with_replies',
          'posts_with_media',
          'posts_with_video',
        ]
      }>(),
    ),
  }),
  l.jsonPayload({
    feed: l.array(privatePostView),
    cursor: l.optional(l.string()),
    ...answerSignals,
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
  l.jsonPayload({thread: l.lexMap(), ...answerSignals}),
  ['NotFound', 'Unavailable', ...NOT_MEMBER_ERRORS],
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
    ...answerSignals,
  }),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.actor.getMembership`: the requester's status (`member`,
 * `indexing`, `reindexing`, `notEligible`; others may come) and the
 * private-tier feature families prism serves, whatever the status. Enrolls
 * an eligible caller. A body that does not match (a non-string feature, say)
 * fails as a whole. `permissions` (fast reads) is a map whose values are
 * checked where they are read (`privateIndexed`, 2K design PA-1a), so an
 * unknown or odd value never fails the answer; an older prism sends none.
 * `reindexing` (`private.reindexing`): a member re-indexed after an
 * interruption, with a member's permissions; `validForSecs` (and
 * `Retry-After`) is then the retry interval (prism busy design 2.3).
 */
export const getMembership = l.query(
  'app.nearhorizon.actor.getMembership',
  l.params(),
  l.jsonPayload({
    status: l.string<{
      knownValues: ['member', 'indexing', 'reindexing', 'notEligible']
    }>(),
    features: l.array(l.string()),
    permissions: l.optional(l.lexMap()),
    validForSecs: l.optional(l.integer()),
  }),
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
    ...answerSignals,
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
 * One reason's private notification preference: stock
 * `app.bsky.notification.defs#filterablePreference`. `push` is stored but
 * has no effect while there is no private push.
 */
export const privateNotificationPreference = l.object({
  include: l.string<{knownValues: ['all', 'follows']}>(),
  list: l.boolean(),
  push: l.boolean(),
})

/**
 * The reasons a private notification has (prism, 2026-10-21), and
 * `subscribedPost` (stock `#preference`, no `include`), which prism adds with
 * `private.activitySubscriptions` (activity subscriptions design 2.7): left
 * optional so an answer without it still parses.
 */
const privateNotificationPreferences = l.object({
  like: privateNotificationPreference,
  mention: privateNotificationPreference,
  quote: privateNotificationPreference,
  reply: privateNotificationPreference,
  repost: privateNotificationPreference,
  subscribedPost: l.optional(app.bsky.notification.defs.preference),
})

/**
 * `app.nearhorizon.private.getNotificationPreferences`: the reader's own,
 * every reason present, each `{include: 'all', list: true, push: true}`
 * until changed.
 */
export const privateGetNotificationPreferences = l.query(
  'app.nearhorizon.private.getNotificationPreferences',
  l.params(),
  l.jsonPayload({preferences: privateNotificationPreferences}),
  NOT_MEMBER_ERRORS,
)

/**
 * `app.nearhorizon.private.putNotificationPreferences`: stock V2
 * semantics, each reason sent replaces that reason's whole object and the
 * others are kept; returns the full preferences after the write.
 */
export const privatePutNotificationPreferences = l.procedure(
  'app.nearhorizon.private.putNotificationPreferences',
  l.params(),
  l.jsonPayload({
    like: l.optional(privateNotificationPreference),
    mention: l.optional(privateNotificationPreference),
    quote: l.optional(privateNotificationPreference),
    reply: l.optional(privateNotificationPreference),
    repost: l.optional(privateNotificationPreference),
    subscribedPost: l.optional(app.bsky.notification.defs.preference),
  }),
  l.jsonPayload({preferences: privateNotificationPreferences}),
  ['InvalidRequest', ...NOT_MEMBER_ERRORS],
)

/*
 * Activity subscriptions for private posts (activity subscriptions design
 * 2.9; the prism handoff, section 2). The flags are stock
 * `app.bsky.notification.defs#activitySubscription`.
 */

/**
 * `app.nearhorizon.private.putActivitySubscription`: mirrors the stock put.
 * Both flags false keeps an off row with a time (left out of the list).
 * `ifNotChangedSince` is sent by the reconcile only: a row changed after it
 * is refused with `Conflict` and left unchanged. `LimitReached`: the cap of
 * active rows. The output has no flags after an off.
 */
export const privatePutActivitySubscription = l.procedure(
  'app.nearhorizon.private.putActivitySubscription',
  l.params(),
  l.jsonPayload({
    subject: l.string({format: 'did'}),
    activitySubscription: app.bsky.notification.defs.activitySubscription,
    ifNotChangedSince: l.optional(l.string({format: 'datetime'})),
  }),
  l.jsonPayload({
    subject: l.string({format: 'did'}),
    activitySubscription: l.optional(
      app.bsky.notification.defs.activitySubscription,
    ),
  }),
  ['InvalidRequest', 'Conflict', 'LimitReached', ...NOT_MEMBER_ERRORS],
)

/**
 * `app.nearhorizon.private.listActivitySubscriptions`: the caller's rows with
 * a flag on, most recently changed first. `asOf` is the database's time when
 * the page was read, the clock `updatedAt` is stamped with.
 */
export const privateListActivitySubscriptions = l.query(
  'app.nearhorizon.private.listActivitySubscriptions',
  l.params({
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    asOf: l.string({format: 'datetime'}),
    cursor: l.optional(l.string()),
    subscriptions: l.array(
      l.object({
        subject: l.string({format: 'did'}),
        activitySubscription: app.bsky.notification.defs.activitySubscription,
        updatedAt: l.string({format: 'datetime'}),
      }),
    ),
  }),
  NOT_MEMBER_ERRORS,
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
    ...answerSignals,
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
    ...answerSignals,
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
    ...answerSignals,
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
    ...answerSignals,
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
    ...answerSignals,
  }),
  ['InvalidRequest', ...NOT_MEMBER_ERRORS],
)
