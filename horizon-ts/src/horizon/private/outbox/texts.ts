/*
 * The outbox's fixed texts (2K design 4.9, 8.4). A failure is kept as an id
 * and shown with its text here: never a server's or the encoder's message.
 */

import {t} from '@lingui/core/macro'

/**
 * Why an outbox entry is not posted (2K design 4.9), kept in its record.
 */
export type OutboxFailure =
  | 'route'
  | 'parent-unavailable'
  | 'parent-busy'
  | 'reply-refused'
  | 'parent-not-posted'
  | 'parent-partly'
  | 'parent-undecided'
  | 'parent-gone'
  | 'audience-missing'
  | 'encoder'
  | 'upload'
  | 'gates'
  | 'network'
  | 'rate-limited'
  | 'kryphocron-host'
  | 'video-blob'
  | 'post'
  | 'not-saved'
  | 'changed'
  | 'delete-posted'
  | 'delete-discard'

const FAILURES: readonly OutboxFailure[] = [
  'route',
  'parent-unavailable',
  'parent-busy',
  'reply-refused',
  'parent-not-posted',
  'parent-partly',
  'parent-undecided',
  'parent-gone',
  'audience-missing',
  'encoder',
  'upload',
  'gates',
  'network',
  'rate-limited',
  'kryphocron-host',
  'video-blob',
  'post',
  'not-saved',
  'changed',
  'delete-posted',
  'delete-discard',
]

export function isOutboxFailure(value: unknown): value is OutboxFailure {
  return FAILURES.includes(value as OutboxFailure)
}

/**
 * Whether the failure is a reply's, behind a parent that was not posted
 * (2K design PA-28 step 2): Retry waits for the parent's successful post,
 * and never comes after `parent-gone`.
 */
export function isParentFailure(failure: OutboxFailure | undefined): boolean {
  return (
    failure === 'parent-not-posted' ||
    failure === 'parent-partly' ||
    failure === 'parent-undecided' ||
    failure === 'parent-gone'
  )
}

/**
 * The text of a failure. `partly` picks the "Partly posted" wording where
 * one differs (a dropped video blob).
 */
export function outboxFailureText(
  failure: OutboxFailure | undefined,
  {partly = false}: {partly?: boolean} = {},
): string {
  switch (failure) {
    case 'route':
      return t`Private posting isn’t available for your account right now. Nothing was posted.`
    case 'parent-unavailable':
      return t`You can’t reply to this post. It may have been deleted, or it is no longer visible to you.`
    case 'parent-busy':
      return t`Couldn’t reach the post you’re replying to. Try again in a moment.`
    case 'reply-refused':
      return t`You can’t reply in this conversation. You may not be among the people who can see it.`
    case 'parent-not-posted':
    case 'parent-gone':
      return t`The post you replied to wasn’t posted.`
    case 'parent-partly':
      return t`The thread you replied to was only partly posted.`
    case 'parent-undecided':
      return t`Horizon is still checking whether the post you replied to was posted.`
    case 'audience-missing':
      return t`This audience no longer exists. Choose another audience.`
    case 'encoder':
      return t`Private posting isn’t available right now. Nothing was posted.`
    case 'upload':
      return t`An image or video couldn’t be uploaded. Try again.`
    case 'gates':
      return t`Your reply and quote settings couldn’t be saved, so nothing was posted. Try again.`
    case 'network':
      return t`Post failed to upload. Please check your Internet connection and try again.`
    case 'rate-limited':
      return t`Your server is limiting posts right now. Try again later.`
    case 'kryphocron-host':
      return t`Your server has its own way to post privately. Try again.`
    case 'video-blob':
      return partly
        ? t`The video needs adding again. Delete what was posted, then use Edit.`
        : t`The video needs adding again. Use Edit.`
    case 'not-saved':
      return t`Horizon couldn’t save this post on this device. Nothing was posted.`
    case 'changed':
      return t`This post changed since it was posted. Delete what was posted, then use Edit.`
    case 'delete-posted':
      return t`Deleting didn’t finish. Try again.`
    case 'delete-discard':
      return t`Discard didn’t finish. Try again.`
    case 'post':
    case undefined:
      return t`Your server couldn’t save this post. Try again.`
  }
}

export function sendingText(): string {
  return t`Posting...`
}

export function undecidedText(): string {
  return t`Checking whether this was posted...`
}

export function elsewhereText(): string {
  return t`Posting in another tab...`
}

export function notPostedLabel(): string {
  return t`Not posted`
}

export function partlyPostedLabel(): string {
  return t`Partly posted`
}

/**
 * The note on an entry whose media were dropped (after a reload, or in
 * another tab).
 */
export function mediaDroppedText(flagged: boolean): string {
  return flagged
    ? t`Images or video need adding again. Mark them as spoilers again.`
    : t`Images or video need adding again.`
}

export function notPostedToastText(): string {
  return t`Your private post wasn’t posted. It’s saved on this device in Unsent.`
}

export function partlyPostedToastText(): string {
  return t`Only part of your private post was posted. Finish or delete it in Unsent.`
}

export function handledElsewhereText(): string {
  return t`This post was handled in another tab.`
}

export function deleteIncompleteToastText(): string {
  return t`Some of this post couldn’t be deleted. Try again.`
}

export function alreadyPostedToastText(): string {
  return t`This post was already posted.`
}
