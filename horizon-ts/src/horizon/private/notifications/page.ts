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
import {listPrivateNotifications} from '#/horizon/private/api/reads'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {readPrivatePostViews} from '#/horizon/private/links'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {app} from '#/lexicons'

/**
 * The Private view's pills.
 */
export type PrivateNotificationsTab = 'all' | 'replies'

/**
 * Notifications per prism request.
 */
export const PRIVATE_NOTIFICATIONS_PAGE_SIZE = 50

/**
 * The reasons the Replies pill asks for.
 */
export const REPLY_REASONS = ['reply', 'quote', 'mention']

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

/**
 * The page's post reader: private posts through prism, public posts through
 * the public AppView; any other URI has no view.
 */
function privatePageReader(source: PrivateSource): PostReader {
  return async uris => {
    const privateUris = uris.filter(uri => isPrivatePostUri(uri))
    const publicUris = uris.filter(
      uri => !isPrivatePostUri(uri) && uri.includes('/app.bsky.feed.post/'),
    )
    const [privatePosts, publicPosts] = await Promise.all([
      privateUris.length
        ? readPrivatePostViews(
            {prismClient: source.prism, appviewClient: source.appview},
            privateUris,
          )
        : Promise.resolve(new Map<string, app.bsky.feed.defs.PostView>()),
      publicUris.length
        ? fetchPublicPosts(source.appview, publicUris)
        : Promise.resolve(new Map<string, app.bsky.feed.defs.PostView>()),
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
}): Promise<LoadedGroupedNotificationsPage> {
  let seenAt: string | undefined
  const loaded = await fetchUntilItems<Notification>(async next => {
    const page = await listPrivateNotifications(source.prism, {
      limit: PRIVATE_NOTIFICATIONS_PAGE_SIZE,
      cursor: next,
      reasons: tab === 'replies' ? REPLY_REASONS : undefined,
    })
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

  return buildGroupedPage({
    client: source.appview,
    notifications,
    readPosts: privatePageReader(source),
    cursor: loaded.cursor,
    seenAt,
    viewerDid,
    requestedAt,
  })
}
