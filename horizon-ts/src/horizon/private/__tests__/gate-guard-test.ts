import {beforeEach, describe, expect, it, jest} from '@jest/globals'

const mockToast = jest.fn()
jest.mock('#/components/Toast', () => ({
  show: (...args: unknown[]) => mockToast(...args),
}))

type Evaluation = {replyDisabled: boolean; embeddingDisabled: boolean}
const mockEvaluation =
  jest.fn<(root: string, post: string) => Promise<Evaluation>>()
jest.mock('#/horizon/private/api/gates', () => ({
  ...jest.requireActual<object>('#/horizon/private/api/gates'),
  privateGateEvaluation: (_qc: unknown, root: string, post: string) =>
    mockEvaluation(root, post),
}))

const mockGetPrivatePosts =
  jest.fn<(prism: unknown, uris: string[]) => Promise<unknown[]>>()
jest.mock('#/horizon/private/api/reads', () => ({
  ...jest.requireActual<object>('#/horizon/private/api/reads'),
  getPrivatePosts: (prism: unknown, uris: string[]) =>
    mockGetPrivatePosts(prism, uris),
}))
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {guardPrivateInteraction} from '../api/gate-guard'
import {DID, OTHER_DID, privateUri} from './fixtures'

const ROOT = privateUri('3kroot2222222', OTHER_DID)
const POST = privateUri('3kpost2222222', OTHER_DID)

