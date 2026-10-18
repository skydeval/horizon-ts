import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))

type Evaluation = {replyDisabled: boolean; embeddingDisabled: boolean}
const mockThreadGates =
  jest.fn<(root: string, anchor: string) => Promise<Evaluation | undefined>>()
jest.mock('#/horizon/private/api/gates', () => ({
  ...jest.requireActual<object>('#/horizon/private/api/gates'),
  threadGateEvaluation: (root: string, anchor: string) =>
    mockThreadGates(root, anchor),
}))

import {type ModerationOpts} from '@bsky/sdk/moderation'

import {
  buildThread,
  sortAndAnnotateThreadItems,
} from '#/state/queries/usePostThread/traversal'
import {type ThreadItem} from '#/state/queries/usePostThread/types'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {type app} from '#/lexicons'
import {toPostView} from '../adapt/post-view'
import {addPendingPost, clearPrivateStores} from '../store'
import {fetchPrivateThreadV2} from '../thread/fetch'
import {DID, OTHER_DID, privateUri, RECORD_CID} from './fixtures'
import {
  at,
  AUDIENCE_URI,
  fakeAppview,
  fakePrism,
  PP,
  type PrivateView,
  privateView,
  type Ref,
} from './read-fixtures'

const MODERATION_OPTS: ModerationOpts = {
  userDid: DID,
  prefs: {
    adultContentEnabled: false,
    labels: {},
    labelers: [],
    mutedWords: [],
    hiddenPosts: [],
  },
  labelDefs: {},
}

type Node = {
  $type: 'app.nearhorizon.private.defs#privateThreadView'
  post: PrivateView
  parent?: unknown
  replies?: Node[]
}

function node(
  post: PrivateView,
  {parent, replies}: {parent?: unknown; replies?: Node[]} = {},
): Node {
  return {
    $type: 'app.nearhorizon.private.defs#privateThreadView',
    post,
    ...(parent ? {parent} : {}),
    ...(replies ? {replies} : {}),
  }
}

function ref(view: PrivateView | {uri: string}): Ref {
  return {uri: view.uri, cid: RECORD_CID}
}

function replyTo(parent: PrivateView, root: PrivateView | {uri: string}) {
  return {root: ref(root), parent: ref(parent)}
}

/**
 * Publish clients whose prism answers `getPostThread` with `thread` (or
 * `NotFound` when it is undefined).
 */
function serve(
  thread: Node | undefined,
  appview = fakeAppview(),
): {prismCalls: URLSearchParams[]} {
  const prismCalls: URLSearchParams[] = []
  const prism = fakePrism({
    handler: (nsid, params) => {
      if (nsid !== 'app.nearhorizon.private.getPostThread') return undefined
      prismCalls.push(params)
      return thread
        ? {status: 200, body: {thread}}
        : {status: 400, body: {error: 'NotFound', message: 'not found'}}
    },
  })
  publishCurrentClients({
    did: DID,
    handle: 'author.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: appview.client,
  })
  return {prismCalls}
}

function rkeys(thread: {uri: string}[]) {
  return thread.map(item => item.uri.split('/').pop())
}

function render(
  thread: app.bsky.unspecced.getPostThreadV2.ThreadItem[],
  view: 'tree' | 'linear' = 'tree',
): ThreadItem[] {
  const {threadItems, otherThreadItems} = sortAndAnnotateThreadItems(thread, {
    threadgateHiddenReplies: new Set(),
    moderationOpts: MODERATION_OPTS,
    view,
  })
  return buildThread({
    threadItems,
    otherThreadItems,
    serverOtherThreadItems: [],
    isLoading: false,
    hasSession: true,
    otherItemsVisible: true,
    hasOtherThreadItems: false,
    showOtherItems: () => {},
  })
}

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
  mockThreadGates.mockReset()
  mockThreadGates.mockResolvedValue(undefined)
  resetPrismFeatures()
})

