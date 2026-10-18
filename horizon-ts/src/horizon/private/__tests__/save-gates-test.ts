import {beforeEach, describe, expect, it, jest} from '@jest/globals'

type Gate = Record<string, unknown> & {post: string}

let mockStoredThreadgate: Gate | null = null
let mockStoredPostgate: Gate | undefined
const mockWritten: {
  collection: string
  postUri: string
  record: Record<string, unknown>
}[] = []

/*
 * The stock read-modify-write helpers, as they behave: read the stored gate,
 * pass it to the callback, write what it returns.
 */
jest.mock('#/state/queries/threadgate', () => ({
  upsertThreadgate: async (
    where: {postUri: string},
    callback: (prev: unknown) => Promise<Record<string, unknown> | undefined>,
  ) => {
    const next = await callback(mockStoredThreadgate)
    if (next) {
      mockWritten.push({
        collection: 'threadgate',
        postUri: where.postUri,
        record: next,
      })
    }
  },
}))
jest.mock('#/state/queries/postgate', () => ({
  upsertPostgate: async (
    where: {postUri: string},
    callback: (prev: unknown) => Promise<Record<string, unknown> | undefined>,
  ) => {
    const next = await callback(mockStoredPostgate)
    if (next) {
      mockWritten.push({
        collection: 'postgate',
        postUri: where.postUri,
        record: next,
      })
    }
  },
}))

import {i18n} from '@lingui/core'

import {
  PrivateGateConflictError,
  savePrivatePostGates,
} from '../settings/save-gates'
import {DID, OTHER_DID, privateUri} from './fixtures'

const OWN_ROOT = privateUri('3kroot2222222', DID)
const OTHER_ROOT = privateUri('3kroot2222222', OTHER_DID)
const POST = privateUri('3kpost2222222', DID)
const DISABLE = {$type: 'app.bsky.feed.postgate#disableRule'}

beforeEach(() => {
  i18n.loadAndActivate({locale: 'en', messages: {}})
  mockStoredThreadgate = null
  mockStoredPostgate = undefined
  mockWritten.length = 0
})

describe('savePrivatePostGates (7.8)', () => {
  it('writes the threadgate only when the account owns the root', async () => {
    await savePrivatePostGates({
      pdsClient: {} as never,
      currentDid: DID,
      postUri: POST,
      rootUri: OTHER_ROOT,
      threadgate: [{type: 'mention'}],
    })
    expect(mockWritten).toEqual([])

    await savePrivatePostGates({
      pdsClient: {} as never,
      currentDid: DID,
      postUri: POST,
      rootUri: OWN_ROOT,
      threadgate: [{type: 'mention'}],
    })
    expect(mockWritten).toHaveLength(1)
    expect(mockWritten[0].collection).toBe('threadgate')
    expect(mockWritten[0].postUri).toBe(OWN_ROOT)
    expect(mockWritten[0].record.post).toBe(OWN_ROOT)
    expect(mockWritten[0].record.allow).toEqual([
      {$type: 'app.bsky.feed.threadgate#mentionRule'},
    ])
  })

  it('a change back to Anyone writes no allow', async () => {
    mockStoredThreadgate = {
      $type: 'app.bsky.feed.threadgate',
      post: OWN_ROOT,
      allow: [],
      hiddenReplies: [],
    }
    await savePrivatePostGates({
      pdsClient: {} as never,
      currentDid: DID,
      postUri: OWN_ROOT,
      rootUri: OWN_ROOT,
      threadgate: [{type: 'everybody'}],
    })
    expect(mockWritten[0].record.allow).toBeUndefined()
  })

  it('refuses when the stored threadgate or postgate names another post', async () => {
    mockStoredThreadgate = {
      $type: 'app.bsky.feed.threadgate',
      post: `at://${DID}/app.bsky.feed.post/3kroot2222222`,
    }
    await expect(
      savePrivatePostGates({
        pdsClient: {} as never,
        currentDid: DID,
        postUri: OWN_ROOT,
        rootUri: OWN_ROOT,
        threadgate: [{type: 'nobody'}],
      }),
    ).rejects.toBeInstanceOf(PrivateGateConflictError)

    mockStoredPostgate = {
      $type: 'app.bsky.feed.postgate',
      post: `at://${DID}/app.bsky.feed.post/3kpost2222222`,
    }
    await expect(
      savePrivatePostGates({
        pdsClient: {} as never,
        currentDid: DID,
        postUri: POST,
        rootUri: OWN_ROOT,
        postgate: {embeddingRules: [DISABLE]} as never,
      }),
    ).rejects.toBeInstanceOf(PrivateGateConflictError)
    expect(mockWritten).toEqual([])
  })

  it('writes the postgate’s quote setting over the stored one, keeping detached quotes', async () => {
    const detached = [`at://${OTHER_DID}/app.bsky.feed.post/3kquote222222`]
    mockStoredPostgate = {
      $type: 'app.bsky.feed.postgate',
      post: POST,
      createdAt: '2026-10-15T12:00:00.000Z',
      detachedEmbeddingUris: detached,
      embeddingRules: [],
    }
    await savePrivatePostGates({
      pdsClient: {} as never,
      currentDid: DID,
      postUri: POST,
      rootUri: OWN_ROOT,
      postgate: {embeddingRules: [DISABLE]} as never,
    })
    expect(mockWritten).toHaveLength(1)
    expect(mockWritten[0].record).toMatchObject({
      post: POST,
      detachedEmbeddingUris: detached,
      embeddingRules: [DISABLE],
    })
  })
})