function post(viewer: Record<string, boolean> = {}) {
  return {
    uri: POST,
    record: {reply: {root: {uri: ROOT}, parent: {uri: ROOT}}},
    viewer,
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

function publish(withQueryClient = true) {
  publishCurrentClients({
    did: DID,
    handle: 'reader.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: {} as never,
    appviewClient: {} as never,
    ...(withQueryClient ? {queryClient: new QueryClient()} : {}),
  })
}

beforeEach(() => {
  i18n.loadAndActivate({locale: 'en', messages: {}})
  mockToast.mockReset()
  mockEvaluation.mockReset()
  mockGetPrivatePosts.mockReset()
  resetPrismFeatures()
  clearCurrentClients()
  publish()
})

describe('guardPrivateInteraction (Ctl 7, Ctl 8)', () => {
  it('runs the action at once for a public post', () => {
    const action = jest.fn()
    guardPrivateInteraction(
      {uri: `at://${OTHER_DID}/app.bsky.feed.post/3kx`, record: {}},
      'reply',
      action,
    )
    expect(action).toHaveBeenCalledTimes(1)
    expect(mockEvaluation).not.toHaveBeenCalled()
  })

  describe('where prism applies the gates (private root, private.gates)', () => {
    beforeEach(() => {
      answerPrismFeatures(DID, ['private', 'private.gates'])
    })

    it('runs a quote at once, with no read', () => {
      const action = jest.fn()
      guardPrivateInteraction(post(), 'quote', action)
      expect(action).toHaveBeenCalledTimes(1)
      expect(mockGetPrivatePosts).not.toHaveBeenCalled()
      expect(mockEvaluation).not.toHaveBeenCalled()
    })

    it('asks prism for the root and the post, and shows the toast on replyDisabled', async () => {
      mockGetPrivatePosts.mockResolvedValue([
        {uri: ROOT},
        {uri: POST, viewer: {replyDisabled: true}},
      ])
      const action = jest.fn()
      guardPrivateInteraction(post(), 'reply', action)
      await settle()
      expect(mockGetPrivatePosts).toHaveBeenCalledTimes(1)
      expect(mockGetPrivatePosts.mock.calls[0][1]).toEqual([ROOT, POST])
      expect(mockEvaluation).not.toHaveBeenCalled()
      expect(action).not.toHaveBeenCalled()
      expect(mockToast.mock.calls[0][0]).toBe(
        'Replies to this post are limited.',
      )
    })

    it('runs the reply when prism does not disable it, and on a failure', async () => {
      mockGetPrivatePosts.mockResolvedValueOnce([{uri: POST, viewer: {}}])
      const action = jest.fn()
      guardPrivateInteraction(post(), 'reply', action)
      await settle()
      expect(action).toHaveBeenCalledTimes(1)
      mockGetPrivatePosts.mockRejectedValueOnce(new Error('offline'))
      guardPrivateInteraction(
        {...post(), uri: privateUri('3kpost3333333', OTHER_DID)},
        'reply',
        action,
      )
      await settle()
      expect(action).toHaveBeenCalledTimes(2)
      expect(mockToast).not.toHaveBeenCalled()
    })

    it('runs the reply after the deadline', async () => {
      jest.useFakeTimers()
      try {
        mockGetPrivatePosts.mockReturnValue(new Promise(() => {}))
        const action = jest.fn()
        guardPrivateInteraction(post(), 'reply', action)
        await jest.advanceTimersByTimeAsync(3_000)
        expect(action).toHaveBeenCalledTimes(1)
      } finally {
        jest.useRealTimers()
      }
    })

    it('a branch under a public root keeps the interim check', async () => {
      mockEvaluation.mockResolvedValue({
        replyDisabled: true,
        embeddingDisabled: false,
      })
      const publicRoot = `at://${OTHER_DID}/app.bsky.feed.post/3kpublicroot`
      const action = jest.fn()
      guardPrivateInteraction(
        {
          uri: POST,
          record: {reply: {root: {uri: publicRoot}, parent: {uri: publicRoot}}},
        },
        'reply',
        action,
      )
      await settle()
      expect(mockGetPrivatePosts).not.toHaveBeenCalled()
      expect(mockEvaluation).toHaveBeenCalledWith(publicRoot, POST)
      expect(action).not.toHaveBeenCalled()
    })
  })

  it('runs the action at once when the viewer state already decides, or without a query client', () => {
    const action = jest.fn()
    guardPrivateInteraction(post({replyDisabled: false}), 'reply', action)
    expect(action).toHaveBeenCalledTimes(1)
    clearCurrentClients()
    publish(false)
    guardPrivateInteraction(post(), 'reply', action)
    expect(action).toHaveBeenCalledTimes(2)
    expect(mockEvaluation).not.toHaveBeenCalled()
  })

  it('runs the action when allowed, with the root read from the record', async () => {
    mockEvaluation.mockResolvedValue({
      replyDisabled: false,
      embeddingDisabled: false,
    })
    const action = jest.fn()
    guardPrivateInteraction(post(), 'reply', action)
    expect(action).not.toHaveBeenCalled()
    await settle()
    expect(mockEvaluation).toHaveBeenCalledWith(ROOT, POST)
    expect(action).toHaveBeenCalledTimes(1)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('shows a toast and does not run the action when disallowed', async () => {
    mockEvaluation.mockResolvedValue({
      replyDisabled: true,
      embeddingDisabled: true,
    })
    const reply = jest.fn()
    const quote = jest.fn()
    guardPrivateInteraction(post(), 'reply', reply)
    guardPrivateInteraction(post(), 'quote', quote)
    await settle()
    expect(reply).not.toHaveBeenCalled()
    expect(quote).not.toHaveBeenCalled()
    expect(mockToast.mock.calls.map(call => call[0])).toEqual([
      'Replies to this post are limited.',
      'Quote posts of this post are turned off.',
    ])
  })

  it('runs the action on a failed read', async () => {
    mockEvaluation.mockRejectedValue(new Error('offline'))
    const action = jest.fn()
    guardPrivateInteraction(post(), 'quote', action)
    await settle()
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('runs the action after the deadline', async () => {
    jest.useFakeTimers()
    try {
      mockEvaluation.mockReturnValue(new Promise(() => {}))
      const action = jest.fn()
      guardPrivateInteraction(post(), 'reply', action)
      await jest.advanceTimersByTimeAsync(3_000)
      expect(action).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})
