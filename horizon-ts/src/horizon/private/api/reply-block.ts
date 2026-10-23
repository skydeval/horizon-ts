/*
 * The reply block check (private reply design 2; skydeval, 2026-10-23): a
 * private reply is never written when the member and a pair author have a
 * block either way. The pairs are the immediate parent's author and the
 * thread's owner (the anchor's author: the original poster, or a branch
 * root's author), model (c): the original poster controls their own thread.
 * A block with anyone else further up is soft and is not checked. A reply
 * with no pair (the member's own parent in the member's own thread) is not
 * checked.
 *
 * The verdict is `clear`, `blocked` or `unknown`, and only `clear` lets a
 * plan out (`planFirstPost`). It covers public and list blocks, from one
 * `app.bsky.graph.getRelationships` for every pair on the member's chosen
 * public AppView, sent with the member's session so `blockedBy` and the list
 * fields are filled in. Kryphocron blocks (`tools.kryphocron.graph.block`)
 * are halted (skydeval, 2026-10-23), so no private block is read.
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
import {REPLY_BLOCK_CHECK} from '#/horizon/switches'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

export {REPLY_BLOCK_CHECK}

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
  /**
   * The check just before the first post write (RB-13, both routes) takes
   * the verdict again only when it is older than this (PR7-L1): counted from
   * the plan's start, 2 s would send every ordinary reply with a gate
   * through another read.
   */
  prePostFreshMs: 10_000,
}

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
 * The block check could not be made (the AppView unreachable or erroring),
 * so nothing was written. It carries the outbox's neutral `parent-busy`
 * text, which the locus route's composer shows.
 */
export class PrivateReplyCheckError extends Error {
  constructor() {
    super(t`Couldn’t reach the post you’re replying to. Try again in a moment.`)
    this.name = 'PrivateReplyCheckError'
  }
}

/**
 * One pair of the check: the member and `did` (the parent's author, or the
 * thread's owner).
 */
export type ReplyBlockPair = {did: string}

/**
 * What a plan keeps of its check, so the run can take it again before the
 * first write. Never built with an empty `pairs`: no pair is `undefined`.
 */
export type ReplyBlockCheck = {
  pairs: ReplyBlockPair[]
  /** When the verdict was taken: the start of the plan or of a re-check. */
  checkedAt: number
}

/**
 * The clients the check reads with.
 */
export type ReplyBlockClients = {
  /** The member. */
  did: string
  /** The member's signed-in public AppView client. */
  appviewClient: Client
}

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
 * Whether a reply to `parentUri` by `did` needs the parent's author pair: the
 * switch is on and the parent is another author's. The thread's owner is the
 * check's other pair, known once placement settles (`planFirstPost`); a block
 * with anyone else further up is soft (model (c)).
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
 * deadline included, is `onFail`.
 */
async function withDeadline<T>(
  part: string,
  onFail: T,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(onFail)
    }, REPLY_BLOCK_TIMING.callMs)
  })
  try {
    return await Promise.race([read(controller.signal), deadline])
  } catch (error) {
    logger.info('reply block check: read failed', {part, safeMessage: error})
    return onFail
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Public and list blocks between `did` and each of `others`, from one
 * AppView call. Any of the four block fields is `blocked`. No relationship
 * for a DID (a `notFoundActor`, or none at all) is `unknown`. The list
 * fields are present only when a list block exists, so their absence reads
 * as no list block on any AppView; prism's own `blocked` covers list blocks
 * for every member too (`private.listBlocks`). A failed call, or the
 * deadline, is `unknown` for every DID; no DID asked about, no call.
 */
export async function readAppviewRelationships(
  appviewClient: Client,
  did: string,
  others: readonly string[],
): Promise<Map<string, BlockVerdict>> {
  if (others.length === 0) return new Map()
  const allUnknown = new Map<string, BlockVerdict>(
    others.map(other => [other, 'unknown']),
  )
  return withDeadline('appview', allUnknown, async signal => {
    const res = await appviewClient.call(
      app.bsky.graph.getRelationships,
      {
        actor: did as AtIdentifierString,
        others: others as DidString[],
      },
      {signal},
    )
    const verdicts = new Map<string, BlockVerdict>()
    for (const other of others) {
      const found = res.relationships.find(
        item =>
          bsky.isType(app.bsky.graph.defs.relationship, item) &&
          item.did === other,
      ) as app.bsky.graph.defs.Relationship | undefined
      if (!found) {
        verdicts.set(other, 'unknown')
      } else if (
        found.blocking ||
        found.blockedBy ||
        found.blockingByList ||
        found.blockedByList
      ) {
        verdicts.set(other, 'blocked')
      } else {
        verdicts.set(other, 'clear')
      }
    }
    return verdicts
  })
}

/**
 * Public and list blocks between `did` and `authorDid`, from the AppView:
 * {@link readAppviewRelationships} for one DID.
 */
export async function readAppviewBlocks(
  appviewClient: Client,
  did: string,
  authorDid: string,
): Promise<BlockVerdict> {
  const verdicts = await readAppviewRelationships(appviewClient, did, [
    authorDid,
  ])
  return verdicts.get(authorDid) ?? 'unknown'
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
 * Take a plan's check again before a gate or post write, when it is older
 * than `freshMs` (PR2-L1) or `force` is set: one AppView call for every
 * pair. Throws {@link PrivateReplyBlockedError} or
 * {@link PrivateReplyCheckError} when the verdict is not `clear`. A recent
 * verdict, or no check (no pair), reads nothing.
 *
 * Returns the check it holds (PR4-N1): a new one whose `checkedAt` is this
 * call's start when it read, the same one when it did not, so a later call
 * measures freshness from the last verdict taken.
 */
export async function recheckReplyBlock(
  clients: ReplyBlockClients,
  check: ReplyBlockCheck | undefined,
  {
    force = false,
    freshMs = REPLY_BLOCK_TIMING.freshMs,
  }: {
    force?: boolean
    /**
     * How old the verdict may be before it is taken again: `freshMs` after
     * the uploads, `prePostFreshMs` just before the first post write.
     */
    freshMs?: number
  } = {},
): Promise<ReplyBlockCheck | undefined> {
  if (!REPLY_BLOCK_CHECK || !check) return check
  if (!force && Date.now() - check.checkedAt < freshMs) return check
  const startedAt = Date.now()
  const dids = check.pairs.map(pair => pair.did)
  const relations = await readAppviewRelationships(
    clients.appviewClient,
    clients.did,
    dids,
  )
  const verdict = combineVerdicts(
    dids.map(did => relations.get(did) ?? 'unknown'),
  )
  if (verdict !== 'clear') {
    logger.info('reply block check: recheck refused', {verdict})
  }
  assertClear(verdict)
  return {pairs: check.pairs, checkedAt: startedAt}
}
