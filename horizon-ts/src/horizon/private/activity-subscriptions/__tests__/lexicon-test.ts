import {describe, expect, it, jest} from '@jest/globals'

/*
 * T-22: the client lexicon accepts prism's answers (the prism handoff,
 * section 2 and 6).
 */

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {XrpcResponseError} from '@atproto/lex'

import {nearhorizon} from '#/horizon/lexicons'
import {DID, fakeClient, type Reply} from '../../__tests__/fixtures'
import {classifyPrismError} from '../api'

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

describe('T-22: the client lexicon', () => {
  it('accepts the put’s answers, with and without flags, and sends ifNotChangedSince', async () => {
    const on = prism({
      status: 200,
      body: {subject: SUBJECT, activitySubscription: {post: true, reply: false}},
    })
    const res = await on.client.call(
      nearhorizon.privatePutActivitySubscription,
      {
        subject: SUBJECT,
        activitySubscription: {post: true, reply: false},
        ifNotChangedSince: '2026-10-22T11:55:00.000Z',
      },
    )
    expect(res.activitySubscription).toEqual({post: true, reply: false})
    expect(on.calls[0].body).toEqual({
      subject: SUBJECT,
      activitySubscription: {post: true, reply: false},
      ifNotChangedSince: '2026-10-22T11:55:00.000Z',
    })

    const off = prism({status: 200, body: {subject: SUBJECT}})
    const offRes = await off.client.call(
      nearhorizon.privatePutActivitySubscription,
      {subject: SUBJECT, activitySubscription: {post: false, reply: false}},
    )
    expect(offRes.activitySubscription).toBeUndefined()
  })

  it('accepts the list with updatedAt and asOf', async () => {
    const {client} = prism({
      status: 200,
      body: {
        asOf: '2026-10-22T12:00:00.000Z',
        cursor: 'next',
        subscriptions: [
          {
            subject: SUBJECT,
            activitySubscription: {post: true, reply: true},
            updatedAt: '2026-10-22T11:00:00.000Z',
          },
        ],
      },
    })
    const res = await client.call(
      nearhorizon.privateListActivitySubscriptions,
      {limit: 100},
    )
    expect(res.asOf).toBe('2026-10-22T12:00:00.000Z')
    expect(res.subscriptions[0].updatedAt).toBe('2026-10-22T11:00:00.000Z')
  })

  it('answers Conflict and LimitReached as named errors', async () => {
    for (const name of ['Conflict', 'LimitReached'] as const) {
      const {client} = prism({status: 400, body: {error: name, message: name}})
      const error = await client
        .call(nearhorizon.privatePutActivitySubscription, {
          subject: SUBJECT,
          activitySubscription: {post: true, reply: false},
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(XrpcResponseError)
      expect(classifyPrismError(error)).toBe(
        name === 'Conflict' ? 'conflict' : 'limit',
      )
    }
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
