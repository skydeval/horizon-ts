/*
 * One page of the reader's private notifications (2H design 10.2, P-9), in
 * the stock grouped shape, so the stock notification rows render it.
 *
 * prism lists notifications from private posts (reply, quote, mention: the
 * private post) and from members' public records naming one of the reader's
 * private posts (like, repost; quote and reply by a public post). Items are
 * checked one by one against the stock notification schema; their authors
 * are merged with public profiles, so the stock moderation sees the public
 * AppView's mute and block state. The page is grouped on the client by the
 * stock grouping (D2-85's limits) and its posts read through prism (private
 * URIs) and the public AppView (`app.bsky.feed.post` URIs).
 *
 * While prism is busy (prism busy design 6.7): each private post the read
 * left out asks the registry. The reader's own suspect post is filled from
 * its cached view (labelled "Syncing"); another author's group drops, as
 * stock drops a group it cannot hydrate. The page is `privateDegraded` when a
 * post was suspect, the read failed transiently or an answer carried
 * `degraded: true`, and carries its completion stamp (`fetchedAt`) for the
 * load gate; `requestedAt` stays the send time for marking seen.
 */

import {logger} from '#/logger'
import {type LoadedGroupedNotificationsPage} from '#/state/queries/notifications/grouped'
import {type Notification} from '#/state/queries/notifications/types'
import {
  buildGroupedPage,
  type PostReader,
} from '#/horizon/notifications/grouped-fallback'
import {
  fetchPublicPosts,
  type PrivateSource,
} from '#/horizon/private/adapt/feed-view'
import {fetchPublicAuthors} from '#/horizon/private/adapt/profiles'
import {
  type AnswerContext,
  listPrivateNotificationsAnswered,
} from '#/horizon/private/api/reads'
import {isTransientPrismError} from '#/horizon/private/api/transient'
import {
  degradedFlags,
  type PrivateDegradedFlags,
} from '#/horizon/private/feed/degraded'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {
  findCachedPrivatePostView,
  isOwnPrivateUri,
  noteOmissions,
} from '#/horizon/private/known'
import {readPrivatePostViewsAnswered} from '#/horizon/private/links'
import {fetchStamp} from '#/horizon/private/load-gate'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {app} from '#/lexicons'

/**
 * A page of the Private view: the stock grouped page with its completion
 * stamp and, while prism is busy, its degraded flag (6.7).
 */
export type PrivateNotificationsPage = LoadedGroupedNotificationsPage & {
  /** When the page's fetch completed (the load gate's stamp, 4.1). */
  fetchedAt?: number
} & PrivateDegradedFlags

/**
 * The Private view's pills. Activity is shown only while prism lists
 * `private.activitySubscriptions` (activity subscriptions design 2.5).
 */
export type PrivateNotificationsTab = 'all' | 'replies' | 'activity'

/**
 * Notifications per prism request.
 */
export const PRIVATE_NOTIFICATIONS_PAGE_SIZE = 50

/**
 * The reasons the Replies pill asks for.
 */
export const REPLY_REASONS = ['reply', 'quote', 'mention']

/**
 * The reasons the Activity pill asks for: new private posts from accounts
 * whose bell is on (activity subscriptions design 2.5).
 */
export const ACTIVITY_REASONS = ['subscribed-post']

/**
 * The reasons the nav badge's private-only count asks for while prism lists
 * `private.activitySubscriptions` (2.6): Bluesky never counts a
 * `subscribed-post` row for a private post either.
 */
export const PRIVATE_ONLY_REASONS = [...REPLY_REASONS, 'subscribed-post']

/**
 * The reasons asked of prism for `tab`; `undefined` asks for every reason.
 */
export function reasonsForTab(
  tab: PrivateNotificationsTab,
): string[] | undefined {
  if (tab === 'replies') return REPLY_REASONS
  if (tab === 'activity') return ACTIVITY_REASONS
  return undefined
}

/**
 * A served item as a stock notification, or `undefined` (logged) when it is
 * not one. `labels` that is not an array is read as none.
 */
export function toNotification(
  item: Record<string, unknown>,
): Notification | undefined {
  const normalised = Array.isArray(item.labels) ? item : {...item, labels: []}
  if (
    app.bsky.notification.listNotifications.notification.matches(normalised)
  ) {
    return normalised
  }
  logger.warn('private notifications: an item was dropped')
  return undefined
}

