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
