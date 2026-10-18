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