describe('interim gates on the thread (6.6 step 7)', () => {
  function threadOfThree() {
    const root = privateView('3kroot', {minutes: 0})
    const anchor = privateView('3kanchor', {
      minutes: 1,
      reply: replyTo(root, root),
    })
    const reply = privateView('3kreply', {
      minutes: 2,
      reply: replyTo(anchor, root),
    })
    serve(
      node(anchor, {
        parent: node(root),
        replies: [node(reply)],
      }),
    )
    return {root, anchor, reply}
  }

  function viewers(thread: app.bsky.unspecced.getPostThreadV2.ThreadItem[]) {
    return thread.map(item =>
      item.value.$type === 'app.bsky.unspecced.defs#threadItemPost'
        ? (item.value as {post: app.bsky.feed.defs.PostView}).post.viewer
        : undefined,
    )
  }

  it('asks for the root’s gates with the anchor', async () => {
    const {root, anchor} = threadOfThree()
    await fetchPrivateThreadV2(anchor.uri, {below: 10})
    expect(mockThreadGates).toHaveBeenCalledWith(root.uri, anchor.uri)
  })

  it('disables replying on every private post and quoting on the anchor when disallowed', async () => {
    const {anchor} = threadOfThree()
    mockThreadGates.mockResolvedValue({
      replyDisabled: true,
      embeddingDisabled: true,
    })
    const {thread} = await fetchPrivateThreadV2(anchor.uri, {below: 10})
    const [rootViewer, anchorViewer, replyViewer] = viewers(thread)
    expect(rootViewer?.replyDisabled).toBe(true)
    expect(anchorViewer?.replyDisabled).toBe(true)
    expect(replyViewer?.replyDisabled).toBe(true)
    expect(anchorViewer?.embeddingDisabled).toBe(true)
    expect(rootViewer?.embeddingDisabled).toBeUndefined()
    expect(replyViewer?.embeddingDisabled).toBeUndefined()
  })

  it('sets nothing when the read fails', async () => {
    const {anchor} = threadOfThree()
    mockThreadGates.mockResolvedValue(undefined)
    const {thread} = await fetchPrivateThreadV2(anchor.uri, {below: 10})
    for (const viewer of viewers(thread)) {
      expect(viewer?.replyDisabled).toBeUndefined()
      expect(viewer?.embeddingDisabled).toBeUndefined()
    }
  })
})

describe('gates prism applies (2H design 5.4, T6)', () => {
  const threadgate = (rootUri: string) => ({
    uri: `at://${DID}/app.bsky.feed.threadgate/3kroot`,
    cid: RECORD_CID,
    record: {
      $type: 'app.bsky.feed.threadgate',
      post: rootUri,
      createdAt: at(0),
      allow: [],
      hiddenReplies: [],
    },
    lists: [],
  })

  function postViewers(
    thread: app.bsky.unspecced.getPostThreadV2.ThreadItem[],
  ) {
    return thread.map(item =>
      item.value.$type === 'app.bsky.unspecced.defs#threadItemPost'
        ? (item.value as {post: app.bsky.feed.defs.PostView}).post.viewer
        : undefined,
    )
  }

  it('makes no interim read for a private root; replyDisabled comes from each view', async () => {
    answerPrismFeatures(DID, ['private', 'private.gates'])
    const root = {
      ...privateView('3kroot', {minutes: 0}),
      threadgate: threadgate(privateUri('3kroot')),
      viewer: {replyDisabled: true},
    }
    const anchor = {
      ...privateView('3kanchor', {minutes: 1, reply: replyTo(root, root)}),
      viewer: {replyDisabled: true},
    }
    const reply = privateView('3kreply', {
      minutes: 2,
      reply: replyTo(anchor, root),
    })
    serve(node(anchor, {parent: node(root), replies: [node(reply)]}))
    const result = await fetchPrivateThreadV2(anchor.uri, {below: 10})
    expect(mockThreadGates).not.toHaveBeenCalled()
    const [rootViewer, anchorViewer, replyViewer] = postViewers(result.thread)
    expect(rootViewer?.replyDisabled).toBe(true)
    expect(anchorViewer?.replyDisabled).toBe(true)
    // The thread request read the root, so absence means allowed.
    expect(replyViewer?.replyDisabled).toBe(false)
    expect(result.threadgate?.uri).toBe(threadgate(root.uri).uri)
  })

  it('a branch under a public root still evaluates', async () => {
    answerPrismFeatures(DID, ['private', 'private.gates'])
    const publicRoot = {
      uri: `at://${OTHER_DID}/app.bsky.feed.post/3kpublicroot`,
    }
    const anchor = privateView('3kanchor', {
      minutes: 1,
      reply: replyTo(publicRoot as never, publicRoot),
    })
    serve(node(anchor))
    await fetchPrivateThreadV2(anchor.uri, {below: 10})
    expect(mockThreadGates).toHaveBeenCalledWith(publicRoot.uri, anchor.uri)
  })

  it('without the feature the interim evaluation runs; a served threadgate still passes', async () => {
    const root = {
      ...privateView('3kroot', {minutes: 0}),
      threadgate: threadgate(privateUri('3kroot')),
    }
    serve(node(root))
    const result = await fetchPrivateThreadV2(root.uri, {below: 10})
    expect(mockThreadGates).toHaveBeenCalled()
    // The view's threadgate is used by data (5.1), so the root carries it.
    expect(result.threadgate?.uri).toBe(threadgate(root.uri).uri)
  })
})

