/*
 * How one `fill` answer is read (refract client design 5.2): the one place
 * that says what an answer means for each DID and URI it was asked about.
 * Every surface takes its state from here and only chooses the copy. Pure:
 * the batcher (`fill.ts`) supplies what it knows and applies the effects.
 *
 * Two modes, chosen per answer: the full rules when the answer carries a
 * `withheld` array (empty included), the interim rules otherwise. Nothing is
 * switched by build or date.
 */

import {type RefractForm} from '#/horizon/refract/marker'
import {type app} from '#/lexicons'

type ProfileView = app.bsky.actor.defs.ProfileViewDetailed
type PostView = app.bsky.feed.defs.PostView

/** What an answer said about one DID. */
export type DidVerdict =
  | {kind: 'positive'; profile: ProfileView}
  | {kind: 'pending'}
  /** `withheld` `unavailable`, or a reason the client doesn't know. */
  | {kind: 'unavailable'}
  /** `withheld` `unanswered`, `capped` or `proxied`; or an interim omission. */
  | {kind: 'unresolved'}
  /** Definitive: not hosted, rejected, taken down here or not restored. */
  | {kind: 'not-restored'}
  /** Definitive, for a DID noted restored: its restore has ended. */
  | {kind: 'ended'}
  /** An omission that needs a confirming re-ask before it is final. */
  | {kind: 'confirm'}
  /** An interim omission of a noted DID: transient, non-definitive. */
  | {kind: 'indefinite'}

export type DidVerdictKind = DidVerdict['kind']

/** What an answer said about one URI. */
export type UriVerdict =
  | {kind: 'positive'; post: PostView}
  /** Held back across a block: "Blocked", a reply is refused. */
  | {kind: 'blocked'}
  /** The author is "not restored" or stock-served: "Deleted" is right. */
  | {kind: 'gone'}
  /** The author is positive and the URI omitted: "Deleted" for 60 s. */
  | {kind: 'missing'}
  | {kind: 'unresolved'}
  | {kind: 'unavailable'}
  /** The author's own state decides (pending, awaiting its second answer). */
  | {kind: 'author'; author: DidVerdictKind}

/** What the batcher knows when an answer is read. */
export type ReadContext = {
  form: RefractForm
  proxied: boolean
  /** The DID was seen with a marker before this answer. */
  noted: (did: string) => boolean
  /** The DID carries the "seen pending" mark (10 min). */
  seenPending: (did: string) => boolean
  /** DIDs this call is a confirming re-ask for. */
  confirming: ReadonlySet<string>
  /** A skipped author's cached state. */
  authorCache: (did: string) => 'not-restored' | 'stock-served' | undefined
  /** The reader's own block set names the DID. */
  ownBlock: (did: string) => boolean
}

/** The answer read. */
export type ReadAnswer = {
  mode: 'full' | 'interim'
  dids: Map<string, DidVerdict>
  uris: Map<string, UriVerdict>
}

