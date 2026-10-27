/*
 * The quote slot's status (refract client design 4.4, as changed by
 * skydeval 2026-10-27), pure, so it can be tested without the UI.
 *
 * A quote Bluesky can't find shows "Deleted" at once, as Bluesky's app does,
 * and the slot keeps asking in the background: a restored post replaces it
 * when one comes back. It used to hold a loading card until prism answered
 * "not restored", so that a restored quote never showed "Deleted" first;
 * nearly every such quote really is deleted, and the wait was felt on all of
 * them. "Blocked" shows for an author in the reader's own block set, an
 * author whose profile in the answer has a block flag, or a URI withheld as
 * `blocked`.
 */

import {authorOfUri} from '#/horizon/refract/answer'
import {type UriOutcome} from '#/horizon/refract/fill'
import {ownBlockOf} from '#/horizon/refract/relations'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** What the slot shows. */
export type RestoredQuoteStatus =
  {kind: 'post'; post: PostView} | {kind: 'deleted'} | {kind: 'blocked'}

/**
 * The slot's status from what is known now (pure, for tests): the stored
 * post and the URI's last outcome.
 */
export function quoteStatusOf(
  uri: string,
  post: PostView | undefined,
  outcome: UriOutcome | undefined,
): RestoredQuoteStatus {
  const author = authorOfUri(uri)
  if (author && ownBlockOf(author)) return {kind: 'blocked'}
  if (post) return {kind: 'post', post}
  if (outcome?.kind === 'positive') return {kind: 'post', post: outcome.post}
  if (outcome?.kind === 'blocked') return {kind: 'blocked'}
  return {kind: 'deleted'}
}
