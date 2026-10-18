/*
 * Telling private posts apart. The collection is the only discriminator: a
 * public and a private post in one repo can share an rkey, so nothing is ever
 * keyed by rkey alone.
 */

import {AtUri} from '@atproto/syntax'

import {type NavigationProp} from '#/lib/routes/types'
import {
  PRIVATE_POST_DISPLAY,
  PRIVATE_POST_LINKS,
  PRIVATE_READING,
} from '#/horizon/switches'

export const PP_COLLECTION = 'tools.kryphocron.feed.postPrivate'
export const AUDIENCE_COLLECTION = 'tools.kryphocron.policy.audience'

/**
 * The host private post links are shared on.
 */
export const PRIVATE_SHARE_ORIGIN = 'https://nearhorizon.app'

function parseAtUri(uri: string | undefined): AtUri | undefined {
  if (!uri || !uri.startsWith('at://')) return undefined
  try {
    return new AtUri(uri)
  } catch {
    return undefined
  }
}

/**
 * Whether `uri` is the at-uri of a private post. A malformed or absent URI is
 * not. Plain `boolean`, not a type guard.
 */
export function isPrivatePostUri(uri: string | undefined): boolean {
  const parsed = parseAtUri(uri)
  return (
    !!parsed && parsed.collection === PP_COLLECTION && parsed.rkey.length > 0
  )
}

/**
 * Whether `uri` is the at-uri of an audience record: a DID authority, the
 * audience collection and an rkey.
 */
export function isAudienceUri(uri: string | undefined): boolean {
  const parsed = parseAtUri(uri)
  return (
    !!parsed &&
    parsed.host.startsWith('did:') &&
    parsed.collection === AUDIENCE_COLLECTION &&
    parsed.rkey.length > 0
  )
}

/**
 * The path segment of a post link: `ppost` for a private post (while
 * `PRIVATE_POST_LINKS`), else the stock `post`.
 */
export function postSegment(uri: string | undefined): 'post' | 'ppost' {
  return PRIVATE_POST_LINKS && isPrivatePostUri(uri) ? 'ppost' : 'post'
}

const PRIVATE_THREAD_PATH = /^\/profile\/[^/]+\/ppost\/[^/]+\/?$/
const PRIVATE_POST_PATH =
  /^\/profile\/[^/]+\/ppost\/[^/]+(\/(liked-by|reposted-by|quotes))?\/?$/

/**
 * Whether `path` is a private post's path: `/profile/<name>/ppost/<rkey>`,
 * optionally followed by `/liked-by`, `/reposted-by` or `/quotes`.
 */
export function isPrivatePostPath(path: string): boolean {
  return PRIVATE_POST_PATH.test(path)
}

function ownHost(): string | undefined {
  try {
    return typeof window !== 'undefined' ? window.location?.host : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether `url` is an absolute link to a private post's thread on
 * `nearhorizon.app`, `bsky.app` (the composer's quote path builds those
 * internally) or the page's own host.
 */
export function isPrivatePostUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.host
  const knownHost =
    host === 'nearhorizon.app' || host === 'bsky.app' || host === ownHost()
  return knownHost && PRIVATE_THREAD_PATH.test(parsed.pathname)
}

/**
 * The relative path of a private post's thread.
 */
export function privatePostPath(handleOrDid: string, rkey: string): string {
  return `/profile/${handleOrDid}/ppost/${rkey}`
}

/**
 * The share link for a private post path, on Horizon's own host.
 */
export function privateShareUrl(path: string): string {
  return `${PRIVATE_SHARE_ORIGIN}${path}`
}

/**
 * Whether a read of the post at `uri` goes through prism rather than the
 * public AppView: the post query (Post 1), the thread (Thread 1) and a quote
 * the public AppView could not hydrate (Embed 1), while `PRIVATE_READING`.
 */
export function isPrivateRead(uri: string | undefined): boolean {
  return PRIVATE_READING && isPrivatePostUri(uri)
}

/**
 * Whether the share menu leaves out the items that hand a post to Bluesky's
 * own services (Embed post, Send via chat), which cannot render a private
 * post (while `PRIVATE_POST_DISPLAY`).
 */
export function hidesBlueskyShare(uri: string | undefined): boolean {
  return PRIVATE_POST_DISPLAY && isPrivatePostUri(uri)
}

/**
 * The thread route a post opens on: `PrivatePostThread` for a private post
 * (while `PRIVATE_POST_LINKS`), else the stock `PostThread`.
 */
export function postThreadRouteName(
  uri: string | undefined,
): 'PostThread' | 'PrivatePostThread' {
  return postSegment(uri) === 'ppost' ? 'PrivatePostThread' : 'PostThread'
}

/**
 * Open the thread of the post at `uri`, on the route its collection needs.
 */
export function navigateToPost(navigation: NavigationProp, uri: string) {
  const {host: name, rkey} = new AtUri(uri)
  if (postThreadRouteName(uri) === 'PrivatePostThread') {
    navigation.navigate('PrivatePostThread', {name, rkey})
  } else {
    navigation.navigate('PostThread', {name, rkey})
  }
}
