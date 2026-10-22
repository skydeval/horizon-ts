/*
 * Saving a private post's reply and quote limits from the post settings
 * dialog (7.8): the stock read-modify-write helpers on the account's own PDS,
 * with one rule of Horizon's on top. A gate record sits at its post's rkey,
 * and a public and a private post may share an rkey (U7.6), so a gate found
 * there that names another post is never overwritten: the save is refused.
 *
 * The stock `useSetThreadgateAllowMutation` is not used: its success handler
 * polls the public AppView for the threadgate view, which never answers for a
 * private post.
 */

import {type Client} from '@atproto/lex'
import {AtUri} from '@atproto/syntax'
import {t} from '@lingui/core/macro'

import {upsertPostgate} from '#/state/queries/postgate'
import {createPostgateRecord} from '#/state/queries/postgate/util'
import {upsertThreadgate} from '#/state/queries/threadgate'
import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {
  createThreadgateRecord,
  threadgateAllowUISettingToAllowRecordValue,
} from '#/state/queries/threadgate/util'
import {readOutboxRecord} from '#/horizon/private/outbox/record'
import {getPendingPost, pendingPhase} from '#/horizon/private/store'
import {type app} from '#/lexicons'

/**
 * A gate at the post's rkey names another post; nothing was written to it.
 */
export class PrivateGateConflictError extends Error {
  constructor() {
    super(t`These settings can’t be saved for this post.`)
    this.name = 'PrivateGateConflictError'
  }
}

/**
 * The post (or its thread root) is still being posted by the outbox, or its
 * compose failed (2K design PA-28 step 3, K10-L3): its gates are the
 * outbox's until it is written. Nothing was read or written. `phase` picks
 * the text (K11-N2): `failed` for a Not posted or Partly posted compose;
 * `sending` for one still being sent, or undecided (it may yet be found
 * posted).
 */
export class PrivatePostPendingError extends Error {
  constructor(readonly phase: 'sending' | 'failed') {
    super(
      phase === 'failed'
        ? t`This post wasn’t fully posted. Finish or delete it in Unsent.`
        : t`This post is still being posted. Try again once it’s posted.`,
    )
    this.name = 'PrivatePostPendingError'
  }
}

/**
 * The backstop's answer for one URI: the pending post's phase as the text
 * needs it, or `undefined` when it is written or not pending. A `failed`
 * entry whose outbox record is `undecided` reads as `sending`.
 */
export function pendingGatePhase(
  uri: string,
  did: string,
): 'sending' | 'failed' | undefined {
  const entry = getPendingPost(uri, did)
  if (!entry) return undefined
  const phase = pendingPhase(entry)
  if (phase === 'written') return undefined
  if (
    phase === 'failed' &&
    entry.outboxId &&
    readOutboxRecord(did, entry.outboxId)?.state === 'undecided'
  ) {
    return 'sending'
  }
  return phase
}

/**
 * Save what the dialog changed:
 *
 * - `threadgate` (new reply settings), only when the current account owns
 *   the thread root (where the threadgate lives); a change back to Anyone
 *   writes no `allow`, as stock;
 * - `postgate` (the post's gate with the new quote setting): its embedding
 *   rules are written over the stored postgate, keeping its detached quotes.
 *
 * Throws {@link PrivateGateConflictError} when a stored gate names another
 * post, and any write failure as it comes.
 */
export async function savePrivatePostGates({
  pdsClient,
  currentDid,
  postUri,
  rootUri,
  threadgate,
  postgate,
}: {
  pdsClient: Client
  currentDid: string
  postUri: string
  rootUri: string
  threadgate?: ThreadgateAllowUISetting[]
  postgate?: app.bsky.feed.postgate.Main
}): Promise<void> {
  // The backstop (K10-L3): before any read or write.
  const pending =
    pendingGatePhase(postUri, currentDid) ??
    pendingGatePhase(rootUri, currentDid)
  if (pending) throw new PrivatePostPendingError(pending)
  const writes: Promise<void>[] = []
  if (threadgate && new AtUri(rootUri).host === currentDid) {
    const allow = threadgateAllowUISettingToAllowRecordValue(threadgate)
    writes.push(
      upsertThreadgate({pdsClient, postUri: rootUri}, prev => {
        if (prev && prev.post !== rootUri) {
          return Promise.reject(new PrivateGateConflictError())
        }
        return Promise.resolve(
          prev
            ? {...prev, allow}
            : createThreadgateRecord({post: rootUri, allow}),
        )
      }),
    )
  }
  if (postgate) {
    writes.push(
      upsertPostgate({pdsClient, postUri}, prev => {
        if (prev && prev.post !== postUri) {
          return Promise.reject(new PrivateGateConflictError())
        }
        const base = prev ?? createPostgateRecord({post: postUri})
        return Promise.resolve({
          ...base,
          embeddingRules: postgate.embeddingRules ?? [],
        })
      }),
    )
  }
  await Promise.all(writes)
}
