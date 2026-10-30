/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * Which unread DMs to show. Bluesky's chat service pushes only to Bluesky's
 * app and DMs are not in the public stream, so the phone looks for itself
 * (on every push, and on a timer) and shows the newest unread message of
 * each conversation it has not shown yet.
 */

import {type I18n} from '@lingui/core'
import {msg} from '@lingui/core/macro'

import {type chat} from '#/lexicons'
import {type Shown} from './pick'

type Convo = chat.bsky.convo.defs.ConvoView
type ChatPrefs = chat.bsky.notification.defs.Preferences

/** With nothing shown before, only messages this recent are new. */
export const FIRST_DM_WINDOW_MS = 30 * 60 * 1000

type Message = {
  id: string
  text: string
  sender: {did: string}
  sentAt: string
}

function lastMessage(convo: Convo): Message | undefined {
  const m = convo.lastMessage as Partial<Message> & {$type?: string}
  if (!m || m.$type !== 'chat.bsky.convo.defs#messageView') return undefined
  if (typeof m.id !== 'string' || typeof m.sentAt !== 'string' || !m.sender) {
    return undefined
  }
  return m as Message
}

/** The conversations whose newest message should be shown, oldest first. */
export function pickNewDms(
  convos: Convo[],
  {
    me,
    prefs,
    lastShown,
    now,
  }: {me: string; prefs: ChatPrefs | undefined; lastShown: string | undefined; now: number},
): Convo[] {
  const since = lastShown ?? new Date(now - FIRST_DM_WINDOW_MS).toISOString()
  return convos
    .filter(convo => {
      if (convo.muted || convo.unreadCount < 1) return false
      const m = lastMessage(convo)
      if (!m || m.sender.did === me || m.sentAt <= since) return false
      const pref = convo.status === 'request' ? prefs?.chatRequest : prefs?.chat
      if (pref?.push === false) return false
      const viewer = convo.members.find(member => member.did === m.sender.did)?.viewer
      if (pref?.include === 'follows' && !viewer?.following) return false
      return !(viewer?.muted || viewer?.blocking || viewer?.blockedBy)
    })
    .sort((a, b) => (lastMessage(a)!.sentAt < lastMessage(b)!.sentAt ? -1 : 1))
}

/** The newest message time among the conversations, or `lastShown`. */
export function newestDmShown(convos: Convo[], lastShown: string | undefined) {
  let newest = lastShown
  for (const convo of convos) {
    const sentAt = lastMessage(convo)?.sentAt
    if (sentAt && (!newest || sentAt > newest)) newest = sentAt
  }
  return newest
}

/** How a conversation's newest message reads. */
export function describeDm(i18n: I18n, convo: Convo, recipientDid: string): Shown {
  const m = lastMessage(convo)!
  const sender = convo.members.find(member => member.did === m.sender.did)
  const name = sender?.displayName?.trim() || (sender ? `@${sender.handle}` : '')
  const group = (convo.kind as {$type?: string; name?: string} | undefined)
  const groupName =
    group?.$type === 'chat.bsky.convo.defs#groupConvo' && group.name?.trim()
      ? group.name.trim()
      : undefined
  const title = groupName
    ? i18n._(msg`${name} in ${groupName}`)
    : name || i18n._(msg`New message`)
  const more = convo.unreadCount > 1 ? convo.unreadCount - 1 : 0
  const body = m.text.trim()
    ? more
      ? i18n._(msg`${m.text} (+${more} more)`)
      : m.text
    : i18n._(msg`Sent a message`)
  return {
    title,
    body,
    channel: 'chat-messages',
    data: {
      reason: 'chat-message',
      recipientDid,
      convoId: convo.id,
      messageId: m.id,
    },
  }
}