const DISCOVERY_REASONS = new Set(['unanswered', 'capped', 'proxied'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A block flag (5.2): `viewer.blocking` a string, `viewer.blockedBy` `true`,
 * or `viewer.blockingByList` or `viewer.blockedByList` an object. Never read
 * from a key being present: prism sends `blockedBy: false`.
 */
export function hasBlockFlag(view: unknown): boolean {
  if (!isObject(view) || !isObject(view.viewer)) return false
  const viewer = view.viewer
  return (
    typeof viewer.blocking === 'string' ||
    viewer.blockedBy === true ||
    isObject(viewer.blockingByList) ||
    isObject(viewer.blockedByList)
  )
}

/** The author DID of a post URI (`at://<did>/...`), if it parses. */
export function authorOfUri(uri: string): string | undefined {
  const match = /^at:\/\/(did:[^/]+)\//.exec(uri)
  return match?.[1]
}

/**
 * Read one answer for the DIDs and URIs that call asked about. Every URI's
 * author is expected among `dids` (5.1); one that was skipped is read from
 * the context's cache.
 */
export function readFillAnswer(
  body: unknown,
  asked: {dids: readonly string[]; uris: readonly string[]},
  ctx: ReadContext,
): ReadAnswer {
  const answer = isObject(body) ? body : {}
  const mode = Array.isArray(answer.withheld) ? 'full' : 'interim'
  const profiles = new Map<string, ProfileView>()
  for (const profile of Array.isArray(answer.profiles) ? answer.profiles : []) {
    if (isObject(profile) && typeof profile.did === 'string') {
      profiles.set(profile.did, profile as unknown as ProfileView)
    }
  }
  const posts = new Map<string, PostView>()
  for (const post of Array.isArray(answer.posts) ? answer.posts : []) {
    if (isObject(post) && typeof post.uri === 'string') {
      posts.set(post.uri, post as unknown as PostView)
    }
  }
  const pending = new Set(
    (Array.isArray(answer.pending) ? answer.pending : []).filter(
      (id): id is string => typeof id === 'string',
    ),
  )
  const withheld = new Map<string, string>()
  if (Array.isArray(answer.withheld)) {
    for (const item of answer.withheld) {
      if (isObject(item) && typeof item.id === 'string') {
        withheld.set(
          item.id,
          typeof item.reason === 'string' ? item.reason : 'unknown',
        )
      }
    }
  }
  const definitive = mode === 'full' || (ctx.form === 'member' && !ctx.proxied)

  const dids = new Map<string, DidVerdict>()
  for (const did of asked.dids) {
    const profile = profiles.get(did)
    if (profile) {
      dids.set(did, {kind: 'positive', profile})
      continue
    }
    if (pending.has(did)) {
      dids.set(did, {kind: 'pending'})
      continue
    }
    const reason = withheld.get(did)
    if (reason !== undefined) {
      dids.set(did, {
        kind: DISCOVERY_REASONS.has(reason) ? 'unresolved' : 'unavailable',
      })
      continue
    }
    const noted = ctx.noted(did)
    if (!definitive) {
      dids.set(did, {kind: noted ? 'indefinite' : 'unresolved'})
      continue
    }
    if (noted || ctx.seenPending(did)) {
      if (ctx.confirming.has(did)) {
        dids.set(did, {kind: noted ? 'ended' : 'not-restored'})
      } else {
        dids.set(did, {kind: 'confirm'})
      }
      continue
    }
    dids.set(did, {kind: 'not-restored'})
  }

  const uris = new Map<string, UriVerdict>()
  for (const uri of asked.uris) {
    const post = posts.get(uri)
    if (post) {
      uris.set(uri, {kind: 'positive', post})
      continue
    }
    const reason = withheld.get(uri)
    if (reason === 'blocked') {
      uris.set(uri, {kind: 'blocked'})
      continue
    }
    const author = authorOfUri(uri)
    const authorProfile = author ? profiles.get(author) : undefined
    if (
      (authorProfile && hasBlockFlag(authorProfile)) ||
      (author && ctx.ownBlock(author))
    ) {
      uris.set(uri, {kind: 'blocked'})
      continue
    }
    if (reason !== undefined) {
      uris.set(uri, {
        kind: DISCOVERY_REASONS.has(reason) ? 'unresolved' : 'unavailable',
      })
      continue
    }
    const authorVerdict = author ? dids.get(author) : undefined
    if (!author) {
      uris.set(uri, {kind: 'unavailable'})
      continue
    }
    if (!authorVerdict) {
      const cached = ctx.authorCache(author)
      uris.set(uri, cached ? {kind: 'gone'} : {kind: 'unavailable'})
      continue
    }
    if (
      authorVerdict.kind === 'not-restored' ||
      authorVerdict.kind === 'ended'
    ) {
      uris.set(uri, {kind: 'gone'})
      continue
    }
    if (authorVerdict.kind !== 'positive') {
      uris.set(uri, {kind: 'author', author: authorVerdict.kind})
      continue
    }
    uris.set(uri, definitive ? {kind: 'missing'} : {kind: 'unavailable'})
  }
  return {mode, dids, uris}
}
