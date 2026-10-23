/*
 * The Private view's load gate (prism busy design 6.7, 4.1): on a gated load
 * a notification group whose subject is another author's private post, held
 * in a page fetched before the load began, is hidden until a page fetched
 * since holds it. The reader's own subjects are never gated.
 */

import {type NotificationView} from '#/state/queries/notifications/grouped'
import {isGatedOut} from '#/horizon/private/load-gate'
import {isPrivatePostUri} from '#/horizon/private/uri'

type Post = {uri: string; horizonFromCache?: unknown}

/** The posts a group shows: its subject, its parent, its several posts. */
function postsOf(notification: NotificationView): Post[] {
  const out: Post[] = []
  const n = notification as {
    post?: Post
    posts?: Post[]
    items?: {post?: Post}[]
    parent?: {type?: string; post?: Post}
  }
  if (n.post) out.push(n.post)
  if (Array.isArray(n.posts)) out.push(...n.posts)
  if (Array.isArray(n.items)) {
    for (const item of n.items) if (item.post) out.push(item.post)
  }
  if (n.parent?.type === 'post' && n.parent.post) out.push(n.parent.post)
  return out
}

/** The private post URIs a group shows, for the gated mount's stamp. */
export function notificationPrivateUris(
  notification: NotificationView,
): string[] {
  return postsOf(notification)
    .map(post => post.uri)
    .filter(uri => isPrivatePostUri(uri))
}

/** Whether a gated load hides `notification`, from a page stamped `stamp`. */
export function isNotificationGatedOut(
  did: string,
  notification: NotificationView,
  stamp: number | undefined,
  loadSince: number | undefined,
): boolean {
  if (loadSince === undefined) return false
  return postsOf(notification).some(post =>
    isGatedOut(
      did,
      {
        uri: post.uri,
        horizonFromCache:
          typeof post.horizonFromCache === 'number'
            ? post.horizonFromCache
            : undefined,
      },
      stamp,
      loadSince,
    ),
  )
}

type Page = {notifications: NotificationView[]; fetchedAt?: number}

/**
 * The pages with every group a gated load hides removed, and how many. A page
 * with nothing removed is returned as it is.
 */
export function gateNotificationPages<P extends Page>(
  pages: readonly P[],
  did: string | undefined,
  loadSince: number | undefined,
): {pages: P[]; hidden: number} {
  if (!did || loadSince === undefined) return {pages: [...pages], hidden: 0}
  let hidden = 0
  const out = pages.map(page => {
    const kept = page.notifications.filter(
      n => !isNotificationGatedOut(did, n, page.fetchedAt, loadSince),
    )
    if (kept.length === page.notifications.length) return page
    hidden += page.notifications.length - kept.length
    return {...page, notifications: kept}
  })
  return {pages: out, hidden}
}
