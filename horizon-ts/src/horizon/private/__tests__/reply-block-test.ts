import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * The reply block check (private reply design 2; skydeval, 2026-10-23),
 * through `planFirstPost`, the plan both routes share: a private reply to
 * another author's post comes out of planning only with a `clear` verdict
 * between the member and the immediate parent's author.
 */
const mockResolveReply = jest.fn()
jest.mock('#/lib/api/index', () => ({
  resolveEmbed: () => Promise.resolve(undefined),
  resolveReply: (...args: unknown[]) => mockResolveReply(...args),
}))
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))
jest.mock('#/state/queries/profile', () => ({
  RQKEY: (did: string) => ['profile', did],
}))
jest.mock('#/state/queries/resolve-link', () => ({
  RQKEY_LINK: (url: string) => ['resolve-link', url],
}))
let mockOtherPds: unknown
jest.mock('#/horizon/private/api/gates', () => ({
  ...jest.requireActual<object>('#/horizon/private/api/gates'),
  gatePdsClient: () => Promise.resolve(mockOtherPds),
}))
let mockBlueskyAppview = true
jest.mock('#/horizon/routing/public-appview', () => ({
  ...jest.requireActual<object>('#/horizon/routing/public-appview'),
  usesBlueskyPublicAppview: () => mockBlueskyAppview,
}))

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {resetPrismHealth} from '#/horizon/routing/health'
import {type Plan, planFirstPost} from '../api/compose'
import {PrivateParentBusyError} from '../api/reply-anchor'
import {
  PrivateReplyBlockedError,
  PrivateReplyCheckError,
  recheckReplyBlock,
  REPLY_BLOCK_TIMING,
} from '../api/reply-block'
import {type PostingWriter} from '../api/writer'
import {type ComposeAudience} from '../composer/state'
import {clearPrivateStores} from '../store'
import {
  type Call,
  DID,
  fakeClient,
  OTHER_AUDIENCE,
  OTHER_DID,
  privateUri,
  RECORD_CID,
  relationshipsReply,
  type Reply,
} from './fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

const PP = 'tools.kryphocron.feed.postPrivate'
const AUD = 'tools.kryphocron.policy.audience'
const BLOCK = 'tools.kryphocron.graph.block'
const THIRD_DID = 'did:plc:thirdcccccccccccccccccccc'
const EVERYONE_AUDIENCE = `at://${DID}/${AUD}/3keveryone22`
const PUBLIC_ROOT = `at://${THIRD_DID}/app.bsky.feed.post/3kpubroot222`
const PUBLIC_PARENT = `at://${OTHER_DID}/app.bsky.feed.post/3kpubpar2222`
const BLOCKED_TEXT = 'You can’t reply to this post.'
const BUSY_TEXT =
  'Couldn’t reach the post you’re replying to. Try again in a moment.'

let appview: ReturnType<typeof fakeClient>
let appviewAnswer: (call: Call) => Reply | Promise<Reply>
let prism: ReturnType<typeof fakeClient>
let served: Record<string, unknown>[]
let pds: ReturnType<typeof fakeClient>
let ownBlocks: Record<string, unknown>[]
let ownRecords: Record<string, Record<string, unknown>>
let audiences: {uri: string; value: Record<string, unknown>}[]
let other: ReturnType<typeof fakeClient>
let otherBlocks: Record<string, unknown>[]
let writer: PostingWriter & {createAudience: jest.Mock}

function listing(call: Call, values: Record<string, unknown>[]): Reply {
  return {
    status: 200,
    body: {
      records: values.map((value, n) => ({
        uri: `at://${call.params.get('repo')}/${call.params.get('collection')}/3kblock${n}2222`,
        cid: RECORD_CID,
        value,
      })),
    },
  }
}

function servedPost(
  uri: string,
  did: string,
  fields: Record<string, unknown> = {},
) {
  return {
    uri,
    cid: RECORD_CID,
    author: {did, handle: 'someone.test'},
    record: {
      $type: PP,
      text: 'post',
      createdAt: '2026-10-15T12:00:00.000Z',
      audienceList: OTHER_AUDIENCE,
      ...fields,
    },
    indexedAt: '2026-10-15T12:00:00.000Z',
    labels: [],
  }
}

