/*
 * Act as another signed-in account on like, repost and follow (Phase 5
 * design 8.6, U-12, B-19): the action runs through that account's temporary
 * client (PP-16), never the current account's.
 *
 * - **Its own repo only.** Every write goes to the acting account's PDS, with
 *   `repo` set to its DID, and is refused when the client's DID is not that
 *   account's ("posting session does not match", as 8.5). Likes, reposts and
 *   follows are server-keyed: `createRecord` with no `rkey`, so the PDS
 *   mints the TID and no client clock is involved (Appendix A.2). An undo
 *   deletes only a record whose URI is in the acting account's repo. No
 *   `via` is written: the repost that brought the post to the screen came
 *   from the current account's timeline.
 * - **Raw calls.** No sdk action: the reads are the lexicon queries, so
 *   nothing writes preferences or mints a TID on the sdk's shared clock
 *   (5D's finding on `getPreferences`).
 * - **Its own shadow.** The like, repost and follow state shown for an
 *   account is that account's, read as it (its AppView, or prism for a
 *   kryphocron post) and kept here by DID and subject. The current
 *   account's post and profile shadows are never touched (8.6).
 * - **Kryphocron posts** are liked or reposted as another account only when
 *   prism serves the post to that account; otherwise "That account can't
 *   see this post." A public post its AppView does not serve is refused the
 *   same way, and a block between that account and the author refuses it
 *   as the stock control does.
 */

import {useSyncExternalStore} from 'react'
import {
  AtUri,
  type AtUriString,
  type DidString,
  toDatetimeString,
} from '@atproto/syntax'
import {t} from '@lingui/core/macro'

import {logger} from '#/logger'
import {getPrivatePosts} from '#/horizon/private/api/reads'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {ACT_AS_CONTROLS} from '#/horizon/switches'
import {app} from '#/lexicons'
import {
  acquireTemporaryClient,
  type PostingClients,
  releaseTemporaryClient,
} from './temp-client'

/** The three actions (Q11: no bookmark). */
export type ActAsKind = 'like' | 'repost' | 'follow'

/** A post acted on: its URI and CID as the current view has them. */
export type ActAsPost = {uri: string; cid: string}

/**
 * One account's state on one subject. `like`, `repost` and `following` are
 * the record URIs in that account's repo, `'pending'` while a create is in
 * flight.
 */
export type ActAsEntry =
  | {status: 'loading'}
  | {status: 'error'}
  | {status: 'refused'; reason: 'unseen' | 'blocked'}
  | {
      status: 'ready'
      like?: string
      repost?: string
      following?: string
      cid?: string
    }

/** The record slot each action fills. */
const SLOT = {like: 'like', repost: 'repost', follow: 'following'} as const

/** A write the acting account cannot make; its message is for the user. */
export class ActAsRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActAsRefusedError'
  }
}

const entries = new Map<string, ActAsEntry>()
/** Subjects with a write in flight: a read landing meanwhile is dropped. */
const writing = new Set<string>()
const listeners = new Set<() => void>()

function keyOf(did: string, subject: string) {
  return `${did} ${subject}`
}

