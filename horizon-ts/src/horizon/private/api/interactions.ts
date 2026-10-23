/*
 * The likes, reposts and quotes lists of a private post (2H design 8, P-5),
 * each in the stock output shape so the stock list queries and screens take
 * them unchanged (List 1-3).
 *
 * prism lists members only (C-2): a like or repost by an account that is not
 * a member is not listed, as it is not counted. Each listed account is
 * merged with its public profile, so follow state and moderation are the
 * public AppView's (as for authors, 6.1.1).
 *
 * Nothing is asked for a reader who is not a signed-in member, or while
 * prism does not list `private.interactions`: the list is empty.
 *
 * While prism is busy (prism busy design 4.1, BR11-N6) each page carries its
 * completion stamp (`fetchedAt`), and the lists are gated: every row of a
 * likes or reposts list whose subject is another author's private post, none
 * under the reader's own; the quotes list's private quoting posts of other
 * authors.
 */

import {type AtUriString} from '@atproto/syntax'

import {logger} from '#/logger'
import {
  type PrivatePostView,
  privatePostView,
} from '#/horizon/lexicons/nearhorizon'
import {adaptPosts, fetchPublicPosts} from '#/horizon/private/adapt/feed-view'
import {fetchPublicAuthors} from '#/horizon/private/adapt/profiles'
import {
  getPrivateLikes,
  getPrivateQuotes,
  getPrivateRepostedBy,
} from '#/horizon/private/api/reads'
import {fetchUntilItems} from '#/horizon/private/feed/paging'
import {memberClients} from '#/horizon/private/links'
import {fetchStamp, type PageAccess} from '#/horizon/private/load-gate'
import {resolvePrivateQuotes} from '#/horizon/private/quotes/resolve'
import {privateInteractionsServed} from '#/horizon/private/server-support'
import {type CurrentClients} from '#/horizon/routing/current-clients'
import {app} from '#/lexicons'

type Like = app.bsky.feed.getLikes.Like
type ProfileView = app.bsky.actor.defs.ProfileView
type PostView = app.bsky.feed.defs.PostView

const PRIVATE_VIEW = 'app.nearhorizon.private.defs#privatePostView'
const PUBLIC_REF = 'app.nearhorizon.private.defs#publicPostRef'

/**
 * The member's clients when the lists are served; else `undefined` (signed
 * out included), and nothing is asked.
 */
function listClients(): CurrentClients | undefined {
  let clients: CurrentClients | undefined
  try {
    clients = memberClients()
  } catch {
    return undefined
  }
  if (!clients || !privateInteractionsServed()) return undefined
  return clients
}

/**
 * `actor` with its public profile laid over it, when the AppView returned
 * one.
 */
function withPublicProfile(
  actor: ProfileView,
  publicProfiles: Map<string, app.bsky.actor.defs.ProfileViewBasic>,
): ProfileView {
  const found = publicProfiles.get(actor.did)
  if (!found) return actor
  const {$type: _type, ...rest} = found
  return {...actor, ...rest}
}

/**
 * One page of a private post's likes, as `app.bsky.feed.getLikes` answers.
 */
export async function fetchPrivateLikesPage(
  uri: string,
  cursor: string | undefined,
  limit: number,
): Promise<app.bsky.feed.getLikes.$OutputBody> {
  const empty = {uri: uri as AtUriString, likes: []}
  const clients = listClients()
  if (!clients) return empty
  const page = await getPrivateLikes(clients.prismClient, {uri, limit, cursor})
  const likes = page.likes.filter((item): item is Like => {
    const ok = app.bsky.feed.getLikes.like.matches(item)
    if (!ok) logger.warn('private likes: an item was dropped')
    return ok
  })
  const profiles = await fetchPublicAuthors(
    clients.appviewClient,
    likes.map(like => like.actor.did),
  )
  return {
    uri: uri as AtUriString,
    cursor: page.cursor,
    likes: likes.map(like => ({
      ...like,
      actor: withPublicProfile(like.actor, profiles),
    })),
  }
}

/**
 * One page of a private post's reposters, as `app.bsky.feed.getRepostedBy`
 * answers.
 */
export async function fetchPrivateRepostedByPage(
  uri: string,
  cursor: string | undefined,
  limit: number,
): Promise<app.bsky.feed.getRepostedBy.$OutputBody> {
  const empty = {uri: uri as AtUriString, repostedBy: []}
  const clients = listClients()
  if (!clients) return empty
  const page = await getPrivateRepostedBy(clients.prismClient, {
    uri,
    limit,
    cursor,
  })
  const actors = page.repostedBy.filter((item): item is ProfileView => {
    const ok = app.bsky.actor.defs.profileView.matches(item)
    if (!ok) logger.warn('private reposts: an item was dropped')
    return ok
  })
  const profiles = await fetchPublicAuthors(
    clients.appviewClient,
    actors.map(actor => actor.did),
  )
  return {
    uri: uri as AtUriString,
    cursor: page.cursor,
    repostedBy: actors.map(actor => withPublicProfile(actor, profiles)),
  }
}