beforeEach(() => {
  resetPrismHealth()
  clearPrivateStores()
  mockBlueskyAppview = true
  REPLY_BLOCK_TIMING.callMs = 10_000
  REPLY_BLOCK_TIMING.freshMs = 2_000
  appviewAnswer = call => relationshipsReply(call) ?? {status: 501}
  appview = fakeClient(DID, call => appviewAnswer(call))
  served = []
  prism = fakeClient(DID, call =>
    call.nsid === 'app.nearhorizon.private.getPosts'
      ? {
          status: 200,
          body: {
            posts: served.filter(post =>
              call.params.getAll('uris').includes(post.uri as string),
            ),
          },
        }
      : {status: 200, body: {status: 'indexed'}},
  )
  ownBlocks = []
  ownRecords = {}
  audiences = [{uri: EVERYONE_AUDIENCE, value: {$type: AUD, mode: 'everyone'}}]
  pds = fakeClient(DID, call => {
    if (call.nsid === 'com.atproto.repo.listRecords') {
      return call.params.get('collection') === BLOCK
        ? listing(call, ownBlocks)
        : listing(
            call,
            audiences.map(a => a.value),
          )
    }
    if (call.nsid === 'com.atproto.repo.getRecord') {
      const rkey = call.params.get('rkey') ?? ''
      const value = ownRecords[rkey]
      return value
        ? {
            status: 200,
            body: {uri: privateUri(rkey), cid: RECORD_CID, value},
          }
        : {status: 400, body: {error: 'RecordNotFound'}}
    }
    return {status: 501}
  })
  otherBlocks = []
  other = fakeClient(OTHER_DID, call =>
    call.nsid === 'com.atproto.repo.listRecords'
      ? listing(call, otherBlocks)
      : {status: 501},
  )
  mockOtherPds = other.client
  writer = {
    route: 'encode',
    createPost: jest.fn(() => Promise.resolve({cid: RECORD_CID})),
    changeAudience: jest.fn(() => Promise.resolve({cid: RECORD_CID})),
    createAudience: jest.fn(() =>
      Promise.resolve({uri: `at://${DID}/${AUD}/3kcreated22`}),
    ),
  } as unknown as PostingWriter & {createAudience: jest.Mock}
  mockResolveReply.mockReset()
  mockResolveReply.mockImplementation(() =>
    Promise.resolve({
      root: {uri: PUBLIC_ROOT, cid: RECORD_CID},
      parent: {uri: PUBLIC_PARENT, cid: RECORD_CID},
    }),
  )
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl: 'https://pds.example',
    pdsClient: pds.client,
    prismClient: prism.client,
    appviewClient: appview.client,
  })
})

function plan(
  replyTo: string | undefined,
  {
    audience = {kind: 'mode', mode: 'everyone'},
    skipBlockCheck,
  }: {audience?: ComposeAudience; skipBlockCheck?: boolean} = {},
): Promise<Plan> {
  return planFirstPost(
    new QueryClient(),
    {did: DID, pdsClient: pds.client, prismClient: prism.client},
    {replyTo, appviewClient: appview.client, skipBlockCheck},
    audience,
    writer,
  )
}

function relationshipCalls() {
  return appview.calls.filter(
    call => call.nsid === 'app.bsky.graph.getRelationships',
  )
}

function blockListings(calls: Call[]) {
  return calls.filter(
    call =>
      call.nsid === 'com.atproto.repo.listRecords' &&
      call.params.get('collection') === BLOCK,
  )
}

