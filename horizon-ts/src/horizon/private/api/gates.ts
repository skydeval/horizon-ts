/*
 * Reply and quote limits on private posts (4.14): the stock
 * `app.bsky.feed.threadgate` and `app.bsky.feed.postgate` records, naming
 * the private post's URI, in the author's own repo at the post's rkey.
 *
 * This file holds:
 *
 * - the compose side: the records a private compose writes before its posts,
 *   and their removal when the compose rolls back (4.5, 4.14);
 * - the readers' interim check (7.4.2): where prism does not apply the gates
 *   (P-18: `private.gates` not listed, or a private reply whose thread root
 *   is public, 2H design 5.4), a reader's client reads them from the
 *   authors' PDSes and decides itself, failing open where a rule cannot be
 *   decided; the press guard that uses it is in
 *   `api/gate-guard.ts`, and the post settings dialog's save in
 *   `settings/save-gates.ts`, so this module stays free of UI and session
 *   imports (the write path loads it).
 */

import {type Client, XrpcResponseError} from '@atproto/lex'
import {
  type AtIdentifierString,
  AtUri,
  type DidString,
  toDatetimeString,
} from '@atproto/syntax'
import {type QueryClient} from '@tanstack/react-query'

import {createLexClient} from '#/lib/lexClient'
import {logger} from '#/logger'
import {STALE} from '#/state/queries'
import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {
  createThreadgateRecord,
  threadgateAllowUISettingToAllowRecordValue,
} from '#/state/queries/threadgate/util'
import {networkAwareFetch} from '#/state/session/network'
import {authorPdsUrl} from '#/horizon/private/adapt/pds'
import {privateGatesServed} from '#/horizon/private/server-support'
import {getPendingPost} from '#/horizon/private/store'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {COMPOSER_AUDIENCE_MENU} from '#/horizon/switches'
import {app, com} from '#/lexicons'
import * as bsky from '#/types/bsky'

export const THREADGATE_COLLECTION = 'app.bsky.feed.threadgate'
export const POSTGATE_COLLECTION = 'app.bsky.feed.postgate'

/**
 * One gate record to create.
 */
export type GateWrite = {
  collection: typeof THREADGATE_COLLECTION | typeof POSTGATE_COLLECTION
  rkey: string
  record: app.bsky.feed.threadgate.Main | app.bsky.feed.postgate.Main
}

/**
 * The gate records of a new private compose, as the stock `post()` builds
 * them for a public one: a threadgate for the first post when the reply
 * settings are not Anyone and the compose is not a reply (a threadgate
 * governs a thread root), and a postgate for each post when it sets
 * embedding rules or detached quotes. Each record sits at its post's rkey.
 * None while `COMPOSER_AUDIENCE_MENU` is off (the author cannot see the
 * limits then).
 */
export function gatesForNewPost({
  threadgate,
  postgate,
  postUris,
  isReply,
  createdAt = toDatetimeString(new Date()),
}: {
  threadgate: ThreadgateAllowUISetting[]
  postgate: app.bsky.feed.postgate.Main
  /** The private URI of each post of the compose, in order. */
  postUris: string[]
  isReply: boolean
  createdAt?: string
}): GateWrite[] {
  if (!COMPOSER_AUDIENCE_MENU || postUris.length === 0) return []
  const writes: GateWrite[] = []
  const first = postUris[0]
  if (!isReply && threadgate.some(setting => setting.type !== 'everybody')) {
    writes.push({
      collection: THREADGATE_COLLECTION,
      rkey: new AtUri(first).rkey,
      record: {
        ...createThreadgateRecord({
          post: first,
          allow: threadgateAllowUISettingToAllowRecordValue(threadgate),
        }),
        createdAt: createdAt as app.bsky.feed.threadgate.Main['createdAt'],
      },
    })
  }
  if (
    postgate.embeddingRules?.length ||
    postgate.detachedEmbeddingUris?.length
  ) {
    for (const uri of postUris) {
      writes.push({
        collection: POSTGATE_COLLECTION,
        rkey: new AtUri(uri).rkey,
        record: {
          ...postgate,
          $type: POSTGATE_COLLECTION,
          createdAt: createdAt as app.bsky.feed.postgate.Main['createdAt'],
          post: uri as app.bsky.feed.postgate.Main['post'],
        },
      })
    }
  }
  return writes
}