function setEntry(did: string, subject: string, entry: ActAsEntry) {
  entries.set(keyOf(did, subject), entry)
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** `did`'s state on `subject` (a post URI or a profile DID). */
export function getActAs(did: string, subject: string): ActAsEntry | undefined {
  return entries.get(keyOf(did, subject))
}

/** {@link getActAs}, kept current. */
export function useActAs(did: string, subject: string): ActAsEntry | undefined {
  return useSyncExternalStore(subscribe, () => getActAs(did, subject))
}

/** Test-only: forget every entry. */
export function resetActAs() {
  entries.clear()
  writing.clear()
  listeners.forEach(listener => listener())
}

/** A record URI in `did`'s repo, else `undefined`. */
function ownRecord(did: string, uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined
  try {
    return new AtUri(uri).host === did ? uri : undefined
  } catch {
    return undefined
  }
}

/**
 * Run `fn` with `did`'s temporary client held, its identity reads left on
 * prism (PP-20: only the composer's chosen account reads its own PDS).
 * The client's DID must be `did`.
 */
async function withClient<T>(
  did: string,
  fn: (clients: PostingClients) => Promise<T>,
): Promise<T> {
  const clients = acquireTemporaryClient(did, {identity: false})
  try {
    if (clients.did !== did || clients.pdsClient.assertDid !== did) {
      throw new Error('act as: the session does not match the account')
    }
    return await fn(clients)
  } finally {
    releaseTemporaryClient(did, {identity: false})
  }
}

/**
 * Hold each of `dids`' temporary clients while the account list is open, so
 * its reads and writes share one session per account (a password session's
 * refresh token is spent once). Accounts that cannot act are skipped.
 * Returns the release, which runs once.
 */
export function holdActAsClients(dids: readonly string[]): () => void {
  const held: string[] = []
  for (const did of dids) {
    try {
      acquireTemporaryClient(did, {identity: false})
      held.push(did)
    } catch {
      // Not signed in here: its row reads as an error.
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    for (const did of held) releaseTemporaryClient(did, {identity: false})
  }
}

type AuthorViewer = {
  blocking?: unknown
  blockedBy?: unknown
  blockingByList?: unknown
}

/** A post as the acting account sees it: the parts act-as reads. */
type SeenPost = {
  cid: string
  viewer?: {like?: unknown; repost?: unknown}
  author: {viewer?: AuthorViewer}
}

function isBlocked(viewer: AuthorViewer | undefined): boolean {
  return !!(viewer?.blocking || viewer?.blockedBy || viewer?.blockingByList)
}

/**
 * Read `post` as `did`: whether that account can see it, and its own like
 * and repost of it. A kryphocron post through prism as that account, a
 * public one through its AppView.
 */
export async function loadActAsPost(did: string, post: ActAsPost) {
  if (writing.has(keyOf(did, post.uri))) return
  const current = getActAs(did, post.uri)
  // A known answer stays on screen while it is read again.
  if (current?.status !== 'ready') setEntry(did, post.uri, {status: 'loading'})
  try {
    const view = await withClient(
      did,
      async (clients): Promise<SeenPost | undefined> => {
        if (isPrivatePostUri(post.uri)) {
          // prism decides: a post it does not serve to that account is absent.
          const posts = await getPrivatePosts(clients.prismClient, [post.uri])
          return posts.find(item => item.uri === post.uri)
        }
        const res = await clients.appviewClient.call(app.bsky.feed.getPosts, {
          uris: [post.uri as AtUriString],
        })
        return res.posts.find(item => item.uri === post.uri)
      },
    )
    if (!view) {
      landRead(did, post.uri, {status: 'refused', reason: 'unseen'})
      return
    }
    if (isBlocked(view.author.viewer)) {
      landRead(did, post.uri, {status: 'refused', reason: 'blocked'})
      return
    }
    const viewer = view.viewer
    landRead(did, post.uri, {
      status: 'ready',
      like: ownRecord(did, viewer?.like),
      repost: ownRecord(did, viewer?.repost),
      cid: view.cid,
    })
  } catch (error) {
    logger.warn('act as: the post could not be read', {safeMessage: error})
    landRead(did, post.uri, {status: 'error'})
  }
}

/**
 * Read the profile `subject` as `did`: its own follow of it, and whether a
 * block stands between them.
 */
export async function loadActAsProfile(did: string, subject: string) {
  if (writing.has(keyOf(did, subject))) return
  const current = getActAs(did, subject)
  if (current?.status !== 'ready') setEntry(did, subject, {status: 'loading'})
  try {
    const profile = await withClient(did, clients =>
      clients.appviewClient.call(app.bsky.actor.getProfile, {
        actor: subject as app.bsky.actor.getProfile.$Params['actor'],
      }),
    )
    if (isBlocked(profile.viewer)) {
      landRead(did, subject, {status: 'refused', reason: 'blocked'})
      return
    }
    landRead(did, subject, {
      status: 'ready',
      following: ownRecord(did, profile.viewer?.following),
    })
  } catch (error) {
    logger.warn('act as: the profile could not be read', {safeMessage: error})
    landRead(did, subject, {status: 'error'})
  }
}

/** Land a read's answer, unless a write began meanwhile (it wins). */
function landRead(did: string, subject: string, entry: ActAsEntry) {
  if (writing.has(keyOf(did, subject))) return
  setEntry(did, subject, entry)
}

function refusal(entry: ActAsEntry | undefined): ActAsRefusedError {
  if (entry?.status === 'refused' && entry.reason === 'blocked') {
    return new ActAsRefusedError(t`Cannot interact with a blocked user`)
  }
  if (entry?.status === 'refused') {
    return new ActAsRefusedError(t`That account can’t see this post.`)
  }
  return new ActAsRefusedError(t`That account’s view couldn’t be loaded.`)
}

/**
 * Toggle `kind` on `subject` as `did`: create the record when that account
 * has none, delete its own when it has one. Optimistic in this store,
 * rolled back on failure. `subject` is a post for like and repost, a
 * profile DID for follow. Resolves to whether the record now exists.
 */
export async function toggleActAs(
  did: string,
  kind: ActAsKind,
  subject: ActAsPost | string,
): Promise<boolean> {
  if (!ACT_AS_CONTROLS) throw new Error('act as is off')
  const key = typeof subject === 'string' ? subject : subject.uri
  const before = getActAs(did, key)
  if (before?.status !== 'ready') throw refusal(before)
  const slot = SLOT[kind]
  const existing = before[slot]
  // One write at a time per account and subject; a second press waits it out.
  if (writing.has(keyOf(did, key))) return !!existing
  if (subject === did) {
    throw new ActAsRefusedError(t`An account can’t follow itself.`)
  }
  writing.add(keyOf(did, key))
  setEntry(did, key, {...before, [slot]: existing ? undefined : 'pending'})
  try {
    if (existing) {
      await deleteOwn(did, kind, existing)
      setEntry(did, key, {...readyOf(did, key), [slot]: undefined})
      return false
    }
    const uri = await createOwn(did, kind, subject, before.cid)
    setEntry(did, key, {...readyOf(did, key), [slot]: uri})
    return true
  } catch (error) {
    setEntry(did, key, {...readyOf(did, key), [slot]: existing})
    throw error
  } finally {
    writing.delete(keyOf(did, key))
  }
}

function readyOf(did: string, key: string) {
  const entry = getActAs(did, key)
  return entry?.status === 'ready' ? entry : {status: 'ready' as const}
}

/** Create `kind` in `did`'s repo, server-keyed. Returns its URI. */
async function createOwn(
  did: string,
  kind: ActAsKind,
  subject: ActAsPost | string,
  readCid: string | undefined,
): Promise<string> {
  const createdAt = toDatetimeString(new Date())
  const repo = did as DidString
  const res = await withClient(did, clients => {
    if (kind === 'follow') {
      return clients.pdsClient.create(
        app.bsky.graph.follow,
        {
          subject: subject as DidString,
          createdAt,
        },
        {repo},
      )
    }
    const post = subject as ActAsPost
    const record = {
      subject: {uri: post.uri as AtUriString, cid: readCid ?? post.cid},
      createdAt,
    }
    return kind === 'like'
      ? clients.pdsClient.create(app.bsky.feed.like, record, {repo})
      : clients.pdsClient.create(app.bsky.feed.repost, record, {repo})
  })
  const uri = ownRecord(did, res.uri)
  if (!uri) throw new Error('act as: the record was not written to the account')
  return uri
}

/** Delete `did`'s own `kind` record at `uri`. */
async function deleteOwn(did: string, kind: ActAsKind, uri: string) {
  const own = ownRecord(did, uri)
  if (!own) throw new Error('act as: not a record of the acting account')
  const rkey = new AtUri(own).rkey
  const repo = did as DidString
  await withClient(did, async clients => {
    if (kind === 'follow') {
      await clients.pdsClient.delete(app.bsky.graph.follow, {repo, rkey})
    } else if (kind === 'like') {
      await clients.pdsClient.delete(app.bsky.feed.like, {repo, rkey})
    } else {
      await clients.pdsClient.delete(app.bsky.feed.repost, {repo, rkey})
    }
  })
}
