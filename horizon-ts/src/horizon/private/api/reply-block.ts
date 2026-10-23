/*
 * The reply block check (private reply design 2; skydeval, 2026-10-23): a
 * private reply is never written when the member and the author of the post
 * being replied to have a block either way. Only the immediate parent's
 * author counts, never the thread root or anyone further up. A reply to the
 * member's own post has no pair and is not checked.
 *
 * The verdict is `clear`, `blocked` or `unknown`, and only `clear` lets a
 * plan out (`planFirstPost`). It covers:
 *
 * - **public and list blocks**, from one `app.bsky.graph.getRelationships`
 *   on the member's chosen public AppView, sent with the member's session so
 *   `blockedBy` and the list fields are filled in;
 * - **private blocks** (`tools.kryphocron.graph.block`): when prism served
 *   the parent in this run, prism's read rule already related the pair
 *   (`prism:private_tier/schema.rs:549`), so nothing more is read; otherwise
 *   the two public listings of that collection, the member's for the author
 *   and the author's for the member.
 *
 * prism's `blocked` does not read list blocks, so prism's serve alone lets a
 * list-blocked reply through; this check closes that without depending on
 * prism. Once prism ships list blocks in `blocked` (feature id to come), the
 * AppView part can be limited to the paths that skip prism's parent read
 * (a private reply to a public post). Until then it runs on every private
 * reply to another author, behind {@link REPLY_BLOCK_CHECK}.
 *
 * Nothing is cached: each run takes its own verdict. Logs name the part and
 * the verdict only, never a DID or a record.
 */

