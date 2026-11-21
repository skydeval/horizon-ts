import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Block state from prism on AppView answers: a block either side reports
 * counts, partial coverage asserts nothing, the reader's own unblock wins
 * over prism's cached copy, and a slow or failing prism never holds an
 * answer past the soft wait. prism is a fake.
 */

jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

const VIEWER = 'did:plc:bsviewer00000000000000001'
const OTHER = 'did:plc:bsother000000000000000001'
const THIRD = 'did:plc:bsthird000000000000000001'
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'
const LIST = `at://${THIRD}/app.bsky.graph.list/3mlaaaaaaaaa2`
const BLOCK = `at://${VIEWER}/app.bsky.graph.block/3mlbbbbbbbbb2`

const pdsClient = {} as never
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentClients: () => ({did: VIEWER, pdsClient}),
}))

import {moderatePost, type ModerationOpts} from '@bsky/sdk/moderation'

import {getErrorName} from '#/lib/xrpc-error'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {withBlockGate} from '../feed-gate'
import {
  BLOCKS_WAIT_MS,
  type BlockState,
  connectBlockState,
  forgetBlock,
  forgetBlockList,
  resetBlockStates,
  withBlockState,
} from '../state'

const opts: ModerationOpts = {
  userDid: VIEWER,
  prefs: {
    adultContentEnabled: false,
    labels: {},
    labelers: [],
    mutedWords: [],
    hiddenPosts: [],
  },
  labelDefs: {},
}

function post(did = OTHER) {
  return {
    uri: `at://${did}/app.bsky.feed.post/3mlccccccccc2`,
    cid: CID,
    author: {
      did,
      handle: 'other.example.test',
      viewer: {} as Record<string, unknown>,
    },
    record: {$type: 'app.bsky.feed.post', text: 'hi', createdAt: 'x'},
    indexedAt: '2026-11-20T00:00:00.000Z',
  }
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })
}

let states: BlockState[] = []
let delayMs = 0
let fail = false
let calls: string[][] = []
let served = true

function agent(body: () => unknown) {
  return withBlockState({
    did: VIEWER,
    fetchHandler: () => Promise.resolve(json(body())),
  } as never) as unknown as {
    fetchHandler(path: string, init: RequestInit): Promise<Response>
  }
}

async function read(body: () => unknown) {
  const response = await agent(body).fetchHandler(
    '/xrpc/app.bsky.feed.getPosts?uris=x',
    {method: 'GET'},
  )
  return (await response.json()) as {posts: ReturnType<typeof post>[]}
}

beforeEach(() => {
  resetBlockStates()
  states = []
  delayMs = 0
  fail = false
  calls = []
  served = true
  connectBlockState({
    serves: () => served,
    fetchStates: (_client, others) => {
      calls.push(others)
      if (fail) return Promise.reject(new Error('down'))
      const answer = states.filter(state => others.includes(state.did))
      return delayMs
        ? new Promise(resolve => setTimeout(() => resolve(answer), delayMs))
        : Promise.resolve(answer)
    },
  })
})