/**
 * A gate record could not be created. The gates created before it in the
 * same step have been deleted, or are named in `remaining`.
 */
export class PrivateGateWriteError extends Error {
  constructor(
    readonly failure: unknown,
    readonly remaining: string[],
  ) {
    super('A reply or quote limit could not be saved')
    this.name = 'PrivateGateWriteError'
  }
}

/**
 * Create each gate with `createRecord`, one call per record, in order.
 * `createRecord` refuses an rkey that already holds a record, so a gate never
 * replaces another post's. Returns the created URIs. On a failure the gates
 * already created are deleted and {@link PrivateGateWriteError} is thrown.
 *
 * The encode route's outbox (2K design 4.2 step 7, PA-28) passes
 * `deleteOnFailure: false`, so a failure deletes nothing (the gates created
 * are named in the error), and `beforeWrite`, which records the write in
 * the outbox before each `createRecord`. `beforeWrite` runs outside the
 * write's `try`, so its own failure passes through unwrapped: no gate write
 * was made for it. `signal` gives each call its timeout.
 */
export async function writeGatesForNewPost(
  pdsClient: Client,
  did: string,
  writes: GateWrite[],
  {
    deleteOnFailure = true,
    beforeWrite,
    signal,
  }: {
    deleteOnFailure?: boolean
    beforeWrite?: (write: GateWrite) => void
    signal?: () => AbortSignal | undefined
  } = {},
): Promise<string[]> {
  const created: string[] = []
  for (const write of writes) {
    beforeWrite?.(write)
    try {
      await pdsClient.call(
        com.atproto.repo.createRecord,
        {
          repo: did as DidString,
          collection: write.collection,
          rkey: write.rkey,
          record: write.record,
        },
        {signal: signal?.()},
      )
    } catch (error) {
      const remaining = deleteOnFailure
        ? await deleteGates(pdsClient, created)
        : created
      throw new PrivateGateWriteError(error, remaining)
    }
    created.push(`at://${did}/${write.collection}/${write.rkey}`)
  }
  return created
}

/**
 * Delete gate records, newest first. A record already gone counts as
 * deleted. Returns the URIs that may remain.
 */
export async function deleteGates(
  pdsClient: Client,
  uris: string[],
): Promise<string[]> {
  const remaining: string[] = []
  for (const uri of [...uris].reverse()) {
    const {host, collection, rkey} = new AtUri(uri)
    try {
      await pdsClient.call(com.atproto.repo.deleteRecord, {
        repo: host,
        collection: collection as `${string}.${string}.${string}`,
        rkey,
      })
    } catch (error) {
      if (
        error instanceof XrpcResponseError &&
        error.error === 'RecordNotFound'
      ) {
        continue
      }
      remaining.push(uri)
    }
  }
  return remaining
}

/*
 * Readers' interim check (7.4.2) and the post settings dialog's reads (7.8).
 */

/**
 * The gates that govern one private post: the thread root's threadgate and
 * the post's own postgate. `undefined` is no gate.
 */
export type PrivateGates = {
  threadgate: app.bsky.feed.threadgate.Main | undefined
  postgate: app.bsky.feed.postgate.Main | undefined
}

/**
 * A client for reading `did`'s repo without a session.
 */
export type GateClientFor = (did: string) => Promise<Client>

/**
 * An unauthenticated client for the PDS `did`'s DID document names (the
 * current account's own from its session), as the audience label reads
 * another account's audience record (7.2). Throws when the PDS is unknown.
 */
export async function gatePdsClient(did: string): Promise<Client> {
  const pdsUrl = await authorPdsUrl(did)
  if (!pdsUrl) throw new Error('The PDS of a gate record could not be found')
  return createLexClient(
    {service: pdsUrl, fetch: networkAwareFetch},
    {appLabelers: null},
  )
}

/**
 * One gate record, read from the repo of the post it governs, at that post's
 * rkey. `RecordNotFound` is no gate. A record whose `post` is not
 * `governedUri` belongs to another post with the same rkey (a public and a
 * private post may share one, U7.6) and is treated as none, as is a value
 * that is not a gate record.
 */
async function readGate<
  T extends app.bsky.feed.threadgate.Main | app.bsky.feed.postgate.Main,
