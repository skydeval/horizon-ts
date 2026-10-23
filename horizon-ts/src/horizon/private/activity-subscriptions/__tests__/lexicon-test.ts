import {describe, expect, it, jest} from '@jest/globals'

/*
 * T7-9: the client lexicon has Bluesky's shapes for prism's store (activity
 * subscriptions design section 3, PR-AS-1; the prism handoff, section 2),
 * and the API reads them.
 */

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {XrpcResponseError} from '@atproto/lex'

import {nearhorizon} from '#/horizon/lexicons'
import {DID, fakeClient, type Reply} from '../../__tests__/fixtures'
import {
  classifyPrismError,
  listPrismSubscriptions,
  putPrismSubscription,
} from '../api'

const SUBJECT = 'did:plc:subjectccccccccccccccccc'

function prism(reply: Reply) {
  return fakeClient(DID, () => reply)
}

const preference = {include: 'all', list: true, push: true}
const five = {
  like: preference,
  mention: preference,
  quote: preference,
  reply: preference,
  repost: preference,
}

describe('T7-9: the client lexicon', () => {
  it('the put has no ifNotChangedSince and no Conflict, and returns the accepted flags', async () => {
    expect(nearhorizon.privatePutActivitySubscription.errors).not.toContain(
      'Conflict',
    )
    const on = prism({
      status: 200,
      body: {subject: SUBJECT, activitySubscription: {post: true, reply: false}},
    })
    expect(
      await putPrismSubscription(on.client, SUBJECT, {post: true, reply: false}),
    ).toEqual({post: true, reply: false})
    expect(on.calls[0].body).toEqual({
      subject: SUBJECT,
      activitySubscription: {post: true, reply: false},
    })

    // No flags after an off: off.
    const off = prism({status: 200, body: {subject: SUBJECT}})
    expect(
      await putPrismSubscription(off.client, SUBJECT, {post: false, reply: false}),
    ).toEqual({post: false, reply: false})
  })

  it('the list items are {subject, activitySubscription}, with no asOf', async () => {
    const {client, calls} = prism({
      status: 200,
      body: {
        cursor: 'next',
        subscriptions: [
          {subject: SUBJECT, activitySubscription: {post: true, reply: true}},
        ],
      },
    })
    const page = await listPrismSubscriptions(client, {limit: 100})
    expect(page).toEqual({
      rows: [{subject: SUBJECT, flags: {post: true, reply: true}}],
      cursor: 'next',
    })
    expect(calls[0].params.get('limit')).toBe('100')
  })

  it('answers LimitReached as a named error, worded as the limit', async () => {
    const {client} = prism({
      status: 400,
      body: {error: 'LimitReached', message: 'LimitReached'},
    })
    const error = await client
      .call(nearhorizon.privatePutActivitySubscription, {
        subject: SUBJECT,
        activitySubscription: {post: true, reply: false},
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(XrpcResponseError)
    expect(classifyPrismError(error)).toBe('limit')
    expect(classifyPrismError(new Error('offline'))).toBe('other')
  })

  it('accepts preferences with and without subscribedPost', async () => {
    const without = prism({status: 200, body: {preferences: five}})
    const a = await without.client.call(
      nearhorizon.privateGetNotificationPreferences,
      {},
    )
    expect(a.preferences.subscribedPost).toBeUndefined()

    const withKey = prism({
      status: 200,
      body: {
        preferences: {...five, subscribedPost: {list: false, push: true}},
      },
    })
    const b = await withKey.client.call(
      nearhorizon.privateGetNotificationPreferences,
      {},
    )
    expect(b.preferences.subscribedPost).toEqual({list: false, push: true})
  })
})
