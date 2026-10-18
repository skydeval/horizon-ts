/*
 * The redesigned notifications page read through `listNotifications` when
 * `getGroupedNotifications` fails.
 *
 * Bluesky's server answers `getGroupedNotifications` with a 500 when a page
 * holds a notification it cannot hydrate, such as a like or repost of a
 * private post (`tools.kryphocron.feed.postPrivate`), while
 * `listNotifications` answers. So a page whose grouped request fails with a
 * 5xx or a network error is loaded with `listNotifications` instead, grouped
 * on the client by the stock `groupNotifications`, and built into the shape a
 * grouped response has, which the stock `hydratePage` then hydrates, so the
 * page renders unchanged. 4xx answers (auth, bad request) are not retried
 * this way; they reach the screen as before.
 *
 * Paging: the two endpoints' cursors are not interchangeable. A fallback
 * page's cursor is a `listNotifications` cursor with a prefix, so every later
 * page of that list stays on the fallback until the list is refreshed. A
 * refresh starts at the top and tries the grouped request again, unless one
 * failed for the same account and feed in the last
 * {@link FALLBACK_COOLDOWN_MS}, in which case it goes straight to the
 * fallback. A failure past the first page knows only the grouped cursor, so
 * the fallback reads `listNotifications` from the top, skipping what is at or
 * newer than the oldest notification already shown, for at most
 * {@link MAX_SKIP_REQUESTS} requests.
 *
 * Subjects: as in the stock non-grouped path, only `app.bsky.feed.post`
 * subjects are read with `getPosts`; a notification whose subject is a
 * private post has no view, and `hydratePage` drops it, as it drops any group
 * with a missing subject. The private posts the read posts quote are
 * resolved with `resolvePrivateQuotes`, as the stock path does.
 *
 * The page builder (`buildGroupedPage`) is shared with the Private
 * notifications list (2H design 10.2), which reads its posts through prism
 * and the public AppView instead.
 */

import {
  type Client,
  XrpcFetchError,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'
import {AtUri, type AtUriString} from '@atproto/syntax'
import chunk from 'lodash.chunk'

import {isNetworkError} from '#/lib/network-error'
import {logger} from '#/logger'
import {type LoadedGroupedNotificationsPage} from '#/state/queries/notifications/grouped'
import {hydratePage} from '#/state/queries/notifications/grouped/hydrate'
import {isInGroupedFeed} from '#/state/queries/notifications/grouped/membership'
import {type GroupedNotificationsFeed} from '#/state/queries/notifications/grouped/types'
import {
  type FeedNotification,
  type Notification,
} from '#/state/queries/notifications/types'
import {groupNotifications} from '#/state/queries/notifications/util'
import {readReplyRefs} from '#/horizon/private/adapt/feed-view'
import {resolvePrivateQuotes} from '#/horizon/private/quotes/resolve'
import {PP_COLLECTION} from '#/horizon/private/uri'
import {GROUPED_NOTIFICATIONS_FALLBACK} from '#/horizon/switches'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

type OutputBody = app.bsky.notification.getGroupedNotifications.$OutputBody
type Group = app.bsky.notification.getGroupedNotifications.Group
type RelatedView = NonNullable<OutputBody['relatedViews']>[number]
type ProfileView = app.bsky.actor.defs.ProfileView
type PostView = app.bsky.feed.defs.PostView
type GeneratorView = app.bsky.feed.defs.GeneratorView
type StarterPackView = app.bsky.graph.defs.StarterPackViewBasic

/**
 * How long after a failed grouped request a refresh of the same account's
 * feed goes straight to the fallback, so a page that keeps failing costs one
 * failed request per period rather than one per refresh.
 */
export const FALLBACK_COOLDOWN_MS = 5 * 60_000

/**
 * Notifications per `listNotifications` request.
 */
export const LIST_PAGE_SIZE = 50

/**
 * How many `listNotifications` requests a failure past the first page may
 * spend reaching the place the grouped list stopped.
 */
export const MAX_SKIP_REQUESTS = 10

/**
 * Marks a page cursor as a `listNotifications` one.
 */
const CURSOR_PREFIX = 'horizon-list:'

/**
 * How many grouped cursors to remember the position of.
 */
const MAX_POSITIONS = 100

const POST_COLLECTION = 'app.bsky.feed.post'
const GENERATOR_COLLECTION = 'app.bsky.feed.generator'
const STARTER_PACK_COLLECTION = 'app.bsky.graph.starterpack'

/**
 * Where a grouped feed filters by reason, the reasons asked of
 * `listNotifications`; empty asks for every reason. The rest of each feed's
 * filter (`isInGroupedFeed`) is applied on the client.
 */
const FEED_REASONS: Record<GroupedNotificationsFeed, string[]> = {
  all: [],
  'people-i-follow': [],
  followers: ['follow'],
  conversations: ['reply', 'quote', 'mention'],
  activity: ['subscribed-post'],
}

/**
 * When a grouped request last failed, by account and feed.
 */
const failedAt = new Map<string, number>()

/**
 * The oldest notification each grouped page showed, in ms since the epoch,
 * by the cursor that page returned.
 */
const positions = new Map<string, number>()

/**
 * Forgets every failure and position (tests).
 */
export function resetGroupedFallback() {
  failedAt.clear()
  positions.clear()
}

/**
 * Whether a failed grouped request is one the fallback answers: a 5xx, or a
 * request that never got an answer. Not a 4xx, and not a cancelled request.
 */
export function isFallbackError(error: unknown): boolean {
  if (
    error instanceof XrpcResponseError ||
    error instanceof XrpcInvalidResponseError
  ) {
    return error.response.status >= 500
  }
  if (isAbort(error)) return false
  if (error instanceof XrpcFetchError) return true
  return isNetworkError(error)
}

function isAbort(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 5; depth++) {
    if (e instanceof Error && e.name === 'AbortError') return true
    e = (e as {cause?: unknown}).cause
  }
  return false
}