describe('withBlockState', () => {
  it('sets a block the AppView missed, so moderation hides the post', async () => {
    states = [{did: OTHER, blockedBy: {direct: true}}]
    const body = await read(() => ({posts: [post()]}))
    expect(body.posts[0].author.viewer).toEqual({blockedBy: true})
    expect(
      moderatePost(body.posts[0] as never, opts).ui('contentList').filter,
    ).toBe(true)
    expect(calls).toEqual([[OTHER]])
  })

  it("sets a list block with the list prism couldn't read, valid in the lexicon", async () => {
    states = [
      {
        did: OTHER,
        blocking: {
          lists: [
            {
              uri: LIST,
              cid: '',
              name: '',
              purpose: 'app.bsky.graph.defs#modlist',
            },
          ],
        },
      },
    ]
    const body = await read(() => ({posts: [post()]}))
    const viewer = body.posts[0].author.viewer as {
      blocking?: string
      blockingByList?: {cid: string; name: string}
    }
    expect(viewer.blocking).toBe(LIST)
    expect(viewer.blockingByList?.cid).toBe(CID)
    expect(viewer.blockingByList?.name).toBeTruthy()
    expect(
      bsky.matches(app.bsky.actor.defs.profileViewBasic, body.posts[0].author),
    ).toBe(true)
    expect(
      moderatePost(body.posts[0] as never, opts).ui('contentList').filter,
    ).toBe(true)
  })

  it('treats partial coverage as no block', async () => {
    states = [{did: OTHER, partial: true}]
    const body = await read(() => ({posts: [post()]}))
    expect(body.posts[0].author.viewer).toEqual({})
  })

  it('never clears a block the AppView reports', async () => {
    states = [{did: OTHER}]
    const blocked = post()
    blocked.author.viewer = {blocking: BLOCK}
    const body = await read(() => ({posts: [blocked]}))
    expect(body.posts[0].author.viewer).toEqual({blocking: BLOCK})
  })

  it("lets the reader's unblock win over prism's cached copy", async () => {
    states = [
      {
        did: OTHER,
        blocking: {
          direct: BLOCK,
          lists: [{uri: LIST, cid: CID, name: 'L'}],
        },
      },
    ]
    forgetBlock(VIEWER, OTHER)
    forgetBlockList(VIEWER, LIST)
    const body = await read(() => ({posts: [post()]}))
    expect(body.posts[0].author.viewer).toEqual({})
  })

  it('waits softly: a slow answer passes through, and applies on the next read', async () => {
    jest.useFakeTimers()
    try {
      states = [{did: OTHER, blockedBy: {direct: true}}]
      delayMs = BLOCKS_WAIT_MS * 3
      const first = read(() => ({posts: [post()]}))
      await jest.advanceTimersByTimeAsync(BLOCKS_WAIT_MS + 10)
      expect((await first).posts[0].author.viewer).toEqual({})
      await jest.advanceTimersByTimeAsync(BLOCKS_WAIT_MS * 3)
      const second = await read(() => ({posts: [post()]}))
      expect(second.posts[0].author.viewer).toEqual({blockedBy: true})
      expect(calls).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('leaves answers alone when prism fails, and backs off', async () => {
    fail = true
    const body = await read(() => ({posts: [post()]}))
    expect(body.posts[0].author.viewer).toEqual({})
    await read(() => ({posts: [post(THIRD)]}))
    expect(calls).toHaveLength(1)
  })

  it("asks nothing for an account prism doesn't serve, or the reader's own views", async () => {
    served = false
    await read(() => ({posts: [post()]}))
    served = true
    await read(() => ({posts: [post(VIEWER)]}))
    expect(calls).toEqual([])
  })
})

describe('blocked profiles and reposts', () => {
  function feedApi() {
    const fetched: unknown[] = []
    return {
      fetched,
      api: {
        peekLatest: () => Promise.reject(new Error('unused')),
        fetch: (params: unknown) => {
          fetched.push(params)
          return Promise.resolve({feed: []})
        },
      },
    }
  }

  it('refuses every tab of a profile that blocks the reader', async () => {
    states = [{did: OTHER, blockedBy: {lists: [{uri: LIST}]}}]
    for (const desc of [
      `author|${OTHER}|posts_and_author_threads`,
      `author|${OTHER}|horizon_private`,
      `author|${OTHER}|posts_with_replies`,
      `likes|${OTHER}`,
    ]) {
      const {api, fetched} = feedApi()
      const error = await withBlockGate(desc, api as never)
        .fetch({cursor: undefined, limit: 30})
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      expect(getErrorName(error)).toBe('BlockedByActor')
      expect(fetched).toHaveLength(0)
    }
  })

  it('refuses a profile the reader blocks by list, until they unblock it', async () => {
    states = [{did: OTHER, blocking: {lists: [{uri: LIST}]}}]
    const desc = `author|${OTHER}|posts_and_author_threads`
    const first = await withBlockGate(desc, feedApi().api as never)
      .fetch({cursor: undefined, limit: 30})
      .catch((e: unknown) => e)
    expect(getErrorName(first)).toBe('BlockedActor')
    forgetBlockList(VIEWER, LIST)
    const {api, fetched} = feedApi()
    await withBlockGate(desc, api).fetch({
      cursor: undefined,
      limit: 30,
    })
    expect(fetched).toHaveLength(1)
  })

  it('loads a profile when prism finds no block, or only partly covers it', async () => {
    states = [{did: OTHER, partial: true}]
    const {api, fetched} = feedApi()
    await withBlockGate(`author|${OTHER}|posts_and_author_threads`, api).fetch({
      cursor: undefined,
      limit: 30,
    })
    expect(fetched).toHaveLength(1)
  })

  it('leaves out reposts by an account that blocks the reader', async () => {
    states = [{did: OTHER, blockedBy: {direct: true}}]
    const response = await agent(() => ({
      feed: [
        {
          post: post(THIRD),
          reason: {
            $type: 'app.bsky.feed.defs#reasonRepost',
            by: {did: OTHER, handle: 'other.example.test'},
            indexedAt: 'x',
          },
        },
        {post: post(THIRD)},
      ],
    })).fetchHandler('/xrpc/app.bsky.feed.getTimeline', {method: 'GET'})
    const body = (await response.json()) as {feed: {reason?: unknown}[]}
    expect(body.feed).toHaveLength(1)
    expect(body.feed[0].reason).toBeUndefined()
  })
})