>(
  clientFor: GateClientFor,
  collection: typeof THREADGATE_COLLECTION | typeof POSTGATE_COLLECTION,
  governedUri: string,
): Promise<T | undefined> {
  const {host, rkey} = new AtUri(governedUri)
  const client = await clientFor(host)
  let value: unknown
  try {
    const res = await client.call(com.atproto.repo.getRecord, {
      repo: host,
      collection,
      rkey,
    })
    value = res.value
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return undefined
    }
    throw error
  }
  const matches =
    collection === THREADGATE_COLLECTION
      ? bsky.matches(app.bsky.feed.threadgate, value)
      : bsky.matches(app.bsky.feed.postgate, value)
  if (!matches) return undefined
  const gate = value as T
  return gate.post === governedUri ? gate : undefined
}

/**
 * The threadgate of the thread rooted at `rootUri`, read without a session
 * from the root author's PDS (not the current account's: the root may be in
 * another account's repo, which the account's own PDS does not serve).
 * Throws when the read fails.
 */
export function readRootThreadgate(
  rootUri: string,
  clientFor: GateClientFor = gatePdsClient,
): Promise<app.bsky.feed.threadgate.Main | undefined> {
  return readGate(clientFor, THREADGATE_COLLECTION, rootUri)
}

/**
 * The query key of the root's threadgate record as read from the root
 * author's PDS: under {@link privateGatesQueryKey}, so a threadgate change
 * invalidates it with the thread's evaluations.
 */
export function rootThreadgateQueryKey(rootUri: string) {
  return [...privateGatesQueryKey(rootUri), 'root-threadgate']
}

/**
 * The shared options of the root threadgate query (hidden replies design
 * 5.4, HR2-N2): one cached read, 30 s fresh, for the gate evaluation, the
 * post settings dialog and the thread read. `null` is no gate.
 */
export function rootThreadgateQueryOptions(rootUri: string) {
  return {
    queryKey: rootThreadgateQueryKey(rootUri),
    staleTime: STALE.SECONDS.THIRTY,
    queryFn: async (): Promise<app.bsky.feed.threadgate.Main | null> =>
      (await readRootThreadgate(rootUri)) ?? null,
  }
}

/**
 * The root's threadgate record through the shared query (5.4). Read directly
 * when there is no query client, or when the caller injects `clientFor` (a
 * test client never fills the shared cache, HR3-N6). Throws when the read
 * fails.
 */
export async function rootThreadgateQuery(
  queryClient: QueryClient | undefined,
  rootUri: string,
  clientFor: GateClientFor = gatePdsClient,
): Promise<app.bsky.feed.threadgate.Main | undefined> {
  if (!queryClient || clientFor !== gatePdsClient) {
    return readRootThreadgate(rootUri, clientFor)
  }
  return (
    (await queryClient.fetchQuery(rootThreadgateQueryOptions(rootUri))) ??
    undefined
  )
}

/**
 * The root's threadgate record the shared query last held, if any (5.4,
 * HR4-N2): a failed read leaves it in place.
 */
export function cachedRootThreadgate(
  queryClient: QueryClient | undefined,
  rootUri: string,
): app.bsky.feed.threadgate.Main | undefined {
  return (
    queryClient?.getQueryData<app.bsky.feed.threadgate.Main | null>(
      rootThreadgateQueryKey(rootUri),
    ) ?? undefined
  )
}

/**
 * The root's threadgate for a private thread under a public root (5.4):
 * the shared query under {@link GATE_DEADLINE_MS}; on a failure or after the
 * deadline, the record the query last held, else none. As a thread's
 * `threadgate` view: `cid` is left out (the record read carries none), and
 * every consumer reads `record`.
 */
export async function rootThreadgateView(
  queryClient: QueryClient | undefined,
  rootUri: string,
): Promise<app.bsky.feed.defs.ThreadgateView | undefined> {
  let record: app.bsky.feed.threadgate.Main | undefined
  try {
    record = await withGateDeadline(
      rootThreadgateQuery(queryClient, rootUri),
      GATE_DEADLINE_MS,
    )
  } catch (error) {
    logger.warn('private thread: root threadgate unavailable', {
      safeMessage: error,
    })
    record = cachedRootThreadgate(queryClient, rootUri)
  }
  if (!record) return undefined
  const {host, rkey} = new AtUri(rootUri)
  return {uri: `at://${host}/${THREADGATE_COLLECTION}/${rkey}`, record}
}

/**
 * The gates of the private post `postUri` in the thread rooted at `rootUri`:
 * the root's threadgate from the root author's repo (through the shared root
 * threadgate query, 5.4) and the post's postgate from the post author's,
 * each read without a session. Throws when a read fails.
 */
