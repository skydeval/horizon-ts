/*
 * Private posts by URI and by link: the post query (6.8), pasted `ppost`
 * URLs that become quotes (8.4), and the composer's quote-count wait (4.11).
 *
 * Private reads are never made signed out or for a non-member (U6.2): a
 * caller without the signed-in clients gets `PrivateClientUnavailableError`,
 * and a non-member gets "not found" with no request.
 */

import {type Client} from '@atproto/lex'
import {AtUri, type HandleString} from '@atproto/syntax'

import {type ResolvedLink} from '#/lib/api/resolve'
import {adaptPosts} from '#/horizon/private/adapt/feed-view'
import {prefetchAuthorPds} from '#/horizon/private/adapt/pds'
import {fetchPublicAuthors} from '#/horizon/private/adapt/profiles'
import {getPrivatePosts} from '#/horizon/private/api/reads'
import {getPendingPost} from '#/horizon/private/store'
import {
  isPrivatePostUri,
  isPrivatePostUrl,
  PP_COLLECTION,
} from '#/horizon/private/uri'
import {
  type CurrentClients,
  requireCurrentClients,
} from '#/horizon/routing/current-clients'
import {isPrivateMember} from '#/horizon/routing/membership'
import {PRIVATE_READING} from '#/horizon/switches'
import {type app, com} from '#/lexicons'

/**
 * Whether the composer should skip waiting for the quoted post's quote count
 * to change before it calls `onPost`: that count never changes for a private
 * new post (the public AppView never sees it) or a private quoted post.
 */
export function skipQuoteCountWait(
  postUri: string | undefined,
  quotedUri: string,
): boolean {
  return isPrivatePostUri(postUri) || isPrivatePostUri(quotedUri)
}

/**
 * Whether a pasted or composed URL is a private post link to resolve through
 * prism (while `PRIVATE_READING`).
 */
export function isPrivatePostLink(url: string): boolean {
  return PRIVATE_READING && isPrivatePostUrl(url)
}

async function resolveDid(client: Client, handleOrDid: string) {
  if (handleOrDid.startsWith('did:')) return handleOrDid
  const data = await client.call(com.atproto.identity.resolveHandle, {
    handle: handleOrDid as HandleString,
  })
  return data.did as string
}

/**
 * The signed-in member's clients, or `undefined` for a signed-in non-member.
 * Throws `PrivateClientUnavailableError` when signed out.
 */
export function memberClients() {
  const clients = requireCurrentClients()
  return isPrivateMember(clients.did) ? clients : undefined
}

function authorDidOf(uri: string): string | undefined {
  try {
    const host = new AtUri(uri).host
    return host.startsWith('did:') ? host : undefined
  } catch {
    return undefined
  }
}

/**
 * Private posts by URI (DID authorities), adapted, through prism, 25 to a
 * call; the current account's pending post for one prism does not serve yet.
 * A post neither gives is absent. The authors' public profiles and PDS
 * lookups start with the read, not after it: each author is in its URI.
 */
export async function readPrivatePostViews(
  clients: Pick<CurrentClients, 'prismClient' | 'appviewClient'>,
  uris: readonly string[],
): Promise<Map<string, app.bsky.feed.defs.PostView>> {
  const unique = Array.from(new Set(uris))
  const result = new Map<string, app.bsky.feed.defs.PostView>()
  if (unique.length === 0) return result
  const dids = new Set(
    unique.map(authorDidOf).filter((did): did is string => !!did),
  )
  const authors = fetchPublicAuthors(clients.appviewClient, dids)
  // The embed builder's own lookup joins these (adapt/pds.ts).
  dids.forEach(prefetchAuthorPds)
  const found = await getPrivatePosts(clients.prismClient, unique)
  const {views} = await adaptPosts(
    found.map(view => ({view})),
    clients.appviewClient,
    () => undefined,
    {
      // The served author is the URI's, so the started fetch covers them.
      authors: found.every(view => dids.has(view.author.did))
        ? authors
        : undefined,
    },
  )
  for (const uri of unique) {
    const post = views.get(uri) ?? getPendingPost(uri)?.postView
    if (post) result.set(uri, post)
  }
  return result
}

/**
 * One private post, adapted, through prism; the current account's pending
 * post when prism does not serve it yet; else `undefined`, and for a reader
 * who is not a member, with no request.
 */
export async function readPrivatePost(
  uri: string,
): Promise<app.bsky.feed.defs.PostView | undefined> {
  const clients = memberClients()
  if (!clients) return undefined
  return (await readPrivatePostViews(clients, [uri])).get(uri)
}

/**
 * The post query's read of a private post (Post 1). A handle authority is
 * resolved with `client`, as the stock `fetchPost` does. `undefined` is not
 * found, as the stock callers expect.
 */
export async function fetchPrivatePost(
  client: Client,
  uri: string,
): Promise<app.bsky.feed.defs.PostView | undefined> {
  const urip = new AtUri(uri)
  const did = await resolveDid(client, urip.host)
  return readPrivatePost(`at://${did}/${urip.collection}/${urip.rkey}`)
}

/**
 * A pasted `ppost` URL as a quote (Link 2). A miss, or a reader who is not a
 * member, throws as the stock resolver does for a post it cannot find, so the
 * composer treats the URL as it treats an unresolvable post URL.
 */
export async function resolvePrivatePostLink(
  appviewClient: Client,
  url: string,
): Promise<ResolvedLink> {
  const [, name, , rkey] = new URL(url).pathname.split('/').filter(Boolean)
  const did = await resolveDid(appviewClient, name)
  const post = await readPrivatePost(`at://${did}/${PP_COLLECTION}/${rkey}`)
  if (!post) throw new Error('getPost: post not found')
  return {
    type: 'record',
    record: {uri: post.uri, cid: post.cid},
    kind: 'post',
    view: post,
  }
}
