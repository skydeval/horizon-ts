/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * Which of an account's notifications a push should show, and how each reads.
 * The push service only says "check"; this decides, from the account's own
 * notification list and push settings, what is new and wanted.
 */

import {type I18n} from '@lingui/core'
import {msg, plural} from '@lingui/core/macro'

import {type app} from '#/lexicons'

type Notif = app.bsky.notification.listNotifications.Notification
type Prefs = app.bsky.notification.defs.Preferences

/** A notification as the phone shows it. */
export type Shown = {
  title: string
  body?: string
  /** The Android channel, one per reason, as Bluesky's pushes use. */
  channel: string
  /** The tap payload, in the shape of Bluesky's pushes for the reason. */
  data: {reason: string; recipientDid: string} & Record<string, string>
}

/** With nothing shown before on this phone, only this recent is new. */
export const FIRST_CHECK_WINDOW_MS = 15 * 60 * 1000

/** More new notifications than this become one summary. */
export const MAX_SINGLE = 4

/** Reasons shown, with their preference key and channel. */
const REASONS: Record<string, {pref: keyof Prefs; channel: string}> = {
  like: {pref: 'like', channel: 'like'},
  repost: {pref: 'repost', channel: 'repost'},
  follow: {pref: 'follow', channel: 'follow'},
  mention: {pref: 'mention', channel: 'mention'},
  reply: {pref: 'reply', channel: 'reply'},
  quote: {pref: 'quote', channel: 'quote'},
  'like-via-repost': {pref: 'likeViaRepost', channel: 'like-via-repost'},
  'repost-via-repost': {pref: 'repostViaRepost', channel: 'repost-via-repost'},
  'subscribed-post': {pref: 'subscribedPost', channel: 'subscribed-post'},
}

/** Whether the account's push settings allow this notification. */
function wanted(n: Notif, prefs: Prefs | undefined): boolean {
  const reason = REASONS[n.reason]
  if (!reason) return false
  const pref = prefs?.[reason.pref] as
    | {push?: boolean; include?: string}
    | undefined
  if (pref?.push === false) return false
  if (pref?.include === 'follows' && !n.author.viewer?.following) return false
  return true
}

function hidden(n: Notif): boolean {
  const v = n.author.viewer
  return Boolean(v?.muted || v?.blocking || v?.blockedBy)
}

/**
 * The notifications to show: unread, newer than the last one shown on this
 * phone (or recent, the first time), wanted by the account's push settings,
 * and not from a muted or blocked account. Oldest first.
 */
export function pickNew(
  notifications: Notif[],
  {
    prefs,
    lastShown,
    now,
  }: {prefs: Prefs | undefined; lastShown: string | undefined; now: number},
): Notif[] {
  const since = lastShown ?? new Date(now - FIRST_CHECK_WINDOW_MS).toISOString()
  return notifications
    .filter(n => !n.isRead && n.indexedAt > since && wanted(n, prefs) && !hidden(n))
    .sort((a, b) => (a.indexedAt < b.indexedAt ? -1 : 1))
}

/** The newest `indexedAt` among the notifications, or `lastShown`. */
export function newestShown(
  notifications: Notif[],
  lastShown: string | undefined,
): string | undefined {
  let newest = lastShown
  for (const n of notifications) {
    if (!newest || n.indexedAt > newest) newest = n.indexedAt
  }
  return newest
}

function text(record: unknown): string | undefined {
  const t = (record as {text?: unknown} | undefined)?.text
  return typeof t === 'string' && t.trim() ? t : undefined
}

/**
 * How one notification reads. `subjectText` is the text of the liked or
 * reposted post, when known.
 */
export function describe(
  i18n: I18n,
  n: Notif,
  recipientDid: string,
  subjectText?: string,
): Shown {
  const name = n.author.displayName?.trim() || `@${n.author.handle}`
  let title: string
  let body: string | undefined
  switch (n.reason) {
    case 'like':
      title = i18n._(msg`${name} liked your post`)
      body = subjectText
      break
    case 'repost':
      title = i18n._(msg`${name} reposted your post`)
      body = subjectText
      break
    case 'follow':
      title = i18n._(msg`${name} followed you`)
      break
    case 'mention':
      title = i18n._(msg`${name} mentioned you`)
      body = text(n.record)
      break
    case 'reply':
      title = i18n._(msg`${name} replied to you`)
      body = text(n.record)
      break
    case 'quote':
      title = i18n._(msg`${name} quoted your post`)
      body = text(n.record)
      break
    case 'like-via-repost':
      title = i18n._(msg`${name} liked your repost`)
      break
    case 'repost-via-repost':
      title = i18n._(msg`${name} reposted your repost`)
      break
    case 'subscribed-post':
      title = i18n._(msg`${name} posted`)
      body = text(n.record)
      break
    default:
      title = i18n._(msg`New activity from ${name}`)
  }
  return {
    title,
    body,
    channel: REASONS[n.reason]?.channel ?? 'like',
    data: {
      reason: n.reason,
      uri: n.uri,
      subject: n.reasonSubject ?? '',
      recipientDid,
    },
  }
}

/** One notification standing for several, opening the notifications tab. */
export function summarize(i18n: I18n, count: number, recipientDid: string): Shown {
  return {
    title: i18n._(
      plural(count, {one: '# new notification', other: '# new notifications'}),
    ),
    channel: 'like',
    data: {
      reason: HORIZON_ACTIVITY_REASON,
      uri: '',
      subject: '',
      recipientDid,
    },
  }
}

/** The tap target of a summary: the notifications tab. */
export const HORIZON_ACTIVITY_REASON = 'horizon-activity'

/** The liked or reposted posts whose text a notification shows. */
export function subjectsToFetch(notifications: Notif[]): string[] {
  const uris = new Set<string>()
  for (const n of notifications) {
    if (
      (n.reason === 'like' || n.reason === 'repost') &&
      n.reasonSubject?.includes('/app.bsky.feed.post/')
    ) {
      uris.add(n.reasonSubject)
    }
  }
  return [...uris].slice(0, 25)
}
