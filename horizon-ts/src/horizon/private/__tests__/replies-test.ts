import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMember = true
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => (mockMember ? 'member' : 'not-member'),
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did && mockMember,
}))
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))
jest.mock('#/horizon/private/api/gates', () => ({
  ...jest.requireActual<object>('#/horizon/private/api/gates'),
  threadGateEvaluation: () => Promise.resolve(undefined),
}))

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {type app} from '#/lexicons'
import {resetThreadMuteResync} from '../api/thread-mute'
import {clearPrivateStores} from '../store'
import {
  getReplyContinuation,
  resetReplyContinuations,
  setReplyContinuation,
} from '../thread/continuation'
import {fetchPrivateThreadV2} from '../thread/fetch'
import {
  fetchOtherReplies,
  MAX_OTHER_REPLY_PAGES,
  spliceSubtrees,
  withPrivateBranches,
} from '../thread/replies'
import {DID, RECORD_CID, type Reply} from './fixtures'
import {
  at,
  fakeAppview,
  fakePrism,
  type PrivateView,
  privateView,
} from './read-fixtures'

type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem
type ThreadOutput = app.bsky.unspecced.getPostThreadV2.$OutputBody

const PUB_DID = 'did:plc:publicccccccccccccccccccc'
const ANCHOR = `at://${PUB_DID}/app.bsky.feed.post/3kanchor22222`

let prismHandler: (
  nsid: string,
  params: URLSearchParams,
) => Reply | Promise<Reply> | undefined

function publish(publishClients = true) {
  const prism = fakePrism({
    handler: (nsid, params) => prismHandler(nsid, params) as Reply | undefined,
  })
  const appview = fakeAppview()
  clearCurrentClients()
  if (publishClients) {
    publishCurrentClients({
      did: DID,
      handle: 'reader.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: prism.client,
      appviewClient: appview.client,
    })
  }
  return prism
}

function publicPost(rkey: string, minutes: number, depth: number): ThreadItem {
  const uri = `at://${PUB_DID}/app.bsky.feed.post/${rkey}`
  return {
    uri: uri as ThreadItem['uri'],
    depth,
    value: {
      $type: 'app.bsky.unspecced.defs#threadItemPost',
      post: {
        uri,
        cid: RECORD_CID,
        author: {did: PUB_DID, handle: 'pub.test'},
        record: {
          $type: 'app.bsky.feed.post',
          text: rkey,
          createdAt: at(minutes),
          ...(depth > 0
            ? {
                reply: {
                  root: {uri: ANCHOR, cid: RECORD_CID},
                  parent: {uri: ANCHOR, cid: RECORD_CID},
                },
              }
            : {}),
        },
        indexedAt: at(minutes),
        viewer: {threadMuted: false},
      },
      moreParents: false,
      moreReplies: 0,
      opThread: false,
      hiddenByThreadgate: false,
      mutedByViewer: false,
    },
  } as unknown as ThreadItem
}

function stockThread(hasOtherReplies = false): ThreadOutput {
  return {
    thread: [
      publicPost('3kanchor22222', 0, 0),
      publicPost('3kpubreply111', 2, 1),
      publicPost('3kpubreply333', 6, 1),
    ],
    hasOtherReplies,
  }
}

function branch(rkey: string, minutes: number, extra: object = {}) {
  return {
    ...privateView(rkey, {
      minutes,
      reply: {
        root: {uri: ANCHOR, cid: RECORD_CID},
        parent: {uri: ANCHOR, cid: RECORD_CID},
      },
    }),
    ...extra,
  }
}

function node(post: PrivateView, replies: unknown[] = []) {
  return {
    $type: 'app.nearhorizon.private.defs#privateThreadView',
    post,
    replies,
  }
}

function rkeys(thread: {uri: string}[]) {
  return thread.map(item => item.uri.split('/').pop())
}

beforeEach(() => {
  mockMember = true
  prismHandler = () => undefined
  clearPrivateStores()
  resetReplyContinuations()
  resetThreadMuteResync()
  resetPrismFeatures()
  answerPrismFeatures(DID, ['private', 'private.paging'])
})

