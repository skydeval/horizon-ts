import {describe, expect, it, jest} from '@jest/globals'

/*
 * The toggle of "Hide reply for everyone" (hidden replies design 5.4, test
 * 15): its success also invalidates the gates Horizon caches for the root
 * (the `'root-threadgate'` record and every gate evaluation of the thread),
 * so the next thread read sees the new gate.
 */

jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockPdsClient: unknown
jest.mock('#/state/session', () => ({usePdsClient: () => mockPdsClient}))
jest.mock('#/state/threadgate-hidden-replies', () => ({
  useThreadgateHiddenReplyUrisAPI: () => ({
    addHiddenReplyUri: () => {},
    removeHiddenReplyUri: () => {},
  }),
}))
jest.mock('#/state/queries/usePostThread', () => ({
  useUpdatePostThreadThreadgateQueryCache: () => () => {},
}))
jest.mock('#/state/queries/post', () => ({
  useGetPost: () => () => Promise.resolve({}),
}))

import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook} from '@testing-library/react-native'

import {
  threadgateRecordQueryKeyRoot,
  useToggleReplyVisibilityMutation,
} from '#/state/queries/threadgate'
import {privateGatesQueryKey} from '#/horizon/private/api/gates'
import {fakeClient, OTHER_DID, privateUri, RECORD_CID} from './fixtures'

const OP = 'did:plc:opcccccccccccccccccccccc'
const ROOT = `at://${OP}/app.bsky.feed.post/3kroot222222`
const OTHER_ROOT = `at://${OP}/app.bsky.feed.post/3kother22222`
const REPLY = privateUri('3kreply22222', OTHER_DID)

describe('the toggle invalidates the root gate Horizon caches (5.4)', () => {
  it("invalidates privateGatesQueryKey(root), the 'root-threadgate' record included", async () => {
    const pds = fakeClient(OP, call =>
      call.nsid === 'com.atproto.repo.getRecord'
        ? {status: 400, body: {error: 'RecordNotFound', message: 'none'}}
        : {
            status: 200,
            body: {
              uri: `at://${OP}/app.bsky.feed.threadgate/3kroot222222`,
              cid: RECORD_CID,
            },
          },
    )
    mockPdsClient = pds.client
    const qc = new QueryClient()
    const rootGate = [...privateGatesQueryKey(ROOT), 'root-threadgate']
    const evaluation = privateGatesQueryKey(ROOT, REPLY)
    const otherGate = [...privateGatesQueryKey(OTHER_ROOT), 'root-threadgate']
    qc.setQueryData(rootGate, null)
    qc.setQueryData(evaluation, {replyDisabled: false})
    qc.setQueryData(otherGate, null)
    qc.setQueryData([threadgateRecordQueryKeyRoot, ROOT], null)
    const {result} = renderHook(() => useToggleReplyVisibilityMutation(), {
      wrapper: ({children}) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    })
    await act(async () => {
      await result.current.mutateAsync({
        postUri: ROOT,
        replyUri: REPLY,
        action: 'hide',
      })
    })
    const put = pds.calls.find(
      call => call.nsid === 'com.atproto.repo.putRecord',
    )
    expect(
      (put?.body?.record as {hiddenReplies?: string[]} | undefined)
        ?.hiddenReplies,
    ).toEqual([REPLY])
    expect(qc.getQueryState(rootGate)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(evaluation)?.isInvalidated).toBe(true)
    expect(
      qc.getQueryState([threadgateRecordQueryKeyRoot, ROOT])?.isInvalidated,
    ).toBe(true)
    // Another root's gate is left alone.
    expect(qc.getQueryState(otherGate)?.isInvalidated).toBe(false)
  })
})