describe('fetchPrivateThreadV2', () => {
  it('renders parents, anchor and replies in order through the stock traversal', async () => {
    const root = privateView('3kroot', {minutes: 0})
    const parent = privateView('3kparent', {
      minutes: 1,
      reply: replyTo(root, root),
    })
    const anchor = privateView('3kanchor', {
      minutes: 2,
      reply: replyTo(parent, root),
    })
    const r1 = privateView('3kr1', {minutes: 3, reply: replyTo(anchor, root)})
    const r2 = privateView('3kr2', {
      did: OTHER_DID,
      minutes: 4,
      reply: replyTo(anchor, root),
    })
    const r1a = privateView('3kr1a', {minutes: 5, reply: replyTo(r1, root)})
    const {prismCalls} = serve(
      node(anchor, {
        parent: node(parent, {parent: node(root)}),
        replies: [node(r1, {replies: [node(r1a)]}), node(r2)],
      }),
    )
    const res = await fetchPrivateThreadV2(anchor.uri, {
      below: 4,
      sort: 'oldest',
    })
    expect(prismCalls[0].get('depth')).toBe('4')
    expect(prismCalls[0].get('parentHeight')).toBe('20')
    expect(res.hasOtherReplies).toBe(false)
    expect(res.thread.map(i => i.depth)).toEqual([-2, -1, 0, 1, 2, 1])
    const items = render(res.thread)
    expect(items.map(i => i.type)).toEqual([
      'threadPost',
      'threadPost',
      'threadPost',
      'replyComposer',
      'threadPost',
      'threadPost',
      'threadPost',
    ])
    expect(
      rkeys(
        items.filter(
          (i): i is Extract<ThreadItem, {type: 'threadPost'}> =>
            i.type === 'threadPost',
        ),
      ),
    ).toEqual(['3kroot', '3kparent', '3kanchor', '3kr1', '3kr1a', '3kr2'])
  })

  it('gives one not-found anchor when prism answers NotFound', async () => {
    serve(undefined)
    const uri = privateUri('3kgone')
    const res = await fetchPrivateThreadV2(uri, {below: 4})
    expect(res.thread).toEqual([
      {
        uri,
        depth: 0,
        value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'},
      },
    ])
    expect(render(res.thread).map(i => i.type)).toEqual(['threadPostNotFound'])
  })

  it('builds the thread from pending posts when the anchor is pending', async () => {
    serve(undefined)
    const pending = (rkey: string, minutes: number, reply?: object) => {
      const uri = privateUri(rkey)
      const record = {
        $type: PP,
        text: rkey,
        createdAt: at(minutes),
        audienceList: AUDIENCE_URI,
        ...(reply ? {reply} : {}),
      }
      const postView = toPostView(
        {
          uri,
          cid: RECORD_CID,
          author: {did: DID, handle: 'author.test'} as never,
          record,
          indexedAt: record.createdAt,
        },
        {isPending: true},
      ) as app.bsky.feed.defs.PostView
      addPendingPost({
        uri,
        cid: RECORD_CID,
        did: DID,
        record: record as never,
        audienceUri: AUDIENCE_URI,
        postView,
        feedItem: {post: postView},
        createdAt: record.createdAt,
        expiresAt: Date.now() + 60_000,
      })
      return {uri}
    }
    const first = pending('3kp1', 1)
    const second = pending('3kp2', 2, {
      root: {uri: first.uri, cid: RECORD_CID},
      parent: {uri: first.uri, cid: RECORD_CID},
    })
    pending('3kp3', 3, {
      root: {uri: first.uri, cid: RECORD_CID},
      parent: {uri: second.uri, cid: RECORD_CID},
    })
    const res = await fetchPrivateThreadV2(second.uri, {below: 4})
    expect(rkeys(res.thread)).toEqual(['3kp1', '3kp2', '3kp3'])
    expect(res.thread.map(i => i.depth)).toEqual([-1, 0, 1])
  })

  it('puts a public parent prism served above the chain', async () => {
    const publicUri =
      'at://did:plc:publicccccccccccccccccccc/app.bsky.feed.post/3kpub'
    const publicRoot =
      'at://did:plc:publicccccccccccccccccccc/app.bsky.feed.post/3kpubroot'
    const anchor = privateView('3kanchor', {
      reply: {
        root: {uri: publicRoot, cid: RECORD_CID},
        parent: {uri: publicUri, cid: RECORD_CID},
      },
    })
    serve(
      node(anchor, {
        parent: {
          $type: 'app.nearhorizon.private.defs#publicParent',
          post: {
            uri: publicUri,
            cid: RECORD_CID,
            author: {
              did: 'did:plc:publicccccccccccccccccccc',
              handle: 'p.test',
            },
            record: {
              $type: 'app.bsky.feed.post',
              text: 'public',
              createdAt: at(0),
              reply: {
                root: {uri: publicRoot, cid: RECORD_CID},
                parent: {uri: publicRoot, cid: RECORD_CID},
              },
            },
            indexedAt: at(0),
          },
        },
      }),
    )
    const res = await fetchPrivateThreadV2(anchor.uri, {below: 4})
    expect(res.thread.map(i => [i.uri, i.depth])).toEqual([
      [publicUri, -1],
      [anchor.uri, 0],
    ])
    expect(res.thread[0].value).toMatchObject({
      $type: 'app.bsky.unspecced.defs#threadItemPost',
      moreParents: true,
    })
  })

  it('reads a public parent prism did not serve from the public AppView, or marks it not found', async () => {
    const publicUri =
      'at://did:plc:publicccccccccccccccccccc/app.bsky.feed.post/3kpub'
    const anchor = privateView('3kanchor', {
      reply: {
        root: {uri: publicUri, cid: RECORD_CID},
        parent: {uri: publicUri, cid: RECORD_CID},
      },
    })
    serve(
      node(anchor),
      fakeAppview({
        posts: [
          {
            uri: publicUri,
            cid: RECORD_CID,
            author: {
              did: 'did:plc:publicccccccccccccccccccc',
              handle: 'p.test',
            },
            record: {$type: 'app.bsky.feed.post', text: 'p', createdAt: at(0)},
            indexedAt: at(0),
          },
        ],
      }),
    )
    const found = await fetchPrivateThreadV2(anchor.uri, {below: 4})
    expect(found.thread[0]).toMatchObject({
      uri: publicUri,
      depth: -1,
      value: {
        $type: 'app.bsky.unspecced.defs#threadItemPost',
        moreParents: false,
      },
    })

    serve(node(anchor))
    const missing = await fetchPrivateThreadV2(anchor.uri, {below: 4})
    expect(missing.thread[0]).toEqual({
      uri: publicUri,
      depth: -1,
      value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'},
    })
  })

  it('marks a private parent prism did not serve as not found', async () => {
    const gone = {uri: privateUri('3kgone')}
    const anchor = privateView('3kanchor', {
      reply: replyTo(gone as never, gone),
    })
    serve(node(anchor))
    const res = await fetchPrivateThreadV2(anchor.uri, {below: 4})
    expect(res.thread[0]).toEqual({
      uri: gone.uri,
      depth: -1,
      value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'},
    })
    expect(render(res.thread).map(i => i.type)).toEqual([
      'threadPostNotFound',
      'threadPost',
      'replyComposer',
    ])
  })

  it('keeps one child below depth 1 with a branching factor of 1, and the traversal adds a read more', async () => {
    const anchor = privateView('3kanchor')
    const c = privateView('3kc', {minutes: 1, reply: replyTo(anchor, anchor)})
    const d = ['3kd1', '3kd2', '3kd3'].map((rkey, i) =>
      privateView(rkey, {minutes: 2 + i, reply: replyTo(c, anchor)}),
    )
    serve(node(anchor, {replies: [node(c, {replies: d.map(v => node(v))})]}))
    const res = await fetchPrivateThreadV2(anchor.uri, {
      below: 10,
      branchingFactor: 1,
      sort: 'oldest',
    })
    expect(rkeys(res.thread)).toEqual(['3kanchor', '3kc', '3kd1'])
    expect(res.thread[1].value).toMatchObject({moreReplies: 2})
    const readMore = render(res.thread).find(i => i.type === 'readMore')
    expect(readMore).toMatchObject({
      moreReplies: 2,
      href: `/profile/author.test/ppost/3kc`,
    })
  })

  it('orders siblings newest or oldest first', async () => {
    const anchor = privateView('3kanchor')
    const replies = ['3ka', '3kb', '3kc'].map((rkey, i) =>
      privateView(rkey, {minutes: 1 + i, reply: replyTo(anchor, anchor)}),
    )
    serve(node(anchor, {replies: replies.map(v => node(v))}))
    const newest = await fetchPrivateThreadV2(anchor.uri, {
      below: 4,
      sort: 'newest',
    })
    expect(rkeys(newest.thread)).toEqual(['3kanchor', '3kc', '3kb', '3ka'])
    const oldest = await fetchPrivateThreadV2(anchor.uri, {
      below: 4,
      sort: 'oldest',
    })
    expect(rkeys(oldest.thread)).toEqual(['3kanchor', '3ka', '3kb', '3kc'])
    const top = await fetchPrivateThreadV2(anchor.uri, {below: 4, sort: 'top'})
    expect(rkeys(top.thread)).toEqual(['3kanchor', '3ka', '3kb', '3kc'])
  })

  it('marks a self-thread as opThread', async () => {
    const root = privateView('3kroot')
    const own = privateView('3kown', {minutes: 1, reply: replyTo(root, root)})
    const other = privateView('3kother', {
      did: OTHER_DID,
      minutes: 2,
      reply: replyTo(own, root),
    })
    const after = privateView('3kafter', {
      minutes: 3,
      reply: replyTo(other, root),
    })
    serve(
      node(root, {
        replies: [
          node(own, {replies: [node(other, {replies: [node(after)]})]}),
        ],
      }),
    )
    const res = await fetchPrivateThreadV2(root.uri, {below: 10})
    const op = res.thread.map(i => (i.value as {opThread?: boolean}).opThread)
    expect(rkeys(res.thread)).toEqual(['3kroot', '3kown', '3kother', '3kafter'])
    expect(op).toEqual([true, true, false, false])
  })

  it('draws a reply line below a private reply that has replies, with no counts (Thread 3)', async () => {
    const anchor = privateView('3kanchor')
    const r1 = privateView('3kr1', {
      minutes: 1,
      reply: replyTo(anchor, anchor),
    })
    const r1a = privateView('3kr1a', {minutes: 2, reply: replyTo(r1, anchor)})
    const r2 = privateView('3kr2', {minutes: 3, reply: replyTo(anchor, anchor)})
    serve(node(anchor, {replies: [node(r1, {replies: [node(r1a)]}), node(r2)]}))
    const res = await fetchPrivateThreadV2(anchor.uri, {
      below: 4,
      sort: 'oldest',
    })
    for (const view of ['linear', 'tree'] as const) {
      const lines: Record<string, boolean> = Object.fromEntries(
        render(res.thread, view)
          .filter(
            (i): i is Extract<ThreadItem, {type: 'threadPost'}> =>
              i.type === 'threadPost',
          )
          .map(i => [i.uri.split('/').pop() ?? '', i.ui.showChildReplyLine]),
      )
      expect(lines['3kr1']).toBe(true)
      expect(lines['3kr1a']).toBe(false)
      expect(lines['3kr2']).toBe(false)
    }
  })
})
