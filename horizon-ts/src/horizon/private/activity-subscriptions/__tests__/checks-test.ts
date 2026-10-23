import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The non-hook gate against the real feature store (activity subscriptions
 * design 2.5, the gate).
 */

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {
  answerPrismFeatures,
  loadPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {activitySubscriptionsShown} from '../checks'

const ACCOUNT = 'did:plc:checksaaaaaaaaaaaaaaaaaaa'
const WITH = ['private', 'private.notifications', 'private.activitySubscriptions']

beforeEach(() => {
  resetPrismFeatures()
})

describe('activitySubscriptionsShown', () => {
  it('holds on a list with the feature, held from the device or answered', () => {
    expect(activitySubscriptionsShown(ACCOUNT)).toBe(false)
    // A launch that starts from a list held on the device.
    resetPrismFeatures()
    loadPrismFeatures(ACCOUNT, WITH)
    expect(activitySubscriptionsShown(ACCOUNT)).toBe(true)
    resetPrismFeatures()
    answerPrismFeatures(ACCOUNT, WITH)
    expect(activitySubscriptionsShown(ACCOUNT)).toBe(true)
  })

  it('does not hold without the feature, or without an account', () => {
    answerPrismFeatures(ACCOUNT, ['private', 'private.notifications'])
    expect(activitySubscriptionsShown(ACCOUNT)).toBe(false)
    expect(activitySubscriptionsShown(undefined)).toBe(false)
  })
})
