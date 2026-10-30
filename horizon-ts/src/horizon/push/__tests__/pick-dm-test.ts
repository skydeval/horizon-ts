import {describe, expect, it} from '@jest/globals'
import {i18n} from '@lingui/core'

import {
  describeDm,
  FIRST_DM_WINDOW_MS,
  newestDmShown,
  pickNewDms,
} from '#/horizon/push/pick-dm'
import {passwordRoute} from '#/horizon/push/route'

i18n.loadAndActivate({locale: 'en', messages: {}})

const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const YOU = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const NOW = Date.parse('2026-10-30T12:00:00.000Z')

function convo(over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return {
    id: 'convo1',
    rev: '1',
    muted: false,
    status: 'accepted',
    unreadCount: 1,
    members: [
      {did: ME, handle: 'me.example.com'},
      {did: YOU, handle: 'you.example.com', displayName: 'You', viewer: {}},
    ],
    lastMessage: {
      $type: 'chat.bsky.convo.defs#messageView',
      id: 'msg1',
      rev: '1',
      text: 'hi!',
      sender: {did: YOU},
      sentAt: '2026-10-30T11:59:00.000Z',
      ...message,
    },
    ...over,
  } as never
}

const prefs = (over: Record<string, unknown> = {}) =>
  ({
    chat: {push: true, include: 'all'},
    chatRequest: {push: true, include: 'all'},
    ...over,
  }) as never

const pick = (convos: never[], options: Record<string, unknown> = {}) =>
  pickNewDms(convos, {me: ME, prefs: prefs(), lastShown: undefined, now: NOW, ...options})

describe('pickNewDms', () => {
  it('shows an unread message from someone else', () => {
    expect(pick([convo()])).toHaveLength(1)
  })

  it('not my own, read, muted, old, or already shown', () => {
    expect(pick([convo({}, {sender: {did: ME}})])).toEqual([])
    expect(pick([convo({unreadCount: 0})])).toEqual([])
    expect(pick([convo({muted: true})])).toEqual([])
    expect(
      pick([convo({}, {sentAt: new Date(NOW - FIRST_DM_WINDOW_MS - 1).toISOString()})]),
    ).toEqual([])
    expect(pick([convo()], {lastShown: '2026-10-30T11:59:00.000Z'})).toEqual([])
  })

  it('follows the chat push settings, requests separately', () => {
    expect(pick([convo()], {prefs: prefs({chat: {push: false, include: 'all'}})})).toEqual([])
    expect(
      pick([convo({status: 'request'})], {
        prefs: prefs({chatRequest: {push: false, include: 'all'}}),
      }),
    ).toEqual([])
    expect(
      pick([convo()], {prefs: prefs({chat: {push: true, include: 'follows'}})}),
    ).toEqual([])
  })

  it('not from a muted or blocked sender, and ignores deleted messages', () => {
    const muted = convo({
      members: [{did: YOU, handle: 'you.example.com', viewer: {muted: true}}],
    })
    expect(pick([muted])).toEqual([])
    expect(pick([convo({}, {$type: 'chat.bsky.convo.defs#deletedMessageView'})])).toEqual([])
  })
})

describe('describeDm', () => {
  it('reads as the sender and the message, tapping into the convo', () => {
    const shown = describeDm(i18n, convo(), ME)
    expect(shown.title).toBe('You')
    expect(shown.body).toBe('hi!')
    expect(shown.data).toEqual({
      reason: 'chat-message',
      recipientDid: ME,
      convoId: 'convo1',
      messageId: 'msg1',
    })
  })

  it('names the group and counts the rest', () => {
    const group = convo({
      unreadCount: 3,
      kind: {$type: 'chat.bsky.convo.defs#groupConvo', name: 'Friends'},
    })
    const shown = describeDm(i18n, group, ME)
    expect(shown.title).toBe('You in Friends')
    expect(shown.body).toBe('hi! (+2 more)')
  })

  it('remembers the newest message shown', () => {
    expect(newestDmShown([convo()], undefined)).toBe('2026-10-30T11:59:00.000Z')
  })
})

describe('passwordRoute', () => {
  const base = {hasLiveBundle: false, appRunning: false, accessValid: true, canAct: true}

  it("borrows the app's own session when it is this account's", () => {
    expect(passwordRoute({...base, hasLiveBundle: true, appRunning: true})).toBe('live')
  })

  it('beside the running app, never refreshes', () => {
    expect(passwordRoute({...base, appRunning: true})).toBe('stored-access')
    expect(passwordRoute({...base, appRunning: true, accessValid: false})).toBe('none')
  })

  it('with no app running, resumes (and may refresh)', () => {
    expect(passwordRoute({...base, accessValid: false})).toBe('resume')
  })

  it('never for an account that cannot act', () => {
    expect(passwordRoute({...base, canAct: false})).toBe('none')
  })
})