export function isFallbackCursor(cursor: string | undefined): boolean {
  return !!cursor?.startsWith(CURSOR_PREFIX)
}

function toFallbackCursor(cursor: string | undefined) {
  return cursor ? CURSOR_PREFIX + cursor : undefined
}

function failureKey(viewerDid: string | undefined, feed: string) {
  return `${viewerDid ?? ''} ${feed}`
}

export type GroupedPageArgs = {
  client: Client
  feed: GroupedNotificationsFeed
  /**
   * The page's cursor: undefined for the first page, a grouped cursor, or a
   * fallback cursor.
   */
  cursor: string | undefined
  viewerDid: string | undefined
  requestedAt: number
  /**
   * The current time; injectable for tests.
   */
  now?: () => number
}

/**
 * One page of a grouped notifications feed: `fetchGrouped`'s, or the
 * fallback's when the page is on the fallback or `fetchGrouped` fails with a
 * 5xx or a network error.
 */
export async function withGroupedFallback(
  args: GroupedPageArgs,
  fetchGrouped: () => Promise<LoadedGroupedNotificationsPage>,
): Promise<LoadedGroupedNotificationsPage> {
  if (!GROUPED_NOTIFICATIONS_FALLBACK) return fetchGrouped()
  const {cursor, feed, viewerDid, now = Date.now} = args
  if (cursor !== undefined && isFallbackCursor(cursor)) {
    return fetchFallbackPage({
      ...args,
      listCursor: cursor.slice(CURSOR_PREFIX.length),
    })
  }
  const key = failureKey(viewerDid, feed)
  const lastFailure = failedAt.get(key)
  if (
    cursor === undefined &&
    lastFailure !== undefined &&
    now() - lastFailure < FALLBACK_COOLDOWN_MS
  ) {
    logger.info(
      'grouped notifications: on the fallback after a recent failure',
      {
        feed,
      },
    )
    return fetchFallbackPage({...args, listCursor: undefined})
  }
  let page: LoadedGroupedNotificationsPage
  try {
    page = await fetchGrouped()
  } catch (error) {
    if (!isFallbackError(error)) throw error
    failedAt.set(key, now())
    logger.warn(
      'grouped notifications failed; grouping listNotifications on the client',
      {feed, firstPage: cursor === undefined, safeMessage: error},
    )
    if (cursor === undefined) {
      return fetchFallbackPage({...args, listCursor: undefined})
    }
    const before = positions.get(cursor)
    if (before === undefined) throw error
    return fetchFallbackPage({...args, listCursor: undefined, before})
  }
  rememberPosition(page)
  return page
}

function rememberPosition(page: LoadedGroupedNotificationsPage) {
  if (!page.cursor) return
  let oldest: number | undefined
  for (const notification of page.notifications) {
    const at = Date.parse(notification.indexedAt)
    if (!Number.isNaN(at) && at < (oldest ?? Infinity)) oldest = at
  }
  if (oldest === undefined) return
  positions.set(page.cursor, oldest)
  if (positions.size > MAX_POSITIONS) {
    const first = positions.keys().next().value
    if (first !== undefined) positions.delete(first)
  }
}