describe('a reply to another author’s private post', () => {
  const PARENT = privateUri('3kparent2222', OTHER_DID)

  beforeEach(() => {
    served = [servedPost(PARENT, OTHER_DID)]
  })

  it.each([
    [
      'the member blocks the author',
      {blocking: `at://${DID}/app.bsky.graph.block/3kblock22222`},
    ],
    [
      'the author blocks the member',
      {blockedBy: `at://${OTHER_DID}/app.bsky.graph.block/3kblock22222`},
    ],
    [
      'the member list-blocks the author',
      {blockingByList: `at://${DID}/app.bsky.graph.listblock/3kblock22222`},
    ],
    [
      'the author list-blocks the member',
      {
        blockedByList: `at://${OTHER_DID}/app.bsky.graph.listblock/3kblock22222`,
      },
    ],
  ])(
    '%s: refused with the blocked text, nothing written',
    async (_name, fields) => {
      appviewAnswer = call => relationshipsReply(call, fields) ?? {status: 501}
      const error = await plan(PARENT).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(PrivateReplyBlockedError)
      expect((error as Error).message).toBe(BLOCKED_TEXT)
      expect(writer.createAudience).not.toHaveBeenCalled()
    },
  )

  it('asks the member’s AppView once, as the member, about the parent’s author', async () => {
    const placed = await plan(PARENT)
    const calls = relationshipCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].params.get('actor')).toBe(DID)
    expect(calls[0].params.getAll('others')).toEqual([OTHER_DID])
    expect(placed.blockCheck).toMatchObject({
      authorDid: OTHER_DID,
      privateBlocks: 'prism',
    })
  })

  it('a private block: prism’s serve is the check, so no listing is read; prism leaving the parent out fails before any write', async () => {
    await plan(PARENT)
    expect(blockListings(pds.calls)).toEqual([])
    expect(blockListings(other.calls)).toEqual([])

    // prism's read rule refuses a privately blocked pair: the parent is left out.
    served = []
    await expect(plan(PARENT)).rejects.toBeInstanceOf(PrivateParentBusyError)
  })

  it('a block wins over a placement miss', async () => {
    served = []
    appviewAnswer = call =>
      relationshipsReply(call, {
        blockedBy: `at://${OTHER_DID}/app.bsky.graph.block/3kblock22222`,
      }) ?? {
        status: 501,
      }
    await expect(plan(PARENT)).rejects.toBeInstanceOf(PrivateReplyBlockedError)
  })

  it('the thread’s root author blocked but not the parent’s: the reply is planned', async () => {
    const root = privateUri('3kroot222222', THIRD_DID)
    const reply = privateUri('3kreply22222', OTHER_DID)
    served = [
      servedPost(root, THIRD_DID),
      servedPost(reply, OTHER_DID, {
        reply: {
          root: {uri: root, cid: RECORD_CID},
          parent: {uri: root, cid: RECORD_CID},
        },
      }),
    ]
    appviewAnswer = call => {
      if (call.nsid !== 'app.bsky.graph.getRelationships') return {status: 501}
      const others = call.params.getAll('others')
      return relationshipsReply(
        call,
        others.includes(THIRD_DID)
          ? {blockedBy: `at://${THIRD_DID}/app.bsky.graph.block/3kblock22222`}
          : {},
      ) as Reply
    }
    const placed = await plan(reply)
    expect(placed.reply?.parent.uri).toBe(reply)
    expect(relationshipCalls().map(c => c.params.getAll('others'))).toEqual([
      [OTHER_DID],
    ])
  })

  it.each([
    ['a 500', () => ({status: 500, body: {error: 'InternalServerError'}})],
    ['a network failure', () => new TypeError('Network request failed')],
    [
      'no relationship for the author',
      (call: Call) => ({
        status: 200,
        body: {
          actor: call.params.get('actor'),
          relationships: [
            {
              $type: 'app.bsky.graph.defs#notFoundActor',
              actor: OTHER_DID,
              notFound: true,
            },
          ],
        },
      }),
    ],
  ] as [string, (call: Call) => Reply][])(
    'the AppView answering %s: cannot check, the neutral text, nothing written',
    async (_name, answer) => {
      appviewAnswer = answer
      const error = await plan(PARENT).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(PrivateReplyCheckError)
      expect((error as Error).message).toBe(BUSY_TEXT)
      expect(writer.createAudience).not.toHaveBeenCalled()
    },
  )

  it('an AppView that never answers is cannot check at the read deadline', async () => {
    REPLY_BLOCK_TIMING.callMs = 30
    appviewAnswer = () => new Promise<Reply>(() => {})
    await expect(plan(PARENT)).rejects.toBeInstanceOf(PrivateReplyCheckError)
  })

  it('on any AppView, absent list fields mean no list block', async () => {
    mockBlueskyAppview = false
    await expect(plan(PARENT)).resolves.toBeDefined()
    // A direct block it does report still refuses.
    appviewAnswer = call =>
      relationshipsReply(call, {
        blocking: `at://${DID}/app.bsky.graph.block/3kblock22222`,
      }) ?? {status: 501}
    await expect(plan(PARENT)).rejects.toBeInstanceOf(PrivateReplyBlockedError)
  })
})