/**
 * A quoting post as prism lists it: a private view, or a public post by
 * reference.
 */
type QuoteItem =
  {kind: 'private'; view: PrivatePostView} | {kind: 'public'; uri: string}

function toQuoteItem(item: Record<string, unknown>): QuoteItem | undefined {
  if (item.$type === PRIVATE_VIEW) {
    const {$type: _type, ...view} = item
    if (privatePostView.matches(view)) return {kind: 'private', view}
  } else if (
    item.$type === PUBLIC_REF &&
    typeof item.uri === 'string' &&
    typeof item.cid === 'string'
  ) {
    return {kind: 'public', uri: item.uri}
  }
  logger.warn('private quotes: an item was dropped')
  return undefined
}

/**
 * One load of the posts quoting a private post, as `app.bsky.feed.getQuotes`
 * answers, in prism's order: private quoting posts adapted, public ones read
 * from the public AppView (25 to a call). A page can be short or empty and
 * still carry a cursor, so empty pages are followed (`fetchUntilItems`); an
 * item neither read returns is dropped. The private posts the page quotes are
 * resolved before it is returned.
 */
export async function fetchPrivateQuotesPage(
  uri: string,
  cursor: string | undefined,
  limit: number,
): Promise<app.bsky.feed.getQuotes.$OutputBody> {
  const empty = {uri: uri as AtUriString, posts: []}
  const clients = listClients()
  if (!clients) return empty
  const loaded = await fetchUntilItems<QuoteItem>(async next => {
    const page = await getPrivateQuotes(clients.prismClient, {
      uri,
      limit,
      cursor: next,
    })
    return {
      items: page.posts
        .map(toQuoteItem)
        .filter((item): item is QuoteItem => !!item),
      cursor: page.cursor,
    }
  }, cursor)

  const privateInputs = loaded.items.flatMap(item =>
    item.kind === 'private' ? [{view: item.view}] : [],
  )
  const publicUris = loaded.items.flatMap(item =>
    item.kind === 'public' ? [item.uri] : [],
  )
  const [adapted, publicPosts] = await Promise.all([
    privateInputs.length
      ? adaptPosts(privateInputs, clients.appviewClient, () => undefined)
      : Promise.resolve({views: new Map<string, PostView>()}),
    publicUris.length
      ? fetchPublicPosts(clients.appviewClient, publicUris)
      : Promise.resolve(new Map<string, PostView>()),
  ])
  const posts: PostView[] = []
  for (const item of loaded.items) {
    const post =
      item.kind === 'private'
        ? adapted.views.get(item.view.uri)
        : publicPosts.get(item.uri)
    if (post) posts.push(post)
  }
  await resolvePrivateQuotes(posts)
  return {uri: uri as AtUriString, cursor: loaded.cursor, posts}
}

/** A page of a private list with its completion stamp (4.1). */
export function stampListPage<P extends object>(page: P): P {
  return {...page, fetchedAt: fetchStamp()}
}

function stampOf(page: object): number | undefined {
  const stamp = (page as {fetchedAt?: unknown}).fetchedAt
  return typeof stamp === 'number' ? stamp : undefined
}

type LikesPage = app.bsky.feed.getLikes.$OutputBody
type RepostsPage = app.bsky.feed.getRepostedBy.$OutputBody
type QuotesPage = app.bsky.feed.getQuotes.$OutputBody

/**
 * How the gate reads a likes list (BR11-N6): every row stands for the
 * subject, so each is gated when the subject is another author's private
 * post.
 */
export function likesListAccess(
  subjectUri: string | undefined,
): PageAccess<LikesPage, Like> {
  return {
    stampOf,
    itemsOf: page => page.likes,
    withItems: (page, likes) => ({...page, likes}),
    urisOf: () => (subjectUri ? [subjectUri] : []),
  }
}

/** How the gate reads a reposts list (BR11-N6), as {@link likesListAccess}. */
export function repostsListAccess(
  subjectUri: string | undefined,
): PageAccess<RepostsPage, ProfileView> {
  return {
    stampOf,
    itemsOf: page => page.repostedBy,
    withItems: (page, repostedBy) => ({...page, repostedBy}),
    urisOf: () => (subjectUri ? [subjectUri] : []),
  }
}

/** How the gate reads a quotes list: each row by its quoting post. */
export const quotesListAccess: PageAccess<QuotesPage, PostView> = {
  stampOf,
  itemsOf: page => page.posts,
  withItems: (page, posts) => ({...page, posts}),
  urisOf: post => [post.uri],
}