/**
 * A page of `feed` read with `listNotifications`, grouped on the client, in
 * the shape the grouped query caches.
 */
export async function fetchFallbackPage({
  client,
  feed,
  viewerDid,
  requestedAt,
  listCursor,
  before,
}: GroupedPageArgs & {
  /**
   * The `listNotifications` cursor to read from; undefined for the top.
   */
  listCursor: string | undefined
  /**
   * Leave out notifications indexed at or after this time, in ms since the
   * epoch, reading on from the top until older ones arrive.
   */
  before?: number
}): Promise<LoadedGroupedNotificationsPage> {
  const reasons = FEED_REASONS[feed]
  let data = await listPage(client, listCursor, reasons)
  let notifications = data.notifications
  if (before !== undefined) {
    const isOlder = (n: Notification) => Date.parse(n.indexedAt) < before
    let requests = 1
    while (!data.notifications.some(isOlder) && data.cursor) {
      if (requests >= MAX_SKIP_REQUESTS) {
        logger.warn('grouped notifications fallback: position not reached', {
          feed,
          requests,
        })
        throw new Error(
          'Notifications could not be loaded from where the list stopped',
        )
      }
      data = await listPage(client, data.cursor, reasons)
      requests++
    }
    notifications = data.notifications.filter(isOlder)
  }

  const page = await buildGroupedPage({
    client,
    notifications: notifications.filter(n => isInGroupedFeed(feed, n)),
    readPosts: publicPostReader(client),
    cursor: data.cursor,
    seenAt: data.seenAt,
    viewerDid,
    requestedAt,
  })
  return {...page, cursor: toFallbackCursor(data.cursor)}
}

/**
 * Reads the posts of `uris` a page refers to.
 */
export type PostReader = (uris: string[]) => Promise<Map<string, PostView>>

/**
 * A grouped page built from `listNotifications` items: grouped on the client
 * by the stock `groupNotifications`, the views they refer to read (posts with
 * `readPosts`), the private posts those posts quote resolved, and hydrated by
 * the stock `hydratePage`.
 */
export async function buildGroupedPage({
  client,
  notifications,
  readPosts,
  cursor,
  seenAt,
  viewerDid,
  requestedAt,
}: {
  client: Client
  notifications: Notification[]
  readPosts: PostReader
  cursor: string | undefined
  seenAt: string | undefined
  viewerDid: string | undefined
  requestedAt: number
}): Promise<LoadedGroupedNotificationsPage> {
  const grouped = groupNotifications(notifications)
  const views = await fetchViews(client, grouped, readPosts)
  await resolvePrivateQuotes(views.posts.values())
  const body = toGroupedBody(grouped, views, {
    cursor,
    seenAt: seenAt as OutputBody['seenAt'],
  })
  return {...hydratePage(body, {viewerDid}), requestedAt}
}

/**
 * The public fallback's post reader: `app.bsky.feed.post` URIs only, as the
 * stock `fetchSubjects`, read with `getPosts` 25 at a time.
 */
export function publicPostReader(client: Client): PostReader {
  return async uris => {
    const postUris = uris.filter(uri => collectionOf(uri) === POST_COLLECTION)
    /*
     * Every uri comes from a notification field the server validated as an
     * at-uri, so the branded cast reflects what the values are.
     */
    const posts = await Promise.all(
      chunk(postUris as AtUriString[], 25).map(batch =>
        client
          .call(app.bsky.feed.getPosts, {uris: batch})
          .then(res => res.posts),
      ),
    )
    return new Map(posts.flat().map(post => [post.uri, post]))
  }
}

function listPage(
  client: Client,
  cursor: string | undefined,
  reasons: string[],
) {
  return client.call(app.bsky.notification.listNotifications, {
    limit: LIST_PAGE_SIZE,
    cursor,
    reasons,
  })
}

export type Views = {
  posts: Map<string, PostView>
  generators: Map<string, GeneratorView>
  starterPacks: Map<string, StarterPackView>
}

function collectionOf(uri: string | undefined): string | undefined {
  if (!uri) return undefined
  try {
    return new AtUri(uri).collection
  } catch {
    return undefined
  }
}

/**
 * The post a reply, quote, mention or subscribed post replies to. A private
 * post's record (`tools.kryphocron.feed.postPrivate`) names its parent the
 * same way.
 */
