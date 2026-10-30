import {describe as group, expect, it} from '@jest/globals'
import {i18n} from '@lingui/core'

import {checkedDid} from '#/horizon/push/payload'
import {
  describe,
  FIRST_CHECK_WINDOW_MS,
  HORIZON_ACTIVITY_REASON,
  MAX_SINGLE,
  newestShown,
  pickNew,
  subjectsToFetch,
  summarize,
} from '#/horizon/push/pick'

i18n.loadAndActivate({locale: 'en', messages: {}})

const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const YOU = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const myPost = `at://${ME}/app.bsky.feed.post/3kpost`

function notif(over: Record<string, unknown> = {}) {
  return {
    uri: `at://${YOU}/app.bsky.feed.like/3klike`,
    cid: 'bafyexample',
    author: {did: YOU, handle: 'you.example.com', displayName: 'You', viewer: {}},
    reason: 'like',
    reasonSubject: myPost,
    record: {},
    isRead: false,
    indexedAt: '2026-10-30T11:59:00.000Z',
    ...over,
  } as never
}

const prefs = (over: Record<string, unknown> = {}) =>
  ({
    like: {list: true, push: true, include: 'all'},
    follow: {list: true, push: true, include: 'all'},
    reply: {list: true, push: true, include: 'all'},
    ...over,
  }) as never

group('pickNew', () => {
  it('shows unread notifications newer than the last one shown', () => {
    const old = notif({indexedAt: '2026-10-30T11:00:00.000Z'})
    const fresh = notif({indexedAt: '2026-10-30T11:59:30.000Z'})
    const read = notif({isRead: true})
    expect(
      pickNew([fresh, old, read], {
        prefs: prefs(),
        lastShown: '2026-10-30T11:30:00.000Z',
        now: NOW,
      }),
    ).toEqual([fresh])
  })

  it('the first time, only recent ones', () => {
    const stale = notif({
      indexedAt: new Date(NOW - FIRST_CHECK_WINDOW_MS - 1000).toISOString(),
    })
    const recent = notif()
    expect(pickNew([stale, recent], {prefs: prefs(), lastShown: undefined, now: NOW})).toEqual([
      recent,
    ])
  })

  it('follows the account push settings', () => {
    const like = notif()
    expect(
      pickNew([like], {
        prefs: prefs({like: {list: true, push: false, include: 'all'}}),
        lastShown: undefined,
        now: NOW,
      }),
    ).toEqual([])
    expect(
      pickNew([like], {
        prefs: prefs({like: {list: true, push: true, include: 'follows'}}),
        lastShown: undefined,
        now: NOW,
      }),
    ).toEqual([])
    const followed = notif({
      author: {did: YOU, handle: 'you.example.com', viewer: {following: 'at://x'}},
    })
    expect(
      pickNew([followed], {
        prefs: prefs({like: {list: true, push: true, include: 'follows'}}),
        lastShown: undefined,
        now: NOW,
      }),
    ).toEqual([followed])
  })

  it('never from muted or blocked accounts, or unknown reasons', () => {
    const muted = notif({author: {did: YOU, handle: 'y.example.com', viewer: {muted: true}}})
    const blocked = notif({
      author: {did: YOU, handle: 'y.example.com', viewer: {blockedBy: true}},
    })
    const odd = notif({reason: 'contact-match'})
    expect(pickNew([muted, blocked, odd], {prefs: prefs(), lastShown: undefined, now: NOW})).toEqual(
      [],
    )
  })

  it('oldest first', () => {
    const a = notif({indexedAt: '2026-10-30T11:58:00.000Z'})
    const b = notif({indexedAt: '2026-10-30T11:59:00.000Z'})
    expect(pickNew([b, a], {prefs: undefined, lastShown: undefined, now: NOW})).toEqual([a, b])
  })
})

group('wording', () => {
  it('names the account and shows the post text', () => {
    const shown = describe(i18n, notif(), ME, 'my post text')
    expect(shown.title).toBe('You liked your post')
    expect(shown.body).toBe('my post text')
    expect(shown.channel).toBe('like')
    expect(shown.data).toEqual({
      reason: 'like',
      uri: `at://${YOU}/app.bsky.feed.like/3klike`,
      subject: myPost,
      recipientDid: ME,
    })
  })

  it('falls back to the handle, and a reply shows its own text', () => {
    const reply = notif({
      reason: 'reply',
      author: {did: YOU, handle: 'you.example.com', displayName: ' ', viewer: {}},
      record: {text: 'hello there'},
    })
    const shown = describe(i18n, reply, ME)
    expect(shown.title).toBe('@you.example.com replied to you')
    expect(shown.body).toBe('hello there')
  })

  it('many at once become one summary that opens the notifications tab', () => {
    const shown = summarize(i18n, MAX_SINGLE + 3, ME)
    expect(shown.title).toBe(`${MAX_SINGLE + 3} new notifications`)
    expect(shown.data.reason).toBe(HORIZON_ACTIVITY_REASON)
  })
})

group('helpers', () => {
  it('fetches the text of liked and reposted posts only', () => {
    expect(
      subjectsToFetch([
        notif(),
        notif({reason: 'repost'}),
        notif({reason: 'follow', reasonSubject: undefined}),
        notif({reason: 'like-via-repost', reasonSubject: `at://${ME}/app.bsky.feed.repost/1`}),
      ]),
    ).toEqual([myPost])
  })

  it('remembers the newest notification shown', () => {
    expect(
      newestShown(
        [notif({indexedAt: '2026-10-30T11:00:00.000Z'}), notif({indexedAt: '2026-10-30T11:05:00.000Z'})],
        '2026-10-30T10:00:00.000Z',
      ),
    ).toBe('2026-10-30T11:05:00.000Z')
    expect(newestShown([], '2026-10-30T10:00:00.000Z')).toBe('2026-10-30T10:00:00.000Z')
  })

  it('reads the account from a check message, plain or packed', () => {
    expect(checkedDid({data: {kind: 'check', did: ME}})).toBe(ME)
    expect(checkedDid({data: {dataString: JSON.stringify({kind: 'check', did: ME})}})).toBe(ME)
    expect(checkedDid({data: {kind: 'other', did: ME}})).toBeUndefined()
    expect(checkedDid({data: {kind: 'check', did: 'nope'}})).toBeUndefined()
    expect(checkedDid(undefined)).toBeUndefined()
  })
})
