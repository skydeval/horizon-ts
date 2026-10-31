import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockMember = true
const mockMembershipListeners = new Set<() => void>()
const mockFeatureListeners = new Set<() => void>()
jest.mock('#/horizon/routing/membership', () => ({
  isPrivateMember: (did?: string) => !!did && mockMember,
  subscribeMembership: (listener: () => void) => {
    mockMembershipListeners.add(listener)
    return () => mockMembershipListeners.delete(listener)
  },
}))
jest.mock('#/horizon/routing/features', () => ({
  subscribePrismFeatures: (listener: () => void) => {
    mockFeatureListeners.add(listener)
    return () => mockFeatureListeners.delete(listener)
  },
}))
let mockDid: string | undefined
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentDid: () => mockDid,
}))
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))

import {QueryClient} from '@tanstack/react-query'

import {
  removePrivatePosts,
  showsPrivatePost,
  startFeedMembershipSync,
} from '../feed/membership-sync'
import {DID, privateUri} from './fixtures'

const PUBLIC = `at://${DID}/app.bsky.feed.post/public1`
const OTHER_PUBLIC = `at://${DID}/app.bsky.feed.post/public2`
const PRIVATE = privateUri('secret1')

function item(uri: string, parentUri?: string) {
  return {
    post: {uri},
    ...(parentUri
      ? {reply: {parent: {uri: parentUri}, root: {uri: parentUri}}}
      : {}),
  } as never
}

const KEY = ['post-feed', 'v2|following', {}, {horizonPrivate: DID}]
const OTHER_ACCOUNT_KEY = [
  'post-feed',
  'v2|following',
  {},
  {horizonPrivate: 'did:plc:someoneelse'},
]

function seed(qc: QueryClient, key: unknown[] = KEY) {
  qc.setQueryData(key, {
    pageParams: [undefined],
    pages: [
      {
        cursor: 'c1',
        feed: [item(PUBLIC), item(PRIVATE), item(OTHER_PUBLIC, PRIVATE)],
      },
    ],
  })
}

function uris(qc: QueryClient, key: unknown[] = KEY) {
  const data = qc.getQueryData<{pages: {feed: {post: {uri: string}}[]}[]}>(
    key,
  )
  return data?.pages.flatMap(page => page.feed.map(i => i.post.uri))
}

function fire() {
  mockMembershipListeners.forEach(listener => listener())
}

beforeEach(() => {
  jest.useFakeTimers()
  mockMember = true
  mockDid = DID
  mockMembershipListeners.clear()
  mockFeatureListeners.clear()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('showsPrivatePost', () => {
  it('is true for a private post or a reply to one', () => {
    expect(showsPrivatePost(item(PRIVATE))).toBe(true)
    expect(showsPrivatePost(item(PUBLIC, PRIVATE))).toBe(true)
    expect(showsPrivatePost(item(PUBLIC))).toBe(false)
  })
})

describe('removePrivatePosts', () => {
  it("drops private posts from the account's feeds only, keeping the rest in place", () => {
    const qc = new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}})
    seed(qc)
    seed(qc, OTHER_ACCOUNT_KEY)
    const before = qc.getQueryData(KEY)
    removePrivatePosts(qc, DID)
    expect(uris(qc)).toEqual([PUBLIC])
    expect(qc.getQueryData(KEY)).not.toBe(before)
    expect(uris(qc, OTHER_ACCOUNT_KEY)).toHaveLength(3)
  })
})

describe('startFeedMembershipSync', () => {
  it('does nothing on the first reading, or when nothing changed', () => {
    const qc = new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}})
    seed(qc)
    const invalidate = jest.spyOn(qc, 'invalidateQueries')
    const stop = startFeedMembershipSync(qc)
    fire()
    jest.runAllTimers()
    expect(uris(qc)).toHaveLength(3)
    expect(invalidate).not.toHaveBeenCalled()
    stop()
  })

  it('on losing membership, removes private posts at once, then refetches the same query', () => {
    const qc = new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}})
    seed(qc)
    const invalidate = jest.spyOn(qc, 'invalidateQueries')
    const stop = startFeedMembershipSync(qc)
    mockMember = false
    fire()
    // Gone before any fetch, and the query is the same one (no new key)
    expect(uris(qc)).toEqual([PUBLIC])
    expect(invalidate).not.toHaveBeenCalled()
    jest.runAllTimers()
    expect(invalidate).toHaveBeenCalledTimes(1)
    const [{predicate}] = invalidate.mock.calls[0] as unknown as [
      {predicate: (q: {queryKey: unknown[]}) => boolean},
    ]
    expect(predicate({queryKey: KEY})).toBe(true)
    expect(predicate({queryKey: OTHER_ACCOUNT_KEY})).toBe(false)
    expect(predicate({queryKey: ['post-feed', 'following', {}]})).toBe(false)
    stop()
  })

  it('on gaining membership, keeps the pages and refetches them', () => {
    mockMember = false
    const qc = new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}})
    seed(qc)
    const invalidate = jest.spyOn(qc, 'invalidateQueries')
    const stop = startFeedMembershipSync(qc)
    mockMember = true
    mockFeatureListeners.forEach(listener => listener())
    expect(uris(qc)).toHaveLength(3)
    jest.runAllTimers()
    expect(invalidate).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops listening when stopped', () => {
    const qc = new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}})
    const stop = startFeedMembershipSync(qc)
    stop()
    expect(mockMembershipListeners.size).toBe(0)
    expect(mockFeatureListeners.size).toBe(0)
  })
})