function replyParentUri(notification: Notification): string | undefined {
  const {record} = notification
  if (bsky.isType(app.bsky.feed.post, record)) return record.reply?.parent.uri
  if ((record as {$type?: unknown}).$type === PP_COLLECTION) {
    return readReplyRefs(record)?.parent.uri
  }
  return undefined
}

/**
 * The viewer's repost a like or repost via repost came through.
 */
function viaRepostUri(notification: Notification): string | undefined {
  const {record} = notification
  if (
    bsky.isType(app.bsky.feed.like, record) ||
    bsky.isType(app.bsky.feed.repost, record)
  ) {
    return record.via?.uri ?? notification.reasonSubject
  }
  return notification.reasonSubject
}

function membersOf(item: FeedNotification): Notification[] {
  return [item.notification, ...(item.additional ?? [])]
}

/**
 * Reads the views a page's groups refer to: posts (with `readPosts`; the
 * public fallback reads only `app.bsky.feed.post`, as the stock
 * `fetchSubjects`), feed generators and joined starter packs.
 */
export async function fetchViews(
  client: Client,
  grouped: FeedNotification[],
  readPosts: PostReader,
): Promise<Views> {
  const postUris = new Set<string>()
  const generatorUris = new Set<string>()
  const packUris = new Set<string>()
  const addPost = (uri: string | undefined) => {
    if (uri) postUris.add(uri)
  }
  for (const item of grouped) {
    switch (item.type) {
      case 'post-like':
      case 'repost':
      case 'like-via-repost':
      case 'repost-via-repost':
        addPost(item.subjectUri)
        break
      case 'reply':
      case 'quote':
      case 'mention':
        addPost(item.notification.uri)
        addPost(replyParentUri(item.notification))
        break
      case 'subscribed-post':
        for (const n of membersOf(item)) addPost(n.uri)
        break
      case 'feedgen-like': {
        const uri = item.notification.reasonSubject
        if (uri && collectionOf(uri) === GENERATOR_COLLECTION) {
          generatorUris.add(uri)
        }
        break
      }
      case 'starterpack-joined': {
        const uri = item.notification.reasonSubject
        if (uri && collectionOf(uri) === STARTER_PACK_COLLECTION) {
          packUris.add(uri)
        }
        break
      }
    }
  }
  /*
   * Every uri comes from a notification field the server validated as an
   * at-uri, so the branded cast reflects what the values are.
   */
  const toChunks = (uris: Set<string>) => chunk([...uris] as AtUriString[], 25)
  const [posts, generators, packs] = await Promise.all([
    readPosts([...postUris]),
    Promise.all(
      toChunks(generatorUris).map(feeds =>
        client
          .call(app.bsky.feed.getFeedGenerators, {feeds})
          .then(res => res.feeds),
      ),
    ),
    Promise.all(
      toChunks(packUris).map(uris =>
        client
          .call(app.bsky.graph.getStarterPacks, {uris})
          .then(res => res.starterPacks),
      ),
    ),
  ])
  const views: Views = {
    posts: new Map(),
    generators: new Map(),
    starterPacks: new Map(),
  }
  for (const post of posts.values()) {
    if (bsky.isType(app.bsky.feed.post, post.record)) {
      views.posts.set(post.uri, post)
    }
  }
  for (const generator of generators.flat()) {
    views.generators.set(generator.uri, generator)
  }
  for (const pack of packs.flat()) {
    if (bsky.isType(app.bsky.graph.starterpack, pack.record)) {
      views.starterPacks.set(pack.uri, pack)
    }
  }
  return views
}

/**
 * Builds a `getGroupedNotifications` response from client-side groups and the
 * views they refer to, for the stock `hydratePage`.
 */
