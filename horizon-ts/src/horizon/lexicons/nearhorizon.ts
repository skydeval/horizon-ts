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
 * `private.activitySubscriptions` (activity subscriptions design 2.5): left
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
 * Private appearance (appearance storage choice design, section 3; the prism
 * handoff `prism-private-appearance.md`), behind `private.appearance`. The
 * value is an `app.nearhorizon.actor.appearance` record value, `$type`
 * included: `unknown` in prism's lexicon (a record def can't be a `ref`
 * target), any map here, parsed leniently by `appearance/record.ts`.
 * `store` is a known-values string; a value Horizon doesn't know is read as
 * unanswered (`appearance/prism.ts`). Every field of the answer is optional:
 * with no row, prism answers `{}`.
 *
 * Errors as prism's lexicons declare them: these methods skip readiness, so
 * they answer `NotEnrolled` but never `NotReady` or `Reindexing` (prism's
 * reply). `InvalidRequest` includes the 16 KiB cap on the value.
 */
const APPEARANCE_ERRORS = ['NotEnrolled'] as const

const privateAppearanceAnswer = {
  store: l.optional(
    l.string<{knownValues: ['private', 'public', 'device']}>({maxLength: 32}),
  ),
  appearance: l.optional(l.lexMap()),
  rev: l.optional(l.string()),
  migratedAt: l.optional(l.string()),
  /*
   * Present when the row was kept after a removal (removed members design,
   * section 3; prism `private.appearanceRetention`): answered only with
   * `includeRetained`, never the live choice. Horizon reads only its
   * presence.
   */
  retainedUntil: l.optional(l.string()),
}

/**
 * `app.nearhorizon.private.getAppearance`: the reader's own row. With
 * `includeRetained`, a row kept after a removal is answered to its owner,
 * member or not, marked `retainedUntil`; without it, never.
 */
export const privateGetAppearance = l.query(
  'app.nearhorizon.private.getAppearance',
  l.params({includeRetained: l.optional(l.boolean())}),
  l.jsonPayload(privateAppearanceAnswer),
  APPEARANCE_ERRORS,
)

/**
 * `app.nearhorizon.private.releaseAppearance`: delete the row kept after a
 * removal, if `rev` is its `rev`. `{}` also with no kept row (released,
 * expired or never kept). `InvalidSwap` only for a kept row with another
 * `rev`; `InvalidRequest` to a current member. No `NotEnrolled`: prism
 * serves it to non-members.
 */
export const privateReleaseAppearance = l.procedure(
  'app.nearhorizon.private.releaseAppearance',
  l.params(),
  l.jsonPayload({rev: l.string()}),
  l.jsonPayload({}),
  ['InvalidRequest', 'InvalidSwap'],
)

/**
 * `app.nearhorizon.private.putAppearance`: a whole-value replace, swapped
 * on `swapRev` (`''`: only if there is no row). `appearance` is required
 * with `private` and `public` and refused with `device`. Answers as get,
 * after the write.
 */
export const privatePutAppearance = l.procedure(
  'app.nearhorizon.private.putAppearance',
  l.params(),
  l.jsonPayload({
    store: l.string<{knownValues: ['private', 'public', 'device']}>({
      maxLength: 32,
    }),
    appearance: l.optional(l.lexMap()),
    swapRev: l.optional(l.string()),
  }),
  l.jsonPayload(privateAppearanceAnswer),
  ['InvalidRequest', 'InvalidSwap', ...APPEARANCE_ERRORS],
)

/*
 * Activity subscriptions for private posts (activity subscriptions design
 * section 3, PR-AS-1; the prism handoff, section 2): Bluesky's shapes for
 * prism's own store. The flags are stock
 * `app.bsky.notification.defs#activitySubscription`.
 */

/**
 * `app.nearhorizon.private.putActivitySubscription`: the stock put's shape.
 * Both flags false deletes the row. `LimitReached`: the cap of rows. The
 * output carries the accepted flags, none after an off.
 */
