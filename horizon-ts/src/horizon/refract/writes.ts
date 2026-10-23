/*
 * Writes that need a restored post (refract client design 9.3, 9.4). Writes
 * stay on the reader's PDS (RF-6); only the parent or quoted post is read.
 *
 * - `refractReplyFallback`: `resolveReply`'s fallback when stock `getPosts`
 *   comes back empty. The reader's own block of the parent's author refuses
 *   first ("You can’t reply to this post.", nothing written), then one
 *   `fill`, with its own re-asks inside 10 s (`resolveForWrite`). A block
 *   flag on the author, or `withheld` `blocked`, refuses the same way. A
 *   definitive answer with no post leaves stock's `ReplyDeletedError`. Prism
 *   answering not definitively, or the call failing, throws
 *   {@link ReplyParentUnavailableError}, whose fixed message carries no id.
 * - `refractLinkFallback`: `resolveLink`'s `getPost` fallback for a pasted
 *   link, the same way.
 * - The reader's own reply under a restored parent is recorded in the store
 *   when the composer's AppView wait returns it (4.2).
 */

import {PrivateReplyBlockedError} from '#/horizon/private/api/reply-block'
import {authorOfUri, hasBlockFlag} from '#/horizon/refract/answer'
import {replyNotNowText, transientText} from '#/horizon/refract/copy'
import {resolveForWrite} from '#/horizon/refract/fill'
import {refractActive} from '#/horizon/refract/gate'
import {loadOwnBlocks, ownBlockOf} from '#/horizon/refract/relations'
import {registerRefractWriteFallbacks} from '#/horizon/refract/write-hooks'
import {app, type com} from '#/lexicons'
import * as bsky from '#/types/bsky'

type PostView = app.bsky.feed.defs.PostView
type StrongRef = com.atproto.repo.strongRef.Main

/**
 * The reply's parent is a restored post prism couldn't answer for now. The
 * composer shows the message as it is (its catch uses `cleanError`); it
 * names no post and never says the post was deleted.
 */
export class ReplyParentUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplyParentUnavailableError'
  }
}

/** Parents this session's replies resolved through the fallback (4.2). */
const viaRestored = new Set<string>()

/** Whether a reply to `parentUri` resolved its parent through the fallback. */
export function resolvedViaRestoredParent(parentUri: string | undefined) {
  return !!parentUri && viaRestored.has(parentUri)
}

async function resolveRestored(uri: string): Promise<PostView | undefined> {
  const author = authorOfUri(uri)
  if (!author) return undefined
  // The block listing and the fill start together; the decision follows 9.3.
  const blocks = loadOwnBlocks()
  const fill = resolveForWrite(uri)
  await blocks
  if (ownBlockOf(author)) {
    void fill.catch(() => {})
    throw new PrivateReplyBlockedError()
  }
  const result = await fill
  switch (result.kind) {
    case 'positive':
      if (hasBlockFlag(result.post.author)) throw new PrivateReplyBlockedError()
      return result.post
    case 'blocked':
      throw new PrivateReplyBlockedError()
    case 'deleted':
      return undefined
    case 'not-now':
      throw new ReplyParentUnavailableError(replyNotNowText())
    case 'failed':
      throw new ReplyParentUnavailableError(transientText())
  }
}

/**
 * The reply refs for a parent stock didn't return, from prism (9.3), or
 * `undefined` when the parent is really gone (the caller throws
 * `ReplyDeletedError`).
 */
export async function refractReplyFallback(
  parentUri: string,
): Promise<{root: StrongRef; parent: StrongRef} | undefined> {
  if (!refractActive()) return undefined
  const post = await resolveRestored(parentUri)
  if (!post) return undefined
  const parent = {uri: post.uri, cid: post.cid}
  let root: StrongRef = parent
  if (bsky.isType(app.bsky.feed.post, post.record) && post.record.reply) {
    root = post.record.reply.root
  }
  viaRestored.add(parentUri)
  return {root, parent}
}

/**
 * A pasted link's post that stock didn't return, from prism (9.4), or
 * `undefined` when it is really gone. Its `viewer.embeddingDisabled` is
 * honoured by the caller.
 */
export async function refractLinkFallback(
  uri: string,
): Promise<PostView | undefined> {
  if (!refractActive()) return undefined
  return resolveRestored(uri)
}

registerRefractWriteFallbacks({
  reply: refractReplyFallback,
  link: refractLinkFallback,
})
