import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * T-2's checks against the real membership and feature stores (activity
 * subscriptions design 2.2, "The checks"): a definite answer in this run
 * decides; anything not answered yet waits.
 */

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')
jest.mock('#/horizon/private/activity-subscriptions/dirty-store', () => ({}))
jest.mock('#/horizon/private/activity-subscriptions/ui', () => ({
  bellUi: {},
  setBell: () => {},
}))

import {nearhorizon} from '#/horizon/lexicons'
import {
  answerPrismFeatures,
  loadPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {
  reportPrismError,
  resetMembership,
  startMembershipProbe,
} from '#/horizon/routing/membership'
import {fakeClient} from '../../__tests__/fixtures'
import {
  activitySubscriptionsShown,
  deviceExpectsMirror,
  mirrorApplies,
  subscribeMirrorChecks,
} from '../checks'
import {settle} from './harness'

const ACCOUNT = 'did:plc:checksaaaaaaaaaaaaaaaaaaa'
const WITH = ['private', 'private.notifications', 'private.activitySubscriptions']

const env = {
  setTimeout: () => undefined,
  clearTimeout: () => {},
  isHidden: () => false,
  onVisible: () => () => {},
}

async function answerMember(features: string[]) {
  const {client} = fakeClient(ACCOUNT, () => ({
    status: 200,
    body: {status: 'member', features},
  }))
  const cancel = startMembershipProbe(ACCOUNT, client, env)
  await settle()
  cancel()
}

beforeEach(() => {
  resetMembership()
  resetPrismFeatures()
})

describe('T-2: the mirror’s checks', () => {
  it('waits while nothing is answered, and on a list held from the device only', () => {
    expect(mirrorApplies(ACCOUNT)).toBe('wait')
    // A launch that starts from a list held on the device.
    resetPrismFeatures()
    loadPrismFeatures(ACCOUNT, WITH)
    expect(mirrorApplies(ACCOUNT)).toBe('wait')
    // Reads and rendering may start from the held list.
    expect(activitySubscriptionsShown(ACCOUNT)).toBe(true)
    expect(deviceExpectsMirror(ACCOUNT)).toBe(false)
  })

  it('a confirmed member with the feature for write may level; listeners hear the answer', async () => {
    const heard = jest.fn()
    const unsubscribe = subscribeMirrorChecks(heard)
    await answerMember(WITH)
    expect(heard).toHaveBeenCalled()
    expect(mirrorApplies(ACCOUNT)).toBe('yes')
    expect(deviceExpectsMirror(ACCOUNT)).toBe(true)
    unsubscribe()
  })

  it('features answered without the feature, or not a member, remove the key', async () => {
    answerPrismFeatures(ACCOUNT, ['private', 'private.notifications'])
    expect(mirrorApplies(ACCOUNT)).toBe('no')
    expect(activitySubscriptionsShown(ACCOUNT)).toBe(false)

    resetPrismFeatures()
    const {client} = fakeClient(ACCOUNT, () => ({
      status: 403,
      body: {error: 'NotEnrolled', message: 'no'},
    }))
    const error = await client
      .call(nearhorizon.privateGetTimeline, {limit: 1})
      .catch((e: unknown) => e)
    reportPrismError(ACCOUNT, error)
    expect(mirrorApplies(ACCOUNT)).toBe('no')
  })

  it('indexing is not an answer to act on', async () => {
    const {client} = fakeClient(ACCOUNT, () => ({
      status: 200,
      body: {status: 'indexing', features: WITH},
    }))
    const cancel = startMembershipProbe(ACCOUNT, client, env)
    await settle()
    cancel()
    expect(mirrorApplies(ACCOUNT)).toBe('wait')
  })
})