import {type Client} from '@atproto/lex'
import {type AtIdentifierString, AtUri, type DidString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'

import {logger} from '#/logger'
import {gatePdsClient} from '#/horizon/private/api/gates'
import {REPLY_BLOCK_CHECK} from '#/horizon/switches'
import {app, com} from '#/lexicons'
import * as bsky from '#/types/bsky'

export {REPLY_BLOCK_CHECK}

/**
 * The collection of private blocks, as prism ingests it.
 */
export const PRIVATE_BLOCK_COLLECTION = 'tools.kryphocron.graph.block'

/**
 * The check's timing. Mutable for tests.
 */
export const REPLY_BLOCK_TIMING = {
  /** Each read's deadline; a read past it is `unknown`. */
  callMs: 10_000,
  /**
   * A verdict older than this when the first gate or post is about to be
   * written is taken again (PR2-L1): uploads can run for minutes between
   * the plan and the writes.
   */
  freshMs: 2_000,
}

/**
 * Pages of 100 read from one private block listing before giving up as
 * `unknown`.
 */
export const PRIVATE_BLOCK_PAGES_MAX = 5

export type BlockVerdict = 'clear' | 'blocked' | 'unknown'

/**
 * The member and the author of the post being replied to have a block
 * either way. Nothing was written. The text never says who blocked whom.
 */
export class PrivateReplyBlockedError extends Error {
  constructor() {
    super(t`You can’t reply to this post.`)
    this.name = 'PrivateReplyBlockedError'
  }
}

/**
 * The block check could not be made (the AppView or a PDS unreachable or
 * erroring), so nothing was written. It carries the outbox's neutral
 * `parent-busy` text, which the locus route's composer shows.
 */
export class PrivateReplyCheckError extends Error {
  constructor() {
    super(t`Couldn’t reach the post you’re replying to. Try again in a moment.`)
    this.name = 'PrivateReplyCheckError'
  }
}

/**
 * Where a plan's private-block verdict came from: prism's serve of the
 * parent in this run, or the two listings.
 */
export type PrivateBlockSource = 'prism' | 'listings'

/**
 * What a plan keeps of its check, so the run can take it again before the
 * first write.
 */
export type ReplyBlockCheck = {
  authorDid: string
  privateBlocks: PrivateBlockSource
  checkedAt: number
}

/**
 * The clients the check reads with.
 */
export type ReplyBlockClients = {
  /** The member. */
  did: string
  /** The member's own PDS, for the member's listing. */
  pdsClient: Client
  /** The member's signed-in public AppView client. */
  appviewClient: Client
}

/**
 * A client for reading another account's repo without a session.
 */
export type RepoClientFor = (did: string) => Promise<Client>

/**
 * The author of a post URI, or `undefined` when it does not parse.
 */
export function parentAuthorOf(uri: string): string | undefined {
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

/**
 * Whether a reply to `parentUri` by `did` needs the check: the switch is on
 * and the parent is another author's.
 */
export function needsReplyBlockCheck(
  did: string,
  parentUri: string | undefined,
): boolean {
  if (!REPLY_BLOCK_CHECK || !parentUri) return false
  return parentAuthorOf(parentUri) !== did
}

/**
 * Run `read` under {@link REPLY_BLOCK_TIMING.callMs}; any failure, the
 * deadline included, is `unknown`.
 */
async function withDeadline(
  part: string,
  read: (signal: AbortSignal) => Promise<BlockVerdict>,
): Promise<BlockVerdict> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<BlockVerdict>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('unknown')
    }, REPLY_BLOCK_TIMING.callMs)
  })
  try {
    return await Promise.race([read(controller.signal), deadline])
  } catch (error) {
    logger.info('reply block check: read failed', {part, safeMessage: error})
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Public and list blocks between `did` and `authorDid`, from the AppView.
 * Any of the four block fields is `blocked`. No relationship for the author
 * (a `notFoundActor`, or none at all) is `unknown`. The list fields are
 * present only when a list block exists, so their absence reads as no list
 * block on any AppView; prism's own `blocked` covers list blocks for every
 * member too (`private.listBlocks`).
 */
export function readAppviewBlocks(
  appviewClient: Client,
  did: string,
  authorDid: string,
): Promise<BlockVerdict> {
  return withDeadline('appview', async signal => {
    const res = await appviewClient.call(
      app.bsky.graph.getRelationships,
      {actor: did as AtIdentifierString, others: [authorDid as DidString]},
      {signal},
    )
    const found = res.relationships.find(
      item =>
        bsky.isType(app.bsky.graph.defs.relationship, item) &&
        item.did === authorDid,
    ) as app.bsky.graph.defs.Relationship | undefined
    if (!found) return 'unknown'
    if (
      found.blocking ||
      found.blockedBy ||
      found.blockingByList ||
      found.blockedByList
    ) {
      return 'blocked'
    }
    return 'clear'
  })
}

/**
 * Whether `repo`'s private blocks name `subject`, read through `client` in
 * pages of 100 up to {@link PRIVATE_BLOCK_PAGES_MAX}. Only `subject` is
 * read; past the bound is `unknown`.
 */
export function readPrivateBlockListing(
  client: Client | Promise<Client>,
  repo: string,
  subject: string,
): Promise<BlockVerdict> {
  return withDeadline('listing', async signal => {
    const reader = await client
    let cursor: string | undefined
    for (let page = 0; page < PRIVATE_BLOCK_PAGES_MAX; page++) {
      const res = await reader.call(
        com.atproto.repo.listRecords,
        {
          repo: repo as DidString,
          collection: PRIVATE_BLOCK_COLLECTION,
          limit: 100,
          cursor,
        },
        {signal},
      )
      for (const record of res.records) {
        const value = record.value as {subject?: unknown} | undefined
        if (value?.subject === subject) return 'blocked'
      }
      if (!res.cursor || res.records.length === 0) return 'clear'
      cursor = res.cursor
    }
    return 'unknown'
  })
}

/**
 * Private blocks between `did` and `authorDid` from the two listings: the
 * member's own repo through their PDS, the author's through an
 * unauthenticated client for the author's PDS.
 */
export async function readPrivateBlocks(
  clients: ReplyBlockClients,
  authorDid: string,
  clientFor: RepoClientFor = gatePdsClient,
): Promise<BlockVerdict> {
  const verdicts = await Promise.all([
    readPrivateBlockListing(clients.pdsClient, clients.did, authorDid),
    readPrivateBlockListing(clientFor(authorDid), authorDid, clients.did),
  ])
  return combineVerdicts(verdicts)
}

/**
 * `blocked` if any part says so; `clear` only if every part does.
 */
export function combineVerdicts(verdicts: BlockVerdict[]): BlockVerdict {
  if (verdicts.includes('blocked')) return 'blocked'
  return verdicts.every(verdict => verdict === 'clear') ? 'clear' : 'unknown'
}

/**
 * Throw for a verdict that is not `clear`.
 */
export function assertClear(verdict: BlockVerdict) {
  if (verdict === 'blocked') throw new PrivateReplyBlockedError()
  if (verdict === 'unknown') throw new PrivateReplyCheckError()
}

/**
 * Take a plan's check again just before the first gate or post write, when
 * it is older than {@link REPLY_BLOCK_TIMING.freshMs} (PR2-L1): the same
 * parts the plan used, in one parallel round trip. Throws
 * {@link PrivateReplyBlockedError} or {@link PrivateReplyCheckError} when
 * the verdict is not `clear`. A recent verdict, or no check (no pair), reads
 * nothing.
 */
export async function recheckReplyBlock(
  clients: ReplyBlockClients,
  check: ReplyBlockCheck | undefined,
  clientFor: RepoClientFor = gatePdsClient,
): Promise<void> {
  if (!check) return
  if (Date.now() - check.checkedAt < REPLY_BLOCK_TIMING.freshMs) return
  const parts = [
    readAppviewBlocks(clients.appviewClient, clients.did, check.authorDid),
  ]
  if (check.privateBlocks === 'listings') {
    parts.push(readPrivateBlocks(clients, check.authorDid, clientFor))
  }
  const verdict = combineVerdicts(await Promise.all(parts))
  if (verdict !== 'clear') {
    logger.info('reply block check: recheck refused', {verdict})
  }
  assertClear(verdict)
}
