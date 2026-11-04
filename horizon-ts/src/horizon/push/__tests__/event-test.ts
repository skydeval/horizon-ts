import {describe, expect, it} from '@jest/globals'

import {checkedDid, pushEventOf} from '#/horizon/push/payload'
import {allowed} from '#/horizon/push/pick'

/*
 * Event wakes: a check that also carries what happened (public data from the
 * stream). The app reads it, still applies mutes, blocks and push settings,
 * and an app that predates events reads it as a plain check.
 */

const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const YOU = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const LIKE = `at://${YOU}/app.bsky.feed.like/3klike`
const POST = `at://${ME}/app.bsky.feed.post/3kpost`

const wake = (fields: Record<string, string>) => ({data: fields})

describe('pushEventOf', () => {
  it('reads an event from a check, which stays a check for older apps', () => {
    const data = wake({
      kind: 'check',
      did: ME,
      reason: 'like',
      actor: YOU,
      uri: LIKE,
      subject: POST,
    })
    expect(pushEventOf(data)).toEqual({
      did: ME,
      reason: 'like',
      actor: YOU,
      uri: LIKE,
      subject: POST,
    })
    expect(checkedDid(data)).toBe(ME)
  })

  it('reads the fields packed in dataString too, with the text', () => {
    const data = {
      data: {
        dataString: JSON.stringify({
          kind: 'check',
          did: ME,
          reason: 'reply',
          actor: YOU,
          uri: `at://${YOU}/app.bsky.feed.post/3kr`,
          subject: POST,
          text: 'hi',
        }),
      },
    }
    expect(pushEventOf(data)).toMatchObject({reason: 'reply', text: 'hi'})
  })

  it('is a plain check without an event, and refuses a mismatched or odd one', () => {
    expect(pushEventOf(wake({kind: 'check', did: ME}))).toBeUndefined()
    // The record must be the actor's own
    expect(
      pushEventOf(
        wake({kind: 'check', did: ME, reason: 'like', actor: ME, uri: LIKE}),
      ),
    ).toBeUndefined()
    expect(
      pushEventOf(
        wake({
          kind: 'check',
          did: ME,
          reason: 'unknown',
          actor: YOU,
          uri: LIKE,
        }),
      ),
    ).toBeUndefined()
    expect(
      pushEventOf(
        wake({kind: 'other', did: ME, reason: 'like', actor: YOU, uri: LIKE}),
      ),
    ).toBeUndefined()
  })
})

describe('allowed', () => {
  const n = (viewer: Record<string, unknown>) =>
    ({
      uri: LIKE,
      cid: '',
      author: {did: YOU, handle: 'you.example.com', viewer},
      reason: 'like',
      record: {},
      isRead: false,
      indexedAt: '2026-11-04T12:00:00.000Z',
    }) as never
  const prefs = (include: string, push = true) =>
    ({like: {list: true, push, include}}) as never

  it('follows push settings and drops muted or blocked accounts', () => {
    expect(allowed(n({}), prefs('all'))).toBe(true)
    expect(allowed(n({}), prefs('all', false))).toBe(false)
    expect(allowed(n({}), prefs('follows'))).toBe(false)
    expect(allowed(n({following: 'at://x'}), prefs('follows'))).toBe(true)
    expect(allowed(n({muted: true}), prefs('all'))).toBe(false)
    expect(allowed(n({blockedBy: true}), prefs('all'))).toBe(false)
  })
})