describe('a reply to the member’s own post', () => {
  it('reads nothing for the check, private or public', async () => {
    const own = privateUri('3kownpost222')
    ownRecords['3kownpost222'] = {
      $type: PP,
      text: 'own',
      createdAt: '2026-10-15T12:00:00.000Z',
      audienceList: EVERYONE_AUDIENCE,
    }
    appviewAnswer = () => ({status: 500})
    const placed = await plan(own)
    expect(placed.audienceUri).toBe(EVERYONE_AUDIENCE)
    expect(placed.blockCheck).toBeUndefined()
    expect(relationshipCalls()).toEqual([])

    const ownPublic = `at://${DID}/app.bsky.feed.post/3kownpub2222`
    const branch = await plan(ownPublic)
    expect(branch.blockCheck).toBeUndefined()
    expect(relationshipCalls()).toEqual([])
    expect(blockListings(pds.calls)).toEqual([])
  })

  it('a Finish posting skips the check', async () => {
    const PARENT = privateUri('3kparent2222', OTHER_DID)
    served = [servedPost(PARENT, OTHER_DID)]
    appviewAnswer = () => ({status: 500})
    const placed = await plan(PARENT, {skipBlockCheck: true})
    expect(placed.blockCheck).toBeUndefined()
    expect(relationshipCalls()).toEqual([])
  })
})

describe('a private reply to a public post', () => {
  it('reads the AppView and both private block listings, and plans when all are clear', async () => {
    const placed = await plan(PUBLIC_PARENT)
    expect(relationshipCalls()).toHaveLength(1)
    expect(blockListings(pds.calls).map(c => c.params.get('repo'))).toEqual([
      DID,
    ])
    expect(blockListings(other.calls).map(c => c.params.get('repo'))).toEqual([
      OTHER_DID,
    ])
    expect(placed.blockCheck).toMatchObject({privateBlocks: 'listings'})
  })

  it.each([
    ['the member privately blocks the author', 'own'],
    ['the author privately blocks the member', 'other'],
  ])('%s: refused, and no audience is created', async (_name, side) => {
    audiences = []
    if (side === 'own') ownBlocks = [{$type: BLOCK, subject: OTHER_DID}]
    else otherBlocks = [{$type: BLOCK, subject: DID}]
    await expect(plan(PUBLIC_PARENT)).rejects.toBeInstanceOf(
      PrivateReplyBlockedError,
    )
    expect(writer.createAudience).not.toHaveBeenCalled()
  })

  it('a listing that fails is cannot check, never "Your server couldn’t save this post"', async () => {
    other = fakeClient(OTHER_DID, () => ({status: 500, body: {}}))
    mockOtherPds = other.client
    await expect(plan(PUBLIC_PARENT)).rejects.toBeInstanceOf(
      PrivateReplyCheckError,
    )
  })

  it('a list block via the AppView is refused', async () => {
    appviewAnswer = call =>
      relationshipsReply(call, {
        blockedByList: `at://${OTHER_DID}/app.bsky.graph.listblock/3kblock22222`,
      }) ?? {status: 501}
    await expect(plan(PUBLIC_PARENT)).rejects.toBeInstanceOf(
      PrivateReplyBlockedError,
    )
  })
})

describe('the check before the first write (PR2-L1)', () => {
  const PARENT = privateUri('3kparent2222', OTHER_DID)
  const clients = () => ({
    did: DID,
    pdsClient: pds.client,
    appviewClient: appview.client,
  })

  it('a fresh verdict reads nothing; a stale one is taken again, and a block made since refuses', async () => {
    served = [servedPost(PARENT, OTHER_DID)]
    const placed = await plan(PARENT)
    await recheckReplyBlock(clients(), placed.blockCheck)
    expect(relationshipCalls()).toHaveLength(1)

    REPLY_BLOCK_TIMING.freshMs = 0
    appviewAnswer = call =>
      relationshipsReply(call, {
        blockedBy: `at://${OTHER_DID}/app.bsky.graph.block/3kblock22222`,
      }) ?? {
        status: 501,
      }
    await expect(
      recheckReplyBlock(clients(), placed.blockCheck),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)
    expect(relationshipCalls()).toHaveLength(2)
  })

  it('the recheck repeats the listings when the plan used them', async () => {
    const placed = await plan(PUBLIC_PARENT)
    REPLY_BLOCK_TIMING.freshMs = 0
    otherBlocks = [{$type: BLOCK, subject: DID}]
    await expect(
      recheckReplyBlock(clients(), placed.blockCheck),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)
  })
})
