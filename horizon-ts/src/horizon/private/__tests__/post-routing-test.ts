import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The stock `post()` with its heavy collaborators replaced, so these tests see
 * only where it routes: the private path or the public `applyWrites`.
 */
const mockPostPrivate = jest.fn(() => Promise.resolve({uris: ['private']}))
jest.mock('#/horizon/private/api/writes', () => ({
  postPrivate: (...args: unknown[]) => mockPostPrivate(...(args as [])),
}))
let mockPostingOn = true
// A live getter, so each test can flip the switch.
jest.mock('#/horizon/switches', () =>
  Object.defineProperty(
    {...jest.requireActual<object>('#/horizon/switches')},
    'PRIVATE_POSTING',
    {get: () => mockPostingOn, enumerable: true},
  ),
)
jest.mock('#/state/gallery', () => ({compressImage: jest.fn()}))
jest.mock('#/state/queries/resolve-link', () => ({
  fetchResolveGifQuery: jest.fn(),
  fetchResolveLinkQuery: jest.fn(),
}))
jest.mock('#/state/queries/threadgate', () => ({
  createThreadgateRecord: jest.fn(),
  threadgateAllowUISettingToAllowRecordValue: jest.fn(),
}))
jest.mock('#/lib/at-card', () => ({withCreator: jest.fn()}))
jest.mock('#/lib/api/upload-blob', () => ({uploadBlob: jest.fn()}))

import {type Client} from '@atproto/lex'
import {QueryClient} from '@tanstack/react-query'

import {post} from '#/lib/api/index'
import {type ThreadDraft} from '#/view/com/composer/state/composer'
import {
  PUBLIC_COMPOSE,
  routesPrivate,
  setComposeVisibility,
} from '../composer/state'

const DID = 'did:plc:privateaaaaaaaaaaaaaaaaa'
const PRIVATE_PARENT = `at://${DID}/tools.kryphocron.feed.postPrivate/3kparent2222`
const PUBLIC_PARENT = `at://${DID}/app.bsky.feed.post/3kparent2222`

const mockCall = jest.fn(() => Promise.resolve({}))
const pdsClient = {assertDid: DID, call: mockCall} as unknown as Client
// Answers the stock reply lookup with the parent itself.
const appviewClient = {
  call: jest.fn(() =>
    Promise.resolve({posts: [{uri: PRIVATE_PARENT, cid: 'cid', record: {}}]}),
  ),
} as unknown as Client

function opts(replyTo?: string) {
  return {
    // No posts: the public path goes straight to applyWrites.
    thread: {posts: [], postgate: {}, threadgate: []} as unknown as ThreadDraft,
    replyTo,
    appviewClient,
    chatClient: appviewClient,
    pdsClient,
  }
}

beforeEach(() => {
  mockPostingOn = true
  mockPostPrivate.mockClear()
  mockCall.mockClear()
  setComposeVisibility(PUBLIC_COMPOSE)
})

afterEach(() => {
  setComposeVisibility(PUBLIC_COMPOSE)
})

function makePrivate() {
  setComposeVisibility({
    visibility: 'private',
    audience: {kind: 'mode', mode: 'everyone'},
    locked: false,
  })
}

describe('post() routing (fail-closed)', () => {
  it('with the compose private, post() routes to postPrivate', async () => {
    makePrivate()
    const result = await post(new QueryClient(), opts())
    expect(result).toEqual({uris: ['private']})
    expect(mockPostPrivate).toHaveBeenCalledTimes(1)
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('with a private replyTo it routes there whatever the compose says', async () => {
    expect(routesPrivate(PRIVATE_PARENT)).toBe(true)
    await post(new QueryClient(), opts(PRIVATE_PARENT))
    expect(mockPostPrivate).toHaveBeenCalledTimes(1)
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('a public compose replying to a public post takes the stock path', async () => {
    expect(routesPrivate(PUBLIC_PARENT)).toBe(false)
    await post(new QueryClient(), opts()).catch(() => {})
    expect(mockPostPrivate).not.toHaveBeenCalled()
    expect(mockCall).toHaveBeenCalled()
  })

  it('with PRIVATE_POSTING off it never routes private', async () => {
    mockPostingOn = false
    makePrivate()
    expect(routesPrivate(PRIVATE_PARENT)).toBe(false)
    await post(new QueryClient(), opts(PRIVATE_PARENT)).catch(() => {})
    expect(mockPostPrivate).not.toHaveBeenCalled()
  })
})