type PostView = app.bsky.feed.defs.PostView

/** What the page's reads said about the private side (6.7). */
type PageRead = {answers: AnswerContext[]; incomplete: boolean}

/**
 * The reader's own private posts the read left out, filled from their cached
 * views and tagged as such (6.7): another author's are never filled (BR-5).
 */
function ownFromCache(
  did: string,
  uris: readonly string[],
): Map<string, PostView> {
  const qc = getCurrentClients()?.queryClient
  const out = new Map<string, PostView>()
  if (!qc) return out
  for (const uri of uris) {
    if (!isOwnPrivateUri(uri, did)) continue
    const view = findCachedPrivatePostView(qc, uri)
    if (view) out.set(uri, {...view, horizonFromCache: Date.now()} as PostView)
  }
  return out
}

/**
 * The page's post reader: private posts through prism, public posts through
 * the public AppView; any other URI has no view. A private post left out is
 * judged by the registry (6.7): the reader's own suspect is filled from its
 * cached view; a transient failure of the read leaves the private side to
 * the reader's own cached posts and marks the page degraded.
 */
function privatePageReader(source: PrivateSource, read: PageRead): PostReader {
  return async uris => {
    const privateUris = uris.filter(uri => isPrivatePostUri(uri))
    const publicUris = uris.filter(
      uri => !isPrivatePostUri(uri) && uri.includes('/app.bsky.feed.post/'),
    )
    const readPrivate = async (): Promise<Map<string, PostView>> => {
      if (!privateUris.length) return new Map()
      try {
        const {views, answer} = await readPrivatePostViewsAnswered(
          {prismClient: source.prism, appviewClient: source.appview},
          privateUris,
        )
        read.answers.push(answer)
        const verdicts = noteOmissions(answer, privateUris, views.keys())
        const suspects: string[] = []
        verdicts.forEach((verdict, uri) => {
          if (verdict !== 'suspect') return
          read.incomplete = true
          suspects.push(uri)
        })
        return new Map([...views, ...ownFromCache(source.did, suspects)])
      } catch (error) {
        if (!isTransientPrismError(error)) throw error
        read.incomplete = true
        return ownFromCache(source.did, privateUris)
      }
    }
    const [privatePosts, publicPosts] = await Promise.all([
      readPrivate(),
      publicUris.length
        ? fetchPublicPosts(source.appview, publicUris)
        : Promise.resolve(new Map<string, PostView>()),
    ])
    return new Map([...privatePosts, ...publicPosts])
  }
}

/**
 * One load of the Private view for `tab` from `cursor`: prism's pages until
 * one has an item to show (a page can be short or empty and still carry a
 * cursor), grouped and hydrated. The page's cursor is prism's.
 */
export async function fetchPrivateNotificationsPage({
  source,
  tab,
  cursor,
  viewerDid,
  requestedAt,
}: {
  source: PrivateSource
  tab: PrivateNotificationsTab
  cursor: string | undefined
  viewerDid: string | undefined
  requestedAt: number
}): Promise<PrivateNotificationsPage> {
  let seenAt: string | undefined
  const read: PageRead = {answers: [], incomplete: false}
  const loaded = await fetchUntilItems<Notification>(async next => {
    const {body: page, answer} = await listPrivateNotificationsAnswered(
      source.prism,
      {
        limit: PRIVATE_NOTIFICATIONS_PAGE_SIZE,
        cursor: next,
        reasons: reasonsForTab(tab),
      },
    )
    read.answers.push(answer)
    seenAt ??= page.seenAt
    return {
      items: page.notifications
        .map(toNotification)
        .filter((n): n is Notification => !!n),
      cursor: page.cursor,
    }
  }, cursor)

  const profiles = await fetchPublicAuthors(
    source.appview,
    loaded.items.map(n => n.author.did),
  )
  const notifications = loaded.items.map(n => {
    const found = profiles.get(n.author.did)
    if (!found) return n
    const {$type: _type, ...rest} = found
    return {...n, author: {...n.author, ...rest}}
  })

  const page = await buildGroupedPage({
    client: source.appview,
    notifications,
    readPosts: privatePageReader(source, read),
    cursor: loaded.cursor,
    seenAt,
    viewerDid,
    requestedAt,
  })
  return {
    ...page,
    fetchedAt: fetchStamp(),
    ...degradedFlags(read.answers, read.incomplete),
  }
}
