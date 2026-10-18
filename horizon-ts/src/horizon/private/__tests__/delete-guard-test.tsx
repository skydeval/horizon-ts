import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

/*
 * The stock delete mutation, with its collaborators replaced: a private URI
 * must go through `deletePostPrivate` and never through the stock
 * `deletePost`, which would delete `app.bsky.feed.post` at the same rkey.
 */
const mockCalls: {name: string; input: unknown; schema?: unknown}[] = []
const mockPdsClient = {
  call: (schema: {nsid?: string}, input: unknown) => {
    mockCalls.push({name: schema.nsid ?? 'stock', input, schema})
    return Promise.resolve({})
  },
}
jest.mock('#/state/session', () => ({
  usePdsClient: () => mockPdsClient,
  useAppviewClient: () => mockPdsClient,
  useSession: () => ({currentAccount: undefined}),
}))
jest.mock('#/horizon/routing/prism', () => ({
  getPrismClient: () => ({
    call: (schema: {nsid?: string}, input: unknown) => {
      mockCalls.push({name: schema.nsid ?? 'prism', input})
      return Promise.resolve({status: 'deleted'})
    },
  }),
}))
jest.mock('#/state/cache/post-shadow', () => ({updatePostShadow: jest.fn()}))
jest.mock('#/state/queries/profile', () => ({findProfileQueryData: jest.fn()}))
jest.mock('#/analytics', () => ({useAnalytics: () => ({metric: jest.fn()})}))
jest.mock('#/state/cache/thread-mutes', () => ({
  useIsThreadMuted: jest.fn(),
  useSetThreadMute: jest.fn(),
}))
jest.mock('#/lib/api/index', () => ({
  resolveRT: jest.fn(),
  resolveEmbed: jest.fn(),
  resolveReply: jest.fn(),
}))
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))
jest.mock('#/state/queries/resolve-link', () => ({RQKEY_LINK: jest.fn()}))

import {deletePost} from '@bsky/sdk'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {usePostDeleteMutation} from '#/state/queries/post'

const DID = 'did:plc:privateaaaaaaaaaaaaaaaaa'

function wrapper({children}: {children: React.ReactNode}) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  )
}

beforeEach(() => {
  mockCalls.length = 0
})

describe('the delete guard', () => {
  it('deletes a private post through deletePostPrivate with its rkey, never deletePost', async () => {
    const {result} = renderHook(() => usePostDeleteMutation(), {wrapper})
    await act(async () => {
      await result.current.mutateAsync({
        uri: `at://${DID}/tools.kryphocron.feed.postPrivate/3kprivate222`,
      })
    })
    expect(mockCalls[0].name).toBe('tools.kryphocron.feed.deletePostPrivate')
    expect(mockCalls[0].input).toEqual({repo: DID, rkey: '3kprivate222'})
    expect(mockCalls.some(call => call.schema === deletePost)).toBe(false)
  })

  it('a public post takes the stock deletePost', async () => {
    const {result} = renderHook(() => usePostDeleteMutation(), {wrapper})
    await act(async () => {
      await result.current.mutateAsync({
        uri: `at://${DID}/app.bsky.feed.post/3kpublic2222`,
      })
    })
    expect(mockCalls).toHaveLength(1)
    expect(mockCalls[0].schema).toBe(deletePost)
  })
})
