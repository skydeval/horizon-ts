import {beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => mockMembership,
  isPrivateMember: (did?: string) => !!did && mockMembership === 'member',
}))
const mockSwitches = {PRIVATE_READING: true}
jest.mock('#/horizon/switches', () => {
  const actual =
    jest.requireActual<Record<string, unknown>>('#/horizon/switches')
  const mocked: Record<string, unknown> = {...actual}
  Object.defineProperty(mocked, 'PRIVATE_READING', {
    get: () => mockSwitches.PRIVATE_READING,
  })
  return mocked
})

import {type Client} from '@atproto/lex'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  privateKeyDid,
  privateTabDescriptor,
  privateTabDid,
  withPrivateKey,
} from '../feed/keys'
import {DID} from './fixtures'

function publish() {
  publishCurrentClients({
    did: DID,
    handle: 'author.test',
    pdsUrl: undefined,
    pdsClient: {} as Client,
    prismClient: {} as Client,
    appviewClient: {} as Client,
  })
}

beforeEach(() => {
  clearCurrentClients()
  mockMembership = 'member'
  mockSwitches.PRIVATE_READING = true
})

describe('withPrivateKey', () => {
  const stock = ['post-feed', 'v2|following', {}]

  it('appends the member marker to the feeds that carry private posts', () => {
    publish()
    expect(withPrivateKey('following', stock)).toEqual([
      ...stock,
      {horizonPrivate: DID},
    ])
    const posts = `author|${DID}|posts_and_author_threads`
    expect(withPrivateKey(posts, ['post-feed', posts, {}])).toEqual([
      'post-feed',
      posts,
      {},
      {horizonPrivate: DID},
    ])
    const tab = privateTabDescriptor(DID)
    expect(withPrivateKey(tab, ['post-feed', tab, {}])).toEqual([
      'post-feed',
      tab,
      {},
      {horizonPrivate: DID},
    ])
    // The Replies tab merges private posts too (6.4).
    const replies = `author|${DID}|posts_with_replies`
    expect(withPrivateKey(replies, ['post-feed', replies, {}])).toEqual([
      'post-feed',
      replies,
      {},
      {horizonPrivate: DID},
    ])
  })

  it('keeps the same key whatever the membership, so a change never re-keys the feed', () => {
    publish()
    const asMember = withPrivateKey('following', stock)
    for (const state of ['not-member', 'indexing', 'unknown']) {
      mockMembership = state
      expect(withPrivateKey('following', stock)).toEqual(asMember)
    }
  })

  it('privateKeyDid reads the account back, and nothing from a stock key', () => {
    publish()
    expect(privateKeyDid(withPrivateKey('following', stock))).toBe(DID)
    expect(privateKeyDid(stock)).toBeUndefined()
    expect(privateKeyDid([])).toBeUndefined()
  })

  it('returns the stock array with no published account', () => {
    expect(withPrivateKey('following', stock)).toBe(stock)
  })

  it('returns the stock array for other descriptors', () => {
    publish()
    for (const desc of [
      `author|${DID}|posts_with_media`,
      `feedgen|at://x/app.bsky.feed.generator/y`,
      `likes|${DID}`,
    ]) {
      const key = ['post-feed', desc, {}]
      expect(withPrivateKey(desc, key)).toBe(key)
    }
  })

  it('returns the stock array with PRIVATE_READING off', () => {
    publish()
    mockSwitches.PRIVATE_READING = false
    expect(withPrivateKey('following', stock)).toBe(stock)
  })
})

describe('the Private tab descriptor', () => {
  it('is author|<did>|horizon_private, the key 2B invalidates', () => {
    expect(privateTabDescriptor(DID)).toBe(`author|${DID}|horizon_private`)
    expect(privateTabDid(`author|${DID}|horizon_private`)).toBe(DID)
    expect(privateTabDid(`author|${DID}|posts_no_replies`)).toBeUndefined()
    expect(privateTabDid('following')).toBeUndefined()
  })
})
