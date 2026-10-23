import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  isPrivateMember: (did?: string) => !!did,
  reportPrismError: () => {},
}))

import {i18n} from '@lingui/core'

import {
  placePrivateReply,
  PrivateParentBusyError,
  PrivateReplyRefusedError,
} from '../api/reply-anchor'
import {clearPrivateStores} from '../store'
import {DID, OTHER_DID, RECORD_CID, type Reply} from './fixtures'
import {
  AUDIENCE_URI,
  fakePrism,
  type PrivateView,
  privateView,
} from './read-fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

const ROOT = `at://${OTHER_DID}/app.bsky.feed.post/3kpublicroot2`

/**
 * A private branch under the public root: `length` posts, the first the
 * branch root (its parent the public root), each later one replying to the
 * one before.
 */
function chain(length: number): PrivateView[] {
  const posts: PrivateView[] = []
  for (let i = 0; i < length; i++) {
    const parent = i === 0 ? ROOT : posts[i - 1].uri
    posts.push(
      privateView(`3kchain${String(i).padStart(5, '0')}`, {
        did: OTHER_DID,
        minutes: i,
        reply: {
          root: {uri: ROOT, cid: RECORD_CID},
          parent: {uri: parent, cid: RECORD_CID},
        },
      }),
    )
  }
  return posts
}

/**
 * The thread view of `posts[at]` with up to `height` parents above it, the
 * public parent included when the chain reaches the branch root.
 */
function threadOf(posts: PrivateView[], at: number, height: number) {
  let parent: unknown
  const top = Math.max(0, at - height)
  if (top === 0) {
    parent = {
      $type: 'app.nearhorizon.private.defs#publicParent',
      post: {uri: ROOT},
    }
  }
  for (let i = top; i < at; i++) {
    parent = {
      $type: 'app.nearhorizon.private.defs#privateThreadView',
      post: posts[i],
      ...(parent ? {parent} : {}),
    }
  }
  return {
    $type: 'app.nearhorizon.private.defs#privateThreadView',
    post: posts[at],
    ...(parent ? {parent} : {}),
  }
}

function serve(
  posts: PrivateView[],
  thread: (uri: string, height: number) => Reply | undefined,
) {
  return fakePrism({
    posts,
    handler: (nsid, params) =>
      nsid === 'app.nearhorizon.private.getPostThread'
        ? thread(params.get('uri') ?? '', Number(params.get('parentHeight')))
        : undefined,
  })
}

function clientsFor(prism: ReturnType<typeof fakePrism>) {
  return {did: DID, pdsClient: {} as never, prismClient: prism.client}
}

function counts(prism: ReturnType<typeof fakePrism>) {
  const threads = prism.calls.filter(
    c => c.nsid === 'app.nearhorizon.private.getPostThread',
  ).length
  const posts = prism.calls.filter(
    c => c.nsid === 'app.nearhorizon.private.getPosts',
  ).length
  return {threads, posts}
}

beforeEach(() => {
  clearPrivateStores()
})

describe('the branch walk through the thread view (2H design 12.2, T16)', () => {
  it('finds the branch root in one thread call', async () => {
    const posts = chain(4)
    const prism = serve(posts, (uri, height) => ({
      status: 200,
      body: {
        thread: threadOf(
          posts,
          posts.findIndex(p => p.uri === uri),
          height,
        ),
      },
    }))
    const place = await placePrivateReply(clientsFor(prism), posts[3].uri)
    expect(place.anchor).toEqual({
      kind: 'branch',
      uri: posts[0].uri,
      authorDid: OTHER_DID,
      audienceUri: AUDIENCE_URI,
    })
    // One read of the parent, one thread call, no read per level.
    expect(counts(prism)).toEqual({threads: 1, posts: 1})
  })

  it('goes on from the top of a full chain', async () => {
    const posts = chain(33)
    const prism = serve(posts, (uri, height) => ({
      status: 200,
      body: {
        thread: threadOf(
          posts,
          posts.findIndex(p => p.uri === uri),
          height,
        ),
      },
    }))
    const place = await placePrivateReply(clientsFor(prism), posts[32].uri)
    expect(place.anchor.uri).toBe(posts[0].uri)
    expect(counts(prism)).toEqual({threads: 2, posts: 1})
  })

  it('falls back to the per-post walk where the chain stops at a missing parent', async () => {
    const posts = chain(4)
    const prism = serve(posts, uri => {
      const at = posts.findIndex(p => p.uri === uri)
      // Only the parent one level up, no further and no public parent.
      const full = threadOf(posts, at, 1) as {parent?: {parent?: unknown}}
      if (full.parent) delete full.parent.parent
      return {status: 200, body: {thread: full}}
    })
    const place = await placePrivateReply(clientsFor(prism), posts[3].uri)
    expect(place.anchor.uri).toBe(posts[0].uri)
    expect(counts(prism)).toEqual({threads: 1, posts: 4})
  })

  it('falls back on NotFound; a hop prism then leaves out is parent-busy, never a refusal (busy design 9)', async () => {
    const posts = chain(3)
    const prism = serve([posts[2], posts[1]], () => ({
      status: 400,
      body: {error: 'NotFound', message: 'not found'},
    }))
    await expect(
      placePrivateReply(clientsFor(prism), posts[2].uri),
    ).rejects.toBeInstanceOf(PrivateParentBusyError)
    expect(counts(prism).threads).toBe(1)
  })

  it('a hop on another root is still refused', async () => {
    const posts = chain(3)
    posts[1] = {
      ...posts[1],
      record: {
        ...posts[1].record,
        reply: {
          root: {uri: `${ROOT}x`, cid: RECORD_CID},
          parent: {uri: posts[0].uri, cid: RECORD_CID},
        },
      },
    }
    const prism = serve(posts, () => ({
      status: 400,
      body: {error: 'NotFound', message: 'not found'},
    }))
    await expect(
      placePrivateReply(clientsFor(prism), posts[2].uri),
    ).rejects.toBeInstanceOf(PrivateReplyRefusedError)
  })

  it('asks nothing more for a reply directly under the public post', async () => {
    const posts = chain(2)
    const prism = serve(posts, () => undefined)
    const place = await placePrivateReply(clientsFor(prism), posts[0].uri)
    expect(place.anchor.uri).toBe(posts[0].uri)
    expect(counts(prism)).toEqual({threads: 0, posts: 1})
  })
})