describe('private branches under a public anchor (2H design 9.2, T12)', () => {
  function serveBranches(cursor?: string) {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.getReplies'
        ? {
            status: 200,
            body: {
              replies: [
                node(branch('3kpriv444444', 4)),
                node(branch('3kpriv888888', 8)),
              ],
              ...(cursor ? {cursor} : {}),
            },
          }
        : undefined
  }

  it('puts private subtrees first under the anchor for top', async () => {
    serveBranches()
    const prism = publish()
    const result = await withPrivateBranches(
      ANCHOR,
      {below: 6, sort: 'top'},
      () => Promise.resolve(stockThread()),
    )
    expect(rkeys(result.thread)).toEqual([
      '3kanchor22222',
      '3kpriv444444',
      '3kpriv888888',
      '3kpubreply111',
      '3kpubreply333',
    ])
    const call = prism.calls.find(
      c => c.nsid === 'app.nearhorizon.private.getReplies',
    )
    expect(call?.params.get('uri')).toBe(ANCHOR)
    expect(call?.params.get('depth')).toBe('5')
    expect(result.hasOtherReplies).toBe(false)
  })

  it('interleaves by time for newest and oldest', async () => {
    serveBranches()
    publish()
    const oldest = await withPrivateBranches(
      ANCHOR,
      {below: 6, sort: 'oldest'},
      () => Promise.resolve(stockThread()),
    )
    expect(rkeys(oldest.thread)).toEqual([
      '3kanchor22222',
      '3kpubreply111',
      '3kpriv444444',
      '3kpubreply333',
      '3kpriv888888',
    ])
    const newest = await withPrivateBranches(
      ANCHOR,
      {below: 6, sort: 'newest'},
      () => {
        const stock = stockThread()
        stock.thread = [stock.thread[0], stock.thread[2], stock.thread[1]]
        return Promise.resolve(stock)
      },
    )
    expect(rkeys(newest.thread)).toEqual([
      '3kanchor22222',
      '3kpriv888888',
      '3kpubreply333',
      '3kpriv444444',
      '3kpubreply111',
    ])
  })

  it('puts the stock subtree first on a tie', () => {
    const stock = [[publicPost('3kpub', 4, 1)]]
    const priv = [
      {time: Date.parse(at(4)), items: [publicPost('3kpriv', 4, 1)]},
    ]
    expect(rkeys(spliceSubtrees(stock, priv, 'oldest'))).toEqual([
      '3kpub',
      '3kpriv',
    ])
    expect(rkeys(spliceSubtrees(stock, priv, 'newest'))).toEqual([
      '3kpub',
      '3kpriv',
    ])
  })

  it('stores a continuation on a final cursor', async () => {
    serveBranches('more')
    publish()
    const result = await withPrivateBranches(
      ANCHOR,
      {below: 6, sort: 'top'},
      () => Promise.resolve(stockThread(true)),
    )
    expect(result.hasOtherReplies).toBe(true)
    const continuation = getReplyContinuation(ANCHOR)
    expect(continuation?.cursor).toBe('more')
    expect(continuation?.stockHasOther).toBe(true)
    expect([...(continuation?.seen ?? [])].length).toBe(2)
  })

  it('returns the stock answer at the deadline', async () => {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.getReplies'
        ? new Promise<Reply>(() => {})
        : undefined
    publish()
    const stock = stockThread()
    const result = await withPrivateBranches(
      ANCHOR,
      {below: 6, sort: 'top'},
      () => Promise.resolve(stock),
    )
    expect(result).toBe(stock)
  }, 10_000)

  it('asks prism nothing for a non-member, without the feature, or signed out', async () => {
    serveBranches()
    const prism = publish()
    mockMember = false
    const stock = stockThread()
    expect(
      await withPrivateBranches(ANCHOR, {below: 6}, () =>
        Promise.resolve(stock),
      ),
    ).toBe(stock)
    mockMember = true
    resetPrismFeatures()
    answerPrismFeatures(DID, ['private'])
    expect(
      await withPrivateBranches(ANCHOR, {below: 6}, () =>
        Promise.resolve(stock),
      ),
    ).toBe(stock)
    answerPrismFeatures(DID, ['private', 'private.paging'])
    clearCurrentClients()
    expect(
      await withPrivateBranches(ANCHOR, {below: 6}, () =>
        Promise.resolve(stock),
      ),
    ).toBe(stock)
    expect(prism.calls).toEqual([])
  })
})