export const privatePutActivitySubscription = l.procedure(
  'app.nearhorizon.private.putActivitySubscription',
  l.params(),
  l.jsonPayload({
    subject: l.string({format: 'did'}),
    activitySubscription: app.bsky.notification.defs.activitySubscription,
  }),
  l.jsonPayload({
    subject: l.string({format: 'did'}),
    activitySubscription: l.optional(
      app.bsky.notification.defs.activitySubscription,
    ),
  }),
  ['InvalidRequest', 'LimitReached', ...NOT_MEMBER_ERRORS],
)

/**
 * `app.nearhorizon.private.listActivitySubscriptions`: the caller's rows,
 * most recently changed first, each `{subject, activitySubscription}` (no
 * profile views, unlike Bluesky's list).
 */
export const privateListActivitySubscriptions = l.query(
  'app.nearhorizon.private.listActivitySubscriptions',
  l.params({
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    cursor: l.optional(l.string()),
    subscriptions: l.array(
      l.object({
        subject: l.string({format: 'did'}),
        activitySubscription: app.bsky.notification.defs.activitySubscription,
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

/*
 * Thread Lens (Phase 4 design 5.4), from prism's
 * `lexicons/app/nearhorizon/threadLens/*.json`. Both are procedures: `POST`
 * with a JSON body, through the account's PDS. `nodes` and `items` are
 * unions of `#postNode` and `#gapNode`; they are typed as maps here and each
 * node is checked where it is read (`thread-lens/nodes.ts`), so one
 * malformed node never fails a response. `bridging` and `gap` are open
 * sets, so plain strings. `truncated` is optional: nothing reads it, and a
 * response without it should not fail as a whole.
 */

/** The errors both Thread Lens methods declare. */
const THREAD_LENS_ERRORS = [
  'InvalidRequest',
  'NotEnrolled',
  'NotReady',
  'Reindexing',
] as const

/**
 * `app.nearhorizon.threadLens.getThread`: the thread around `anchor` for
 * the caller, the parent chain root-most first, the anchor, then replies
 * level by level. `depth` defaults to 6 and `parentHeight` to 80 on prism.
 */
export const threadLensGetThread = l.procedure(
  'app.nearhorizon.threadLens.getThread',
  l.params(),
  l.jsonPayload({
    anchor: l.string({format: 'at-uri'}),
    depth: l.optional(l.integer({minimum: 0, maximum: 1000})),
    parentHeight: l.optional(l.integer({minimum: 0, maximum: 1000})),
    repliesCursor: l.optional(l.string({maxLength: 1024})),
  }),
  l.jsonPayload({
    anchor: l.string(),
    nodes: l.array(l.lexMap()),
    truncated: l.optional(l.boolean()),
    bridging: l.string(),
  }),
  THREAD_LENS_ERRORS,
)

/**
 * `app.nearhorizon.threadLens.resolve`: one item per URI, in input order,
 * at most 25. Items carry no continuation markers and no `parentUri`.
 */
export const threadLensResolve = l.procedure(
  'app.nearhorizon.threadLens.resolve',
  l.params(),
  l.jsonPayload({
    uris: l.array(l.string({format: 'at-uri'}), {minLength: 1, maxLength: 25}),
  }),
  l.jsonPayload({
    items: l.array(l.lexMap()),
    bridging: l.string(),
  }),
  THREAD_LENS_ERRORS,
)

/*
 * Pronouns and plural systems (Phase 5 design 4.1, 4.2). The four records
 * are from the pronouns and plural specs (`app.nearhorizon.actor.pronouns`,
 * `app.nearhorizon.plural.{system,member,front}`), and the fronters object
 * (`app.nearhorizon.plural.fronters`) is Horizon's spec addition, also kept
 * as a lexicon document beside this file (`plural-fronters.json`). The
 * schemas type writes and tests; reads parse leniently
 * (`identity/parse.ts`), so one bad field never loses the others. A
 * member's `color` pattern (`^#[0-9A-Fa-f]{6}$`) is checked by the parser
 * and the editors, since string schemas carry no pattern.
 *
 * prism's two reads (S-2), from prism's
 * `lexicons/app/nearhorizon/plural/{defs,getRecords,listMembers}.json`.
 * Each answer carries an `unknown` value, so answers are typed as maps and
 * each one is checked where it is read (`identity/reads.ts`), so one
 * malformed answer never fails a call.
 */

export const PRONOUNS_COLLECTION = 'app.nearhorizon.actor.pronouns'
export const PLURAL_SYSTEM_COLLECTION = 'app.nearhorizon.plural.system'
export const PLURAL_MEMBER_COLLECTION = 'app.nearhorizon.plural.member'
export const PLURAL_FRONT_COLLECTION = 'app.nearhorizon.plural.front'

/** The rkey of the pronouns, system and front records. */
export const PLURAL_SELF_RKEY = 'self'

/**
 * The top-level key a post record carries its fronters under, on
 * `app.bsky.feed.post` and `tools.kryphocron.feed.postPrivate` alike
 * (PP-1). Readers that do not know it ignore it.
 */
export const PLURAL_FRONTERS_KEY = 'app.nearhorizon.plural.fronters'

/** `app.nearhorizon.actor.pronouns#pronounSet`. */
const pronounSet = l.object({
  forms: l.array(l.string({maxLength: 64, maxGraphemes: 24}), {
    minLength: 1,
    maxLength: 12,
  }),
})

/**
 * `app.nearhorizon.actor.pronouns`, rkey `self`. `displayMode` absent or
 * unknown reads as `all`; empty `sets` shows nothing and blocks Bluesky's
 * short field (pronouns spec, "Empty sets").
 */
export const pronounsRecord = l.record(
  'literal:self',
  PRONOUNS_COLLECTION,
  l.object({
    sets: l.array(pronounSet, {maxLength: 10}),
    displayMode: l.optional(l.string<{knownValues: ['all', 'firstOnly']}>()),
    createdAt: l.string({format: 'datetime'}),
    updatedAt: l.optional(l.string({format: 'datetime'})),
  }),
)

export type PronounsRecord = l.InferInput<typeof pronounsRecord>

/** `app.nearhorizon.plural.system`, rkey `self`: the record is the signal. */
export const pluralSystemRecord = l.record(
  'literal:self',
  PLURAL_SYSTEM_COLLECTION,
  l.object({
    name: l.optional(l.string({maxLength: 640, maxGraphemes: 64})),
    description: l.optional(l.string({maxLength: 2560, maxGraphemes: 256})),
    collectiveNoun: l.optional(l.string({maxLength: 320, maxGraphemes: 32})),
    memberCount: l.optional(l.string({maxLength: 64, maxGraphemes: 16})),
    createdAt: l.optional(l.string({format: 'datetime'})),
    updatedAt: l.optional(l.string({format: 'datetime'})),
  }),
)

export type PluralSystemRecord = l.InferInput<typeof pluralSystemRecord>

/** `app.nearhorizon.plural.member#pronounSet`: the member lexicon's limits. */
const memberPronounSet = l.object({
  forms: l.array(l.string({maxLength: 240, maxGraphemes: 24}), {
    maxLength: 6,
  }),
})

/** `app.nearhorizon.plural.member#proxyRef`. */
const proxyRef = l.object({
  id: l.string(),
  note: l.optional(l.string({maxLength: 640, maxGraphemes: 64})),
})

const memberImage = l.blob({
  accept: ['image/png', 'image/jpeg'],
  maxSize: 1_000_000,
})

/**
 * `app.nearhorizon.plural.member`. The lexicon's key is `any`; Horizon
 * creates TIDs (PP-18).
 */
export const pluralMemberRecord = l.record(
  'any',
  PLURAL_MEMBER_COLLECTION,
  l.object({
    displayName: l.string({maxLength: 640, maxGraphemes: 64}),
    description: l.optional(l.string({maxLength: 2560, maxGraphemes: 256})),
    emoji: l.optional(l.string({maxLength: 16, maxGraphemes: 4})),
    color: l.optional(l.string({maxLength: 7})),
    pronouns: l.optional(l.array(memberPronounSet, {maxLength: 6})),
    roles: l.optional(
      l.array(l.string({maxLength: 320, maxGraphemes: 32}), {maxLength: 10}),
    ),
    memberTypes: l.optional(
      l.array(l.string({maxLength: 320, maxGraphemes: 32}), {maxLength: 5}),
    ),
    agePresentation: l.optional(l.string({maxLength: 320, maxGraphemes: 32})),
    proxy: l.optional(proxyRef),
    avatar: l.optional(memberImage),
    banner: l.optional(memberImage),
    createdAt: l.optional(l.string({format: 'datetime'})),
    updatedAt: l.optional(l.string({format: 'datetime'})),
  }),
)

export type PluralMemberRecord = l.InferInput<typeof pluralMemberRecord>

/**
 * `app.nearhorizon.plural.front#frontMember`: a member by rkey; `status`
 * `engaging` or absent means fronting.
 */
export const frontMember = l.object({
  id: l.string(),
  status: l.optional(l.string({maxLength: 320, maxGraphemes: 32})),
})

/** `app.nearhorizon.plural.front`, rkey `self`. */
export const pluralFrontRecord = l.record(
  'literal:self',
  PLURAL_FRONT_COLLECTION,
  l.object({
    members: l.array(frontMember, {maxLength: 20}),
    state: l.optional(l.string({maxLength: 320, maxGraphemes: 32})),
    comment: l.optional(l.string({maxLength: 2560, maxGraphemes: 256})),
    setAt: l.string({format: 'datetime'}),
  }),
)

export type PluralFrontRecord = l.InferInput<typeof pluralFrontRecord>

/**
 * `app.nearhorizon.plural.fronters` (Phase 5 design 4.2, Horizon's spec
 * addition): the members who wrote a post, by rkey in the author's own
 * repo, 1 to 20 `#frontMember` entries. Horizon writes no `status`.
 */
export const pluralFronters = l.object({
  members: l.array(frontMember, {minLength: 1, maxLength: 20}),
})

export type PluralFronters = l.InferInput<typeof pluralFronters>

/** The errors both S-2 reads declare (prism's lexicons). */
const PLURAL_READ_ERRORS = [
  'InvalidRequest',
  'RateLimitExceeded',
  'MethodNotImplemented',
] as const

/**
 * `app.nearhorizon.plural.getRecords`: for each DID in `actors` its
 * `#actorRecords` (pronouns, system and front, each an `#answer`), and an
 * `#memberAnswer` for each member URI. At most 50 accounts (the actors and
 * the member URIs' DIDs together) and 100 member URIs per call.
 */
export const pluralGetRecords = l.query(
  'app.nearhorizon.plural.getRecords',
  l.params({
    actors: l.optional(l.array(l.string({format: 'did'}), {maxLength: 50})),
    members: l.optional(
      l.array(l.string({format: 'at-uri'}), {maxLength: 100}),
    ),
  }),
  l.jsonPayload({
    actors: l.array(l.lexMap()),
    members: l.array(l.lexMap()),
  }),
  PLURAL_READ_ERRORS,
)

/**
 * `app.nearhorizon.plural.listMembers`: one account's member records in
 * ascending rkey order (`#memberView`). `status` is `complete`, `partial`
 * (prism cannot promise every member is listed) or `unknown` (not listed
 * yet; members empty). prism's default `limit` is 50.
 */
export const pluralListMembers = l.query(
  'app.nearhorizon.plural.listMembers',
  l.params({
    actor: l.string({format: 'did'}),
    limit: l.optional(l.integer({minimum: 1, maximum: 100})),
    cursor: l.optional(l.string()),
  }),
  l.jsonPayload({
    actor: l.string(),
    status: l.string<{knownValues: ['complete', 'partial', 'unknown']}>(),
    members: l.array(l.lexMap()),
    cursor: l.optional(l.string()),
  }),
  PLURAL_READ_ERRORS,
)
