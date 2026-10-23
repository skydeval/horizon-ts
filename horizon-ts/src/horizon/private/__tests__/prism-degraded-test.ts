import {describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * prism's signals, parsed (prism busy design 7, BR-B2): the lexicons take
 * DM3's and DM4's fields, `degraded.ts` reads them, and T-1's
 * `retryAfterFromBody` cases.
 */

import {nearhorizon} from '#/horizon/lexicons'
import {VIEW_UNAVAILABLE_TYPE} from '#/horizon/lexicons/nearhorizon'
import {
  DEGRADED_METHODS,
  isViewUnavailable,
  readAnswerSignals,
  retryAfterFromBody,
} from '#/horizon/private/api/degraded'
import {DID, fakeClient, OTHER_DID, privateUri} from './fixtures'

const OWN = privateUri('3kown2222222')

describe('the lexicons', () => {
  it('a degraded 200 parses, its fields kept for the reader', async () => {
    const prism = fakeClient(DID, () => ({
      status: 200,
      body: {
        feed: [],
        degraded: true,
        retryAfter: 45,
        unavailable: [{uri: OWN, reason: 'syncing'}, {uri: 7}],
      },
    }))
    const body = await prism.client.call(nearhorizon.privateGetTimeline, {})
    expect(body.degraded).toBe(true)
    expect(body.retryAfter).toBe(45)
    expect(readAnswerSignals(body)).toEqual({
      degraded: true,
      retryAfterMs: 45_000,
      unavailable: [{uri: OWN, reason: 'syncing'}],
    })
  })

  it('every private method declares Reindexing; getPostThread declares Unavailable', () => {
    for (const method of [
      nearhorizon.privateGetPosts,
      nearhorizon.privateGetTimeline,
      nearhorizon.privateCreateBookmark,
      nearhorizon.privateUpdateSeen,
      nearhorizon.privateListActivitySubscriptions,
    ]) {
      expect(method.errors).toContain('Reindexing')
    }
    expect(nearhorizon.privateGetPostThread.errors).toEqual(
      expect.arrayContaining(['NotFound', 'Unavailable', 'Reindexing']),
    )
  })

  it('getMembership answers reindexing with validForSecs', async () => {
    const prism = fakeClient(DID, () => ({
      status: 200,
      body: {
        status: 'reindexing',
        features: ['private', 'private.reindexing'],
        validForSecs: 30,
        permissions: {privateRead: true, privateIndexed: true},
      },
    }))
    const res = await prism.client.xrpc(nearhorizon.getMembership)
    expect(res.body.status).toBe('reindexing')
    expect(res.body.validForSecs).toBe(30)
  })

  it('the eleven listed methods', () => {
    expect(DEGRADED_METHODS.size).toBe(11)
    expect(DEGRADED_METHODS.has(nearhorizon.privateGetPosts.nsid)).toBe(true)
    expect(
      DEGRADED_METHODS.has(nearhorizon.privateListNotifications.nsid),
    ).toBe(true)
    expect(DEGRADED_METHODS.has(nearhorizon.privateGetUnreadCount.nsid)).toBe(
      false,
    )
  })
})

describe('readAnswerSignals', () => {
  it('absent fields: not degraded, no hint, nothing unavailable', () => {
    expect(readAnswerSignals({posts: []})).toEqual({
      degraded: false,
      retryAfterMs: undefined,
      unavailable: [],
    })
    expect(readAnswerSignals(undefined).degraded).toBe(false)
  })

  it('only true is degraded', () => {
    expect(readAnswerSignals({degraded: 'yes'}).degraded).toBe(false)
    expect(readAnswerSignals({degraded: false}).degraded).toBe(false)
  })

  it('unavailable outside degraded mode is kept', () => {
    expect(
      readAnswerSignals({posts: [], unavailable: [{uri: OWN, reason: 'indexing'}]}),
    ).toEqual({
      degraded: false,
      retryAfterMs: undefined,
      unavailable: [{uri: OWN, reason: 'indexing'}],
    })
  })
})

describe('T-1: retryAfterFromBody', () => {
  it('reads a 200’s top-level retryAfter', () => {
    expect(retryAfterFromBody({posts: [], degraded: true, retryAfter: 30})).toBe(
      30_000,
    )
    expect(retryAfterFromBody({posts: []})).toBe(undefined)
    expect(retryAfterFromBody({retryAfter: 'soon'})).toBe(undefined)
  })

  it('reads a #viewUnavailable’s own', () => {
    const record = {
      $type: VIEW_UNAVAILABLE_TYPE,
      uri: privateUri('3kquoted2222', OTHER_DID),
      unavailable: true,
      retryAfter: 45,
    }
    expect(isViewUnavailable(record)).toBe(true)
    expect(retryAfterFromBody(record)).toBe(45_000)
    expect(
      isViewUnavailable({
        $type: 'app.bsky.embed.record#viewNotFound',
        uri: record.uri,
      }),
    ).toBe(false)
  })
})