export async function readPrivateGates(
  rootUri: string,
  postUri: string,
  clientFor: GateClientFor = gatePdsClient,
): Promise<PrivateGates> {
  const [threadgate, postgate] = await Promise.all([
    rootThreadgateQuery(getCurrentClients()?.queryClient, rootUri, clientFor),
    readGate<app.bsky.feed.postgate.Main>(
      clientFor,
      POSTGATE_COLLECTION,
      postUri,
    ),
  ])
  return {threadgate, postgate}
}

/**
 * How the reader relates to the thread root's author, from the public
 * AppView: `following` when the reader follows them, `followedBy` when they
 * follow the reader. `undefined` when unknown.
 */
export type ReaderRelationship = {following: boolean; followedBy: boolean}

/**
 * What a reader may do with a private post, by its gates.
 */
export type GateEvaluation = {
  replyDisabled: boolean
  embeddingDisabled: boolean
}

const RULE = {
  mention: 'app.bsky.feed.threadgate#mentionRule',
  follower: 'app.bsky.feed.threadgate#followerRule',
  following: 'app.bsky.feed.threadgate#followingRule',
  list: 'app.bsky.feed.threadgate#listRule',
} as const

const DISABLE_RULE = 'app.bsky.feed.postgate#disableRule'

/**
 * Whether the threadgate names a follower or following rule, so the
 * relationship is needed to decide it.
 */
export function needsRelationship(
  threadgate: app.bsky.feed.threadgate.Main | undefined,
): boolean {
  return !!threadgate?.allow?.some(
    rule => rule.$type === RULE.follower || rule.$type === RULE.following,
  )
}

/**
 * The reader's own evaluation of a private post's gates (7.4.2), for reader
 * `reader`, root author `rootAuthor` and post author `postAuthor`:
 *
 * - replies are disabled only when there is a threadgate with `allow`, the
 *   reader is not the root's author, and no rule is met or undecidable: an
 *   empty `allow` disables them; a rule that cannot be decided (a mention
 *   without the root's mention facets, a list, a relationship not read)
 *   leaves them enabled (fail-open, O-27);
 * - quotes are disabled when the postgate disables embedding and the reader
 *   is not the post's author.
 */
export function evaluatePrivateGates({
  reader,
  rootAuthor,
  postAuthor,
  threadgate,
  postgate,
  relationship,
  mentionedDids,
}: {
  reader: string
  rootAuthor: string
  postAuthor: string
  threadgate: app.bsky.feed.threadgate.Main | undefined
  postgate: app.bsky.feed.postgate.Main | undefined
  relationship?: ReaderRelationship
  /** The DIDs the root's mention facets name, when its facets are known. */
  mentionedDids?: readonly string[]
}): GateEvaluation {
  const embeddingDisabled =
    reader !== postAuthor &&
    !!postgate?.embeddingRules?.some(rule => rule.$type === DISABLE_RULE)
  const allow = threadgate?.allow
  if (reader === rootAuthor || !threadgate || allow === undefined) {
    return {replyDisabled: false, embeddingDisabled}
  }
  const allowed = allow.some(rule => {
    switch (rule.$type) {
      case RULE.follower:
        return !relationship || relationship.following
      case RULE.following:
        return !relationship || relationship.followedBy
      case RULE.mention:
        return !mentionedDids || mentionedDids.includes(reader)
      default:
        // A list rule, or a rule this client does not know: undecidable.
        return true
    }
  })
  return {replyDisabled: !allowed, embeddingDisabled}
}

/**
 * The DIDs a record's mention facets name, or `undefined` when it has no
 * facets array (they are not known; prism serves none yet, P-1).
 */
function mentionedDidsOf(record: unknown): string[] | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const facets = (record as {facets?: unknown}).facets
  if (!Array.isArray(facets)) return undefined
  const dids: string[] = []
  for (const facet of facets as unknown[]) {
    const features = (facet as {features?: unknown} | null)?.features
    if (!Array.isArray(features)) continue
    for (const feature of features as unknown[]) {
      const did = (feature as {did?: unknown} | null)?.did
      if (typeof did === 'string') dids.push(did)
    }
  }
  return dids
}

/**
 * The query key of one post's gate evaluation. Every key of a thread starts
 * with `['horizon-private-gates', rootUri]`, so a threadgate change
 * invalidates them all.
 */
