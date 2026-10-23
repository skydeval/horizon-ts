import {describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  subscribeMembership: () => () => {},
  isPrivateMember: () => true,
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

import {postItem} from '#/horizon/private/thread/fetch'
import {RF_STOCK_DID, rfPost, rfThread, rfUri} from '#/horizon/refract/fixtures'
import {
  flattenRestoredThread,
  RestoredThreadUnavailableError,
} from '#/horizon/refract/thread/anchor'
import {spliceRestoredReplies} from '#/horizon/refract/thread/splice'
import {type app} from '#/lexicons'

/*
 * 11.1 "thread", the parts that stand alone (refract client design 4.2):
 * the v1 flattening for a restored anchor (RF-B5a) and the splicer
 * (RF-B5b). The thread hook's merge waits on Thread Lens 4C.
 */

type PostView = app.bsky.feed.defs.PostView
type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem

const ANCHOR = rfUri('a', RF_STOCK_DID)

function stock(rkey: string, parent?: string, createdAt?: string): PostView {
  return rfPost(rkey, {
    did: RF_STOCK_DID,
    restored: false,
    reply: parent ? {parent, root: ANCHOR} : undefined,
    createdAt,
  }) as unknown as PostView
}

function restored(
  rkey: string,
  parent: string,
  createdAt = '2026-10-23T10:00:00.000Z',
  likeCount = 0,
): PostView {
  return rfPost(rkey, {
    reply: {parent, root: ANCHOR},
    createdAt,
    likeCount,
  }) as unknown as PostView
}

function uris(items: ThreadItem[]) {
  return items.map(item => `${item.depth}:${item.uri.split('/').pop()}`)
}

const OPTS = {below: 6, branchingFactor: 2, sort: 'oldest'}

describe('flattenRestoredThread', () => {
  it('flattens a v1 thread to v2 items under the anchor', () => {
    const items = flattenRestoredThread(rfThread().thread, OPTS)
    expect(uris(items)).toEqual(['0:rf1', '1:stockreply'])
    expect(items[0].value.$type).toBe('app.bsky.unspecced.defs#threadItemPost')
  })

  it('the unavailable error never reads as "Post not found"', () => {
    expect(new RestoredThreadUnavailableError('did:plc:x').message).not.toMatch(
      /^Post not found/,
    )
  })
})

describe('spliceRestoredReplies', () => {
  const anchor = postItem(stock('a'), 0, {})
  const child = postItem(stock('c1', ANCHOR, '2026-10-23T09:00:00.000Z'), 1, {})
  const deep = postItem(stock('d1', rfUri('c1', RF_STOCK_DID)), 2, {})

  it('places replies under the anchor and deep parents, and keeps stock order', () => {
    const items = spliceRestoredReplies(
      [anchor, child, deep],
      {
        replies: [
          restored('r1', ANCHOR, '2026-10-23T11:00:00.000Z'),
          restored('r2', rfUri('d1', RF_STOCK_DID)),
        ],
        ownReplies: [],
        parents: [],
      },
      OPTS,
    )
    expect(uris(items)).toEqual(['0:a', '1:c1', '2:d1', '3:r2', '1:r1'])
  })

  it('interleaves by time for oldest and newest', () => {
    const early = restored('r0', ANCHOR, '2026-10-23T08:00:00.000Z')
    const oldest = spliceRestoredReplies(
      [anchor, child],
      {replies: [early], ownReplies: [], parents: []},
      OPTS,
    )
    expect(uris(oldest)).toEqual(['0:a', '1:r0', '1:c1'])
    const newest = spliceRestoredReplies(
      [anchor, child],
      {replies: [early], ownReplies: [], parents: []},
      {...OPTS, sort: 'newest'},
    )
    expect(uris(newest)).toEqual(['0:a', '1:c1', '1:r0'])
  })

  it('a ranked sort puts them after stock’s siblings by like count', () => {
    const items = spliceRestoredReplies(
      [anchor, child],
      {
        replies: [
          restored('few', ANCHOR, '2026-10-23T08:00:00.000Z', 1),
          restored('many', ANCHOR, '2026-10-23T08:30:00.000Z', 9),
        ],
        ownReplies: [],
        parents: [],
      },
      {...OPTS, sort: 'hotness'},
    )
    expect(uris(items)).toEqual(['0:a', '1:c1', '1:many', '1:few'])
  })

  it('replaces a same-URI not-found item and keeps a blocked one', () => {
    const notFound: ThreadItem = {
      uri: rfUri('r1') as never,
      depth: 1,
      value: {$type: 'app.bsky.unspecced.defs#threadItemNotFound'},
    }
    const blocked: ThreadItem = {
      uri: rfUri('b1') as never,
      depth: 1,
      value: {
        $type: 'app.bsky.unspecced.defs#threadItemBlocked',
        author: {did: 'did:plc:b'} as never,
      },
    }
    const items = spliceRestoredReplies(
      [anchor, notFound, blocked],
      {
        replies: [restored('r1', ANCHOR), restored('b1', ANCHOR)],
        ownReplies: [],
        parents: [],
      },
      OPTS,
    )
    expect(items[1].value.$type).toBe('app.bsky.unspecced.defs#threadItemPost')
    expect(items[2].value.$type).toBe(
      'app.bsky.unspecced.defs#threadItemBlocked',
    )
  })

  it('respects below and the branching factor, and drops orphans', () => {
    const items = spliceRestoredReplies(
      [anchor, child],
      {
        replies: [
          restored('x1', rfUri('c1', RF_STOCK_DID)),
          restored('x2', rfUri('c1', RF_STOCK_DID)),
          restored('x3', rfUri('c1', RF_STOCK_DID)),
          restored('orphan', rfUri('nowhere')),
        ],
        ownReplies: [],
        parents: [],
      },
      OPTS,
    )
    const placed = uris(items).filter(entry => entry.startsWith('2:'))
    expect(placed).toHaveLength(2)
    const c1 = items[1].value as {moreReplies?: number}
    expect(c1.moreReplies).toBe(1)
    expect(uris(items).some(entry => entry.endsWith('orphan'))).toBe(false)
    const shallow = spliceRestoredReplies(
      [anchor, child],
      {
        replies: [restored('x1', rfUri('c1', RF_STOCK_DID))],
        ownReplies: [],
        parents: [],
      },
      {...OPTS, below: 1},
    )
    expect(uris(shallow)).toEqual(['0:a', '1:c1'])
  })

  it('dedupes by URI and places the reader’s own reply under a placed one', () => {
    const r1 = restored('r1', ANCHOR)
    const own = rfPost('own', {
      did: 'did:plc:rfxreader000000000000000001',
      restored: false,
      reply: {parent: rfUri('r1'), root: ANCHOR},
    }) as unknown as PostView
    const items = spliceRestoredReplies(
      [anchor],
      {replies: [r1, r1], ownReplies: [own], parents: []},
      OPTS,
    )
    expect(uris(items)).toEqual(['0:a', '1:r1', '2:own'])
  })
})