describe('other replies (2H design 9.3, T12)', () => {
  function continuation(stockHasOther: boolean) {
    setReplyContinuation(ANCHOR, {
      kind: 'public',
      anchorUri: ANCHOR,
      cursor: 'c0',
      depth: 2,
      sort: 'oldest',
      branchingFactor: undefined,
      seen: new Set([branch('3kpriv000000', 1).uri]),
      cids: new Map([[ANCHOR, RECORD_CID]]),
      stockHasOther,
      key: 'public|pages|',
      hidden: [],
      pages: true,
      readAt: 0,
    })
  }

  it('reads on from the cursor, skipping replies already shown, up to the page cap', async () => {
    let page = 0
    prismHandler = nsid => {
      if (nsid !== 'app.nearhorizon.private.getReplies') return undefined
      page++
      const replies =
        page === 1
          ? [node(branch('3kpriv000000', 1)), node(branch('3kpriv111111', 0))]
          : [node(branch(`3kpage${String(page).padStart(6, '0')}`, page))]
      return {status: 200, body: {replies, cursor: `c${page}`}}
    }
    const prism = publish()
    continuation(false)
    const stockOther = jest.fn(() => Promise.resolve({thread: []}))
    const result = await fetchOtherReplies(ANCHOR, stockOther)
    expect(stockOther).not.toHaveBeenCalled()
    const calls = prism.calls.filter(
      c => c.nsid === 'app.nearhorizon.private.getReplies',
    )
    expect(calls).toHaveLength(MAX_OTHER_REPLY_PAGES)
    expect(calls[0].params.get('cursor')).toBe('c0')
    expect(calls[1].params.get('cursor')).toBe('c1')
    const keys = rkeys(result.thread)
    expect(keys).not.toContain('3kpriv000000')
    expect(keys[0]).toBe('3kpriv111111')
    expect(keys).toHaveLength(MAX_OTHER_REPLY_PAGES)
  })

  it('asks the stock other replies only when they have something', async () => {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.getReplies'
        ? {status: 200, body: {replies: [node(branch('3kpriv111111', 2))]}}
        : undefined
    publish()
    continuation(true)
    const stockItem = publicPost('3kother22222', 3, 1)
    const stockOther = jest.fn(() =>
      Promise.resolve({
        thread: [stockItem],
      }),
    ) as unknown as () => Promise<app.bsky.unspecced.getPostThreadOtherV2.$OutputBody>
    const result = await fetchOtherReplies(ANCHOR, stockOther)
    expect(rkeys(result.thread)).toEqual(['3kother22222', '3kpriv111111'])
  })

  it('is the stock call without a continuation', async () => {
    const prism = publish()
    const stock = {thread: []}
    expect(await fetchOtherReplies(ANCHOR, () => Promise.resolve(stock))).toBe(
      stock,
    )
    expect(prism.calls).toEqual([])
  })
})

describe('private thread overflow (2H design 9.1, T12)', () => {
  const counts = (replyCount: number) => ({
    replyCount,
    repostCount: 0,
    likeCount: 0,
    quoteCount: 0,
  })

  function serveThread(anchor: object, replies: unknown[]) {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.getPostThread'
        ? {
            status: 200,
            body: {
              thread: {
                $type: 'app.nearhorizon.private.defs#privateThreadView',
                post: anchor,
                replies,
              },
            },
          }
        : undefined
    publish()
  }

  function privateReply(rkey: string, parent: PrivateView, extra = {}) {
    return {
      ...privateView(rkey, {
        minutes: 1,
        reply: {
          root: {uri: parent.uri, cid: RECORD_CID},
          parent: {uri: parent.uri, cid: RECORD_CID},
        },
      }),
      ...extra,
    }
  }

  it('turns a served replyCount below the served depth into read-more', async () => {
    const anchor = privateView('3kanchor', {minutes: 0})
    const reply = privateReply('3kreply', anchor, counts(3))
    serveThread({...anchor, ...counts(1)}, [node(reply)])
    const result = await fetchPrivateThreadV2(anchor.uri, {below: 10})
    const item = result.thread.find(i => i.uri === reply.uri)
    expect((item?.value as {moreReplies: number}).moreReplies).toBe(3)
    expect(result.hasOtherReplies).toBe(false)
  })

  it('continues the anchor when its served count exceeds what came, with private.paging', async () => {
    const anchor = privateView('3kanchor', {minutes: 0})
    const reply = privateReply('3kreply', anchor, counts(0))
    serveThread({...anchor, ...counts(5)}, [node(reply)])
    const result = await fetchPrivateThreadV2(anchor.uri, {below: 10})
    expect(result.hasOtherReplies).toBe(true)
    const continuation = getReplyContinuation(anchor.uri)
    expect(continuation?.kind).toBe('private')
    expect(continuation?.cursor).toBeUndefined()
    expect(continuation?.depth).toBe(6)
    expect([...(continuation?.seen ?? [])]).toEqual([reply.uri])

    resetPrismFeatures()
    answerPrismFeatures(DID, ['private'])
    const without = await fetchPrivateThreadV2(anchor.uri, {below: 10})
    expect(without.hasOtherReplies).toBe(false)
    expect(getReplyContinuation(anchor.uri)).toBeUndefined()
  })

  it('continues the anchor at prism\u{2019}s node cap without counts', async () => {
    const anchor = privateView('3kanchor', {minutes: 0})
    const replies = Array.from({length: 50}, (_, i) =>
      node(privateReply(`3kreply${String(i).padStart(5, '0')}`, anchor)),
    )
    serveThread(anchor, replies)
    const result = await fetchPrivateThreadV2(anchor.uri, {below: 3})
    expect(result.hasOtherReplies).toBe(true)
    expect(getReplyContinuation(anchor.uri)?.depth).toBe(2)
  })
})
