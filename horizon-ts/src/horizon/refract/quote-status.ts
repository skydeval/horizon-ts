/*
 * The quote slot's status (refract client design 4.4), pure, so it can be
 * tested without the UI: "Deleted" only for a definitive answer, "Blocked"
 * for blocks, the placeholder while an answer is pending (up to the
 * background deadline), and "Couldn’t load right now" otherwise.
 */

import {authorOfUri} from '#/horizon/refract/answer'
import {isDefinitelyNotRestored, type UriOutcome} from '#/horizon/refract/fill'
import {ownBlockOf} from '#/horizon/refract/relations'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** What the slot shows. */
export type RestoredQuoteStatus =
  | {kind: 'loading'}
  | {kind: 'post'; post: PostView}
  | {kind: 'deleted'}
  | {kind: 'blocked'}
  | {kind: 'unavailable'}

/**
 * The slot's status from what is known now (pure, for tests): the stored
 * post, the URI's last outcome, and whether the background deadline passed.
 */
export function quoteStatusOf(
  uri: string,
  post: PostView | undefined,
  outcome: UriOutcome | undefined,
  deadlinePassed: boolean,
): RestoredQuoteStatus {
  const author = authorOfUri(uri)
  if (author && ownBlockOf(author)) return {kind: 'blocked'}
  if (post) return {kind: 'post', post}
  if (!outcome) {
    if (author && isDefinitelyNotRestored(author)) return {kind: 'deleted'}
    return deadlinePassed ? {kind: 'unavailable'} : {kind: 'loading'}
  }
  switch (outcome.kind) {
    case 'positive':
      return {kind: 'post', post: outcome.post}
    case 'blocked':
      return {kind: 'blocked'}
    case 'gone':
    case 'missing':
      return {kind: 'deleted'}
    case 'author':
      if (outcome.author === 'pending' || outcome.author === 'confirm') {
        return deadlinePassed ? {kind: 'unavailable'} : {kind: 'loading'}
      }
      return {kind: 'unavailable'}
    case 'unresolved':
    case 'unavailable':
    case 'failed':
      return {kind: 'unavailable'}
  }
}