export function privateGatesQueryKey(rootUri: string, postUri?: string) {
  return postUri === undefined
    ? ['horizon-private-gates', rootUri]
    : ['horizon-private-gates', rootUri, postUri]
}

/**
 * Read and evaluate one private post's gates for the current account: the
 * two records, and the relationship with the root's author when a rule needs
 * it (one `getRelationships` on the public AppView; a failure leaves it
 * undecidable). Throws when there is no current account or a gate read
 * fails.
 */
export async function fetchPrivateGateEvaluation(
  rootUri: string,
  postUri: string,
  clientFor: GateClientFor = gatePdsClient,
): Promise<GateEvaluation> {
  const clients = getCurrentClients()
  if (!clients) throw new Error('No current account to evaluate gates for')
  const reader = clients.did
  const rootAuthor = new AtUri(rootUri).host
  const postAuthor = new AtUri(postUri).host
  const {threadgate, postgate} = await readPrivateGates(
    rootUri,
    postUri,
    clientFor,
  )
  let relationship: ReaderRelationship | undefined
  if (reader !== rootAuthor && needsRelationship(threadgate)) {
    try {
      const res = await clients.appviewClient.call(
        app.bsky.graph.getRelationships,
        {
          actor: reader as AtIdentifierString,
          others: [rootAuthor],
        },
      )
      const found = res.relationships.find(
        item =>
          bsky.isType(app.bsky.graph.defs.relationship, item) &&
          item.did === rootAuthor,
      ) as app.bsky.graph.defs.Relationship | undefined
      if (found) {
        relationship = {
          following: !!found.following,
          followedBy: !!found.followedBy,
        }
      }
    } catch (error) {
      logger.warn('private gates: relationship unavailable', {
        safeMessage: error,
      })
    }
  }
  return evaluatePrivateGates({
    reader,
    rootAuthor,
    postAuthor,
    threadgate,
    postgate,
    relationship,
    mentionedDids: mentionedDidsOf(getPendingPost(rootUri)?.record),
  })
}

/**
 * One post's gate evaluation through the account's query cache (five
 * minutes), or read directly when there is no query client.
 */
export function privateGateEvaluation(
  queryClient: QueryClient | undefined,
  rootUri: string,
  postUri: string,
): Promise<GateEvaluation> {
  if (!queryClient) return fetchPrivateGateEvaluation(rootUri, postUri)
  return queryClient.fetchQuery({
    queryKey: privateGatesQueryKey(rootUri, postUri),
    staleTime: STALE.MINUTES.FIVE,
    queryFn: () => fetchPrivateGateEvaluation(rootUri, postUri),
  })
}

/**
 * How long a reader waits for a gate evaluation before going ahead.
 */
export const GATE_DEADLINE_MS = 3_000

/**
 * `promise`, or a rejection after `ms`.
 */
export function withGateDeadline<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('gate deadline passed')), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Whether prism applies the gates of the thread rooted at `rootUri`: it
 * lists `private.gates` and the root is private (prism applies only gates
 * whose post is a private post, 2H design 5.4).
 */
export function gatesServedForRoot(rootUri: string): boolean {
  return privateGatesServed() && isPrivatePostUri(rootUri)
}

/**
 * The evaluation a private thread's posts are rendered with (6.6 step 7):
 * `undefined` where prism applies the root's gates (`gatesServedForRoot`),
 * on a failure, or after the deadline, so the stock values stand.
 */
export async function threadGateEvaluation(
  rootUri: string,
  anchorUri: string,
): Promise<GateEvaluation | undefined> {
  if (gatesServedForRoot(rootUri)) return undefined
  try {
    return await withGateDeadline(
      privateGateEvaluation(
        getCurrentClients()?.queryClient,
        rootUri,
        anchorUri,
      ),
      GATE_DEADLINE_MS,
    )
  } catch (error) {
    logger.warn('private thread: gates not applied', {safeMessage: error})
    return undefined
  }
}

/**
 * The URI of the thread root of a post whose record is `record`: its reply
 * root, else the post itself.
 */
export function rootUriOf(postUri: string, record: unknown): string {
  if (typeof record === 'object' && record !== null) {
    const root = (record as {reply?: {root?: {uri?: unknown}}}).reply?.root
    if (typeof root?.uri === 'string') return root.uri
  }
  return postUri
}
