/*
 * The "other replies" continuation of a thread (2H design 9.3): where the
 * main thread read stopped in prism's private replies to its anchor, so the
 * stock other-replies query ("Show more replies") reads on from there.
 *
 * Keyed by the account and the `anchor` string the thread hook was given (the
 * other query's key is `createPostThreadOtherQueryKey({anchor})`). Written by
 * the private thread read (9.1) and the public thread's branches (9.2), and
 * replaced by every main read of that anchor. A plain module: nothing runs at
 * import.
 */

import {getCurrentDid} from '#/horizon/routing/current-clients'

/**
 * Where an anchor's private replies continue.
 */
export type ReplyContinuation = {
  /** The anchor is a private post, or a public post with private branches. */
  kind: 'private' | 'public'
  /** The anchor's URI with a DID authority. */
  anchorUri: string
  /** prism's `getReplies` cursor; `undefined` reads from the first page. */
  cursor: string | undefined
  /** `getReplies` depth below each direct reply. */
  depth: number
  sort: string | undefined
  branchingFactor: number | undefined
  /** Direct replies already shown, left out of the continuation. */
  seen: Set<string>
  /** CIDs of posts the replies refer to, for refs prism served without one. */
  cids: Map<string, string>
  /** Whether the stock other-replies call also has something (public only). */
  stockHasOther: boolean
  /**
   * The continuation's identity (hidden replies design 4.1, 4.2): its `kind`,
   * `pages` as the thread read computed it and its `hidden` sorted, in one
   * string (`continuationKey`). The row's correction narrowing `pages` (6.4)
   * leaves it as written. `''` stands for no continuation.
   */
  key: string
  /** The candidate hidden reply URIs, in the gate's order (4.2, 5.3). */
  hidden: string[]
  /**
   * Whether `getReplies` is read at all: false when only hidden replies (and,
   * on a public anchor, the stock part) remain.
   */
  pages: boolean
  /** The `fetchStamp()` of the thread read that wrote it (6.3). */
  readAt: number
}

/**
 * The key of a continuation (4.1): equal for equal `kind`, `pages` and
 * `hidden` in any order.
 */
export function continuationKey({
  kind,
  pages,
  hidden,
}: Pick<ReplyContinuation, 'kind' | 'pages' | 'hidden'>): string {
  return `${kind}|${pages ? 'pages' : 'no-pages'}|${[...hidden].sort().join(' ')}`
}

const continuations = new Map<string, ReplyContinuation>()

function keyOf(anchor: string): string {
  return `${getCurrentDid() ?? ''} ${anchor}`
}

/**
 * Store the continuation of `anchor` for the current account.
 */
export function setReplyContinuation(
  anchor: string,
  continuation: ReplyContinuation,
) {
  continuations.set(keyOf(anchor), continuation)
}

/**
 * Forget the continuation of `anchor` for the current account.
 */
export function clearReplyContinuation(anchor: string) {
  continuations.delete(keyOf(anchor))
}

/**
 * The current account's continuation of `anchor`, if any.
 */
export function getReplyContinuation(
  anchor: string,
): ReplyContinuation | undefined {
  return continuations.get(keyOf(anchor))
}

/**
 * Forget every continuation (tests).
 */
export function resetReplyContinuations() {
  continuations.clear()
}
