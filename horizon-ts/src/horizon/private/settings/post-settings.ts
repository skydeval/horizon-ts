/*
 * Pure helpers of the private post settings dialog (7.8), tested without the
 * design system.
 */

import deepEqual from 'fast-deep-equal'

import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {
  type AudienceEntry,
  type StandingMode,
} from '#/horizon/private/api/audiences'
import {quotesAllowed} from '#/horizon/private/composer/interaction'
import {type ComposeAudience} from '#/horizon/private/composer/state'
import {type app} from '#/lexicons'

const STANDING_MODES: readonly string[] = [
  'everyone',
  'followers',
  'following',
  'nobody',
]

/**
 * The audience the dialog shows for a private post that names `audienceUri`:
 *
 * - a reply: its conversation's audience (`parent`), which may be another
 *   account's;
 * - no audience (a self-only post): Only me;
 * - one of the account's unnamed standing audiences: that mode;
 * - otherwise the list audience.
 */
export function postSettingsAudience({
  audienceUri,
  isReply,
  audiences,
}: {
  audienceUri: string | undefined
  isReply: boolean
  audiences: readonly AudienceEntry[] | undefined
}): ComposeAudience {
  if (isReply) return {kind: 'parent', uri: audienceUri}
  if (!audienceUri) return {kind: 'mode', mode: 'nobody'}
  const entry = audiences?.find(item => item.uri === audienceUri)
  if (
    entry &&
    entry.name === undefined &&
    STANDING_MODES.includes(entry.mode)
  ) {
    return {kind: 'mode', mode: entry.mode as StandingMode}
  }
  return {kind: 'list', uri: audienceUri}
}

/**
 * What the dialog would save: the reply settings when they differ from the
 * loaded ones, and the postgate when its quote setting differs. Both
 * `undefined` when nothing changed.
 */
export function postSettingsChanges({
  loadedThreadgate,
  editedThreadgate,
  loadedPostgate,
  editedPostgate,
}: {
  loadedThreadgate: ThreadgateAllowUISetting[]
  editedThreadgate: ThreadgateAllowUISetting[] | undefined
  loadedPostgate: app.bsky.feed.postgate.Main
  editedPostgate: app.bsky.feed.postgate.Main | undefined
}): {
  threadgate: ThreadgateAllowUISetting[] | undefined
  postgate: app.bsky.feed.postgate.Main | undefined
} {
  const threadgate =
    editedThreadgate && !deepEqual(editedThreadgate, loadedThreadgate)
      ? editedThreadgate
      : undefined
  const postgate =
    editedPostgate &&
    quotesAllowed(editedPostgate) !== quotesAllowed(loadedPostgate)
      ? editedPostgate
      : undefined
  return {threadgate, postgate}
}

/**
 * What the warning under a change of who can see says (2H design 12.1):
 *
 * - `scope`: `'branch'` for a branch root (a private reply under a public
 *   post), whose own replies inside the branch are checked up the chain like
 *   anyone's; `'thread'` for a thread root, whose author's thread replies
 *   are not walked and stay visible;
 * - `interim`: the line that replies written before the change may keep
 *   their audience, shown only while prism does not read replies by their
 *   root's current audience (`private.threadAudience`).
 */
export function moveWarning({
  isReply,
  threadAudienceServed,
}: {
  isReply: boolean
  threadAudienceServed: boolean
}): {scope: 'thread' | 'branch'; interim: boolean} {
  return {scope: isReply ? 'branch' : 'thread', interim: !threadAudienceServed}
}