export function toGroupedBody(
  grouped: FeedNotification[],
  views: Views,
  data: Pick<OutputBody, 'cursor' | 'seenAt'>,
): OutputBody {
  const profiles = new Map<string, RelatedView>()
  const packs = new Map<string, RelatedView>()
  const addProfile = (profile: ProfileView) => {
    if (!profiles.has(profile.did)) {
      profiles.set(profile.did, {
        ...profile,
        $type: 'app.bsky.actor.defs#profileViewBasic',
      })
    }
  }
  const addPack = (pack: StarterPackView | undefined) => {
    if (pack && !packs.has(pack.uri)) {
      packs.set(pack.uri, {
        ...pack,
        $type: 'app.bsky.graph.defs#starterPackViewBasic',
      })
    }
  }

  const groups: Group[] = []
  for (const item of grouped) {
    const members = membersOf(item)
    for (const n of members) addProfile(n.author)
    const kind = toKind(item, members)
    if (!kind) continue
    if (item.type === 'follow') {
      for (const n of members) addPack(n.starterPack)
    }
    if (item.type === 'starterpack-joined') {
      const uri = item.notification.reasonSubject
      addPack(uri ? views.starterPacks.get(uri) : undefined)
    }
    groups.push({
      $type: 'app.bsky.notification.getGroupedNotifications#group',
      id: item._reactKey,
      kind,
      count: members.length,
      // Unread while any of its notifications is
      isRead: members.every(n => n.isRead),
      indexedAt: item.notification.indexedAt,
    })
  }

  const relatedViews: RelatedView[] = [...profiles.values(), ...packs.values()]
  for (const post of views.posts.values()) {
    relatedViews.push({...post, $type: 'app.bsky.feed.defs#postView'})
  }
  for (const generator of views.generators.values()) {
    relatedViews.push({...generator, $type: 'app.bsky.feed.defs#generatorView'})
  }
  return {
    cursor: data.cursor,
    seenAt: data.seenAt,
    groups,
    relatedViews,
  }
}

/**
 * The grouped kind for one client-side group, or undefined for one the
 * grouped feed has no kind for.
 */
function toKind(
  item: FeedNotification,
  members: Notification[],
): Group['kind'] | undefined {
  const {notification} = item
  const actors = members.map(n => ({actor: n.author.did}))
  const subject = item.subjectUri as AtUriString | undefined
  switch (item.type) {
    case 'post-like':
      if (!subject) return undefined
      return {
        $type: 'app.bsky.notification.getGroupedNotifications#likeGroup',
        post: subject,
        items: actors,
      }
    case 'repost':
      if (!subject) return undefined
      return {
        $type: 'app.bsky.notification.getGroupedNotifications#repostGroup',
        post: subject,
        items: actors,
      }
    case 'like-via-repost':
    case 'repost-via-repost': {
      const viaRepost = viaRepostUri(notification) as AtUriString | undefined
      if (!subject || !viaRepost) return undefined
      return item.type === 'like-via-repost'
        ? {
            $type:
              'app.bsky.notification.getGroupedNotifications#likeViaRepostGroup',
            post: subject,
            viaRepost,
            items: actors,
          }
        : {
            $type:
              'app.bsky.notification.getGroupedNotifications#repostViaRepostGroup',
            post: subject,
            viaRepost,
            items: actors,
          }
    }
    case 'feedgen-like': {
      const generator = notification.reasonSubject
      if (!generator) return undefined
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#generatorLikeGroup',
        generator,
        items: actors,
      }
    }
    case 'follow':
      // The stock grouping keeps a follow-back on its own
      if (notification.author.viewer?.following) {
        return {
          $type:
            'app.bsky.notification.getGroupedNotifications#followBackNotification',
          actor: notification.author.did,
          starterPack: notification.starterPack?.uri,
        }
      }
      return {
        $type: 'app.bsky.notification.getGroupedNotifications#followGroup',
        items: members.map(n => ({
          actor: n.author.did,
          starterPack: n.starterPack?.uri,
        })),
      }
    case 'subscribed-post':
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#subscribedPostGroup',
        items: members.map(n => ({post: n.uri, actor: n.author.did})),
      }
    case 'reply': {
      const parent = (replyParentUri(notification) ??
        notification.reasonSubject) as AtUriString | undefined
      if (!parent) return undefined
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#replyNotification',
        post: notification.uri,
        parent,
      }
    }
    case 'quote':
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#quoteNotification',
        post: notification.uri,
        parent: replyParentUri(notification) as AtUriString | undefined,
      }
    case 'mention':
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#mentionNotification',
        post: notification.uri,
        parent: replyParentUri(notification) as AtUriString | undefined,
      }
    case 'verified':
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#verifiedNotification',
        actor: notification.author.did,
      }
    case 'unverified':
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#unverifiedNotification',
        actor: notification.author.did,
      }
    case 'contact-match':
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#contactMatchNotification',
        actor: notification.author.did,
      }
    case 'starterpack-joined': {
      const starterPack = notification.reasonSubject
      if (!starterPack) return undefined
      return {
        $type:
          'app.bsky.notification.getGroupedNotifications#starterPackJoinedNotification',
        actor: notification.author.did,
        starterPack,
      }
    }
    case 'unknown':
      return undefined
  }
}
