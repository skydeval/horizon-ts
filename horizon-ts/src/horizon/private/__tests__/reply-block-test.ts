import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * The reply block check (private reply design 2; skydeval, 2026-10-23),
 * through `planFirstPost`, the plan both routes share: a private reply to
 * another author's post comes out of planning only with a `clear` AppView
 * verdict between the member and each pair author (the immediate parent's
 * author and the thread's owner). Kryphocron blocks are halted, so no PDS
 * listing is read.
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
  readAppviewRelationships,
  recheckReplyBlock,
  REPLY_BLOCK_TIMING,
  type ReplyBlockCheck,
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
const THIRD_DID = 'did:plc:thirdcccccccccccccccccccc'
const EVERYONE_AUDIENCE = `at://${DID}/${AUD}/3keveryone22`
const PUBLIC_ROOT = `at://${THIRD_DID}/app.bsky.feed.post/3kpubroot222`
const PUBLIC_PARENT = `at://${OTHER_DID}/app.bsky.feed.post/3kpubpar2222`
const FOURTH_DID = 'did:plc:fourthddddddddddddddddddd'
const THIRD_BLOCK = `at://${THIRD_DID}/app.bsky.graph.block/3kblock22222`
const BLOCKED_TEXT = 'You can’t reply to this post.'
const BUSY_TEXT =
  'Couldn’t reach the post you’re replying to. Try again in a moment.'

let appview: ReturnType<typeof fakeClient>
let appviewAnswer: (call: Call) => Reply | Promise<Reply>
let prism: ReturnType<typeof fakeClient>
let served: Record<string, unknown>[]
let pds: ReturnType<typeof fakeClient>
let ownRecords: Record<string, Record<string, unknown>>
let audiences: {uri: string; value: Record<string, unknown>}[]
let writer: PostingWriter & {createAudience: jest.Mock}

function listing(call: Call, values: Record<string, unknown>[]): Reply {
  return {
    status: 200,
    body: {
      records: values.map((value, n) => ({
        uri: `at://${call.params.get('repo')}/${call.params.get('collection')}/3krecord${n}222`,
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

/**
 * A full view of a post (with counts) in some query's data, as a thread
 * screen holds the post being replied to.
 */
function cacheView(
  queryClient: QueryClient,
  uri: string,
  did: string,
  fields: Record<string, unknown> = {},
) {
  queryClient.setQueryData(['test-thread', uri], {
    post: {...servedPost(uri, did, fields), likeCount: 0},
  })
}

beforeEach(() => {
  resetPrismHealth()
  clearPrivateStores()
  mockBlueskyAppview = true
  REPLY_BLOCK_TIMING.callMs = 10_000
  REPLY_BLOCK_TIMING.freshMs = 2_000
  REPLY_BLOCK_TIMING.prePostFreshMs = 10_000
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
  ownRecords = {}
  audiences = [{uri: EVERYONE_AUDIENCE, value: {$type: AUD, mode: 'everyone'}}]
  pds = fakeClient(DID, call => {
    if (call.nsid === 'com.atproto.repo.listRecords') {
      return listing(
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
    queryClient = new QueryClient(),
  }: {
    audience?: ComposeAudience
    skipBlockCheck?: boolean
    queryClient?: QueryClient
  } = {},
): Promise<Plan> {
  return planFirstPost(
    queryClient,
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
    expect(placed.blockCheck).toMatchObject({pairs: [{did: OTHER_DID}]})
  })

  it('prism leaving the parent out, the AppView clear: fails before any write with the placement’s error', async () => {
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

  it('the thread’s owner (the root’s author) blocked, the parent’s author not: reply-blocked (model (c))', async () => {
    const root = privateUri('3kroot222222', THIRD_DID)
    const reply = privateUri('3kreply22222', OTHER_DID)
    const replyFields = {
      reply: {
        root: {uri: root, cid: RECORD_CID},
        parent: {uri: root, cid: RECORD_CID},
      },
    }
    served = [
      servedPost(root, THIRD_DID),
      servedPost(reply, OTHER_DID, replyFields),
    ]
    appviewAnswer = call =>
      relationshipsReply(call, did =>
        did === THIRD_DID ? {blockedBy: THIRD_BLOCK} : {},
      ) ?? {status: 501}

    // Nothing cached: no guess, so the owner is asked once placement names it.
    await expect(plan(reply)).rejects.toBeInstanceOf(PrivateReplyBlockedError)
    expect(relationshipCalls().map(c => c.params.getAll('others'))).toEqual([
      [OTHER_DID],
      [THIRD_DID],
    ])
    expect(writer.createAudience).not.toHaveBeenCalled()

    // The parent's full view cached: the guess rides in the one call.
    appview.calls.length = 0
    const queryClient = new QueryClient()
    cacheView(queryClient, reply, OTHER_DID, replyFields)
    await expect(plan(reply, {queryClient})).rejects.toBeInstanceOf(
      PrivateReplyBlockedError,
    )
    expect(relationshipCalls().map(c => c.params.getAll('others'))).toEqual([
      [OTHER_DID, THIRD_DID],
    ])
    expect(writer.createAudience).not.toHaveBeenCalled()
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
  it('asks the AppView once, reads no PDS listing, and plans when clear', async () => {
    const placed = await plan(PUBLIC_PARENT)
    expect(relationshipCalls().map(c => c.params.getAll('others'))).toEqual([
      [OTHER_DID],
    ])
    expect(
      pds.calls.filter(c => c.nsid === 'com.atproto.repo.listRecords' && c.params.get('collection') !== AUD),
    ).toEqual([])
    expect(placed.blockCheck).toMatchObject({pairs: [{did: OTHER_DID}]})
  })

  it('the AppView failing is cannot check, never "Your server couldn’t save this post", and no audience is created', async () => {
    audiences = []
    appviewAnswer = () => ({status: 500, body: {error: 'InternalServerError'}})
    await expect(plan(PUBLIC_PARENT)).rejects.toBeInstanceOf(
      PrivateReplyCheckError,
    )
    expect(writer.createAudience).not.toHaveBeenCalled()
  })

  it('a block refuses, and no audience is created', async () => {
    audiences = []
    appviewAnswer = call =>
      relationshipsReply(call, {
        blockedBy: `at://${OTHER_DID}/app.bsky.graph.block/3kblock22222`,
      }) ?? {status: 501}
    await expect(plan(PUBLIC_PARENT)).rejects.toBeInstanceOf(
      PrivateReplyBlockedError,
    )
    expect(writer.createAudience).not.toHaveBeenCalled()
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
  const clients = () => ({did: DID, appviewClient: appview.client})

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

  it.each([
    [
      'a list block made during the uploads',
      {blockedByList: `at://${OTHER_DID}/app.bsky.graph.listblock/3kblock22222`},
    ],
    [
      'a block by the member made during the uploads',
      {blocking: `at://${DID}/app.bsky.graph.block/3kblock22222`},
    ],
  ])('%s: the stale recheck refuses', async (_name, fields) => {
    served = [servedPost(PARENT, OTHER_DID)]
    const placed = await plan(PARENT)
    REPLY_BLOCK_TIMING.freshMs = 0
    appviewAnswer = call => relationshipsReply(call, fields) ?? {status: 501}
    await expect(
      recheckReplyBlock(clients(), placed.blockCheck),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)
  })

  it('the AppView failing at the recheck: cannot check', async () => {
    served = [servedPost(PARENT, OTHER_DID)]
    const placed = await plan(PARENT)
    REPLY_BLOCK_TIMING.freshMs = 0
    appviewAnswer = () => ({status: 500, body: {error: 'InternalServerError'}})
    await expect(
      recheckReplyBlock(clients(), placed.blockCheck),
    ).rejects.toBeInstanceOf(PrivateReplyCheckError)
  })

  it('a public parent’s plan is taken again the same way', async () => {
    const placed = await plan(PUBLIC_PARENT)
    REPLY_BLOCK_TIMING.freshMs = 0
    appviewAnswer = call =>
      relationshipsReply(call, {
        blockedBy: `at://${OTHER_DID}/app.bsky.graph.block/3kblock22222`,
      }) ?? {status: 501}
    await expect(
      recheckReplyBlock(clients(), placed.blockCheck),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)
  })
})

describe('the thread’s owner (RB-1, model (c))', () => {
  /** The thread: O's root, A's reply to it (the parent). */
  const ROOT = privateUri('3kroot222222', THIRD_DID)
  const PARENT = privateUri('3kreply22222', OTHER_DID)
  const PARENT_FIELDS = {
    reply: {
      root: {uri: ROOT, cid: RECORD_CID},
      parent: {uri: ROOT, cid: RECORD_CID},
    },
  }

  beforeEach(() => {
    served = [
      servedPost(ROOT, THIRD_DID),
      servedPost(PARENT, OTHER_DID, PARENT_FIELDS),
    ]
  })

  function othersAsked() {
    return relationshipCalls().map(c => c.params.getAll('others'))
  }

  function blockOnly(did: string) {
    appviewAnswer = call =>
      relationshipsReply(call, asked =>
        asked === did
          ? {blockedBy: `at://${did}/app.bsky.graph.block/3kblock22222`}
          : {},
      ) ?? {status: 501}
  }

  /** The parent's full view cached, its root as `rootUri`. */
  function cachedParent(rootUri = ROOT) {
    const queryClient = new QueryClient()
    cacheView(queryClient, PARENT, OTHER_DID, {
      reply: {
        root: {uri: rootUri, cid: RECORD_CID},
        parent: {uri: rootUri, cid: RECORD_CID},
      },
    })
    return queryClient
  }

  it('guess right: one call about the parent’s author and the owner; the owner blocking is reply-blocked, clear plans both pairs', async () => {
    blockOnly(THIRD_DID)
    await expect(
      plan(PARENT, {queryClient: cachedParent()}),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)
    expect(othersAsked()).toEqual([[OTHER_DID, THIRD_DID]])
    expect(writer.createAudience).not.toHaveBeenCalled()

    appview.calls.length = 0
    appviewAnswer = call => relationshipsReply(call) ?? {status: 501}
    const placed = await plan(PARENT, {queryClient: cachedParent()})
    expect(othersAsked()).toEqual([[OTHER_DID, THIRD_DID]])
    expect(placed.blockCheck?.pairs).toEqual([
      {did: OTHER_DID},
      {did: THIRD_DID},
    ])
  })

  it('guess wrong: the guess is asked but never judged, the owner is asked once placement names it', async () => {
    const wrongRoot = privateUri('3kwrongroot2', FOURTH_DID)
    blockOnly(FOURTH_DID)
    const placed = await plan(PARENT, {queryClient: cachedParent(wrongRoot)})
    expect(othersAsked()).toEqual([[OTHER_DID, FOURTH_DID], [THIRD_DID]])
    // A block with someone neither the parent's author nor the owner is soft.
    expect(placed.blockCheck?.pairs).toEqual([
      {did: OTHER_DID},
      {did: THIRD_DID},
    ])
  })

  it('R3: the parent’s author blocked refuses whatever placement did, the guess clear', async () => {
    served = []
    blockOnly(OTHER_DID)
    await expect(
      plan(PARENT, {queryClient: cachedParent()}),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)
    expect(othersAsked()).toEqual([[OTHER_DID, THIRD_DID]])
    expect(writer.createAudience).not.toHaveBeenCalled()
  })

  it('R4 (PR5-L2): placement failing with the guessed owner blocked is reply-blocked; with no guess, the placement’s outcome', async () => {
    blockOnly(THIRD_DID)

    // A healthy omission of the parent.
    served = []
    await expect(
      plan(PARENT, {queryClient: cachedParent()}),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)

    // A transient error from prism.
    prism = fakeClient(DID, () => ({status: 503, body: {error: 'NotReady'}}))
    await expect(
      plan(PARENT, {queryClient: cachedParent()}),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)

    // Nothing cached: no guess, so nothing names the owner.
    served = []
    prism = fakeClient(DID, call =>
      call.nsid === 'app.nearhorizon.private.getPosts'
        ? {status: 200, body: {posts: []}}
        : {status: 200, body: {status: 'indexed'}},
    )
    appview.calls.length = 0
    await expect(plan(PARENT)).rejects.toBeInstanceOf(PrivateParentBusyError)
    expect(othersAsked()).toEqual([[OTHER_DID]])
    expect(writer.createAudience).not.toHaveBeenCalled()
  })

  it.each([
    ['clear', (call: Call) => relationshipsReply(call) as Reply],
    [
      'unknown',
      (call: Call) => ({
        status: 200,
        body: {
          actor: call.params.get('actor'),
          relationships: [
            {$type: 'app.bsky.graph.defs#relationship', did: OTHER_DID},
            {
              $type: 'app.bsky.graph.defs#notFoundActor',
              actor: THIRD_DID,
              notFound: true,
            },
          ],
        },
      }),
    ],
  ] as [string, (call: Call) => Reply][])(
    'R4 inverse: placement failing with the guess %s is the placement’s error',
    async (_name, answer) => {
      served = []
      appviewAnswer = answer
      await expect(
        plan(PARENT, {queryClient: cachedParent()}),
      ).rejects.toBeInstanceOf(PrivateParentBusyError)
    },
  )

  it('the member’s own parent in the owner’s thread: only the owner pair', async () => {
    const own = privateUri('3kownreply22')
    ownRecords['3kownreply22'] = {
      $type: PP,
      text: 'own',
      createdAt: '2026-10-15T12:00:00.000Z',
      audienceList: OTHER_AUDIENCE,
      ...PARENT_FIELDS,
    }
    served = [servedPost(ROOT, THIRD_DID)]

    blockOnly(THIRD_DID)
    await expect(plan(own)).rejects.toBeInstanceOf(PrivateReplyBlockedError)
    expect(othersAsked()).toEqual([[THIRD_DID]])

    appview.calls.length = 0
    appviewAnswer = call => relationshipsReply(call) ?? {status: 501}
    const placed = await plan(own)
    expect(othersAsked()).toEqual([[THIRD_DID]])
    expect(placed.blockCheck?.pairs).toEqual([
      {did: THIRD_DID},
    ])
  })

  it('PR6-N5: the member’s own parent gone from their PDS, the guessed owner blocked: reply-blocked, not parent-unavailable', async () => {
    const own = privateUri('3kownreply22')
    const queryClient = new QueryClient()
    cacheView(queryClient, own, DID, PARENT_FIELDS)
    blockOnly(THIRD_DID)
    await expect(plan(own, {queryClient})).rejects.toBeInstanceOf(
      PrivateReplyBlockedError,
    )
    expect(othersAsked()).toEqual([[THIRD_DID]])
    expect(writer.createAudience).not.toHaveBeenCalled()
  })

  it('the member’s own thread: no pair, no AppView call', async () => {
    const ownRoot = privateUri('3kownroot222')
    const ownReply = privateUri('3kownreply22')
    ownRecords['3kownroot222'] = {
      $type: PP,
      text: 'root',
      createdAt: '2026-10-15T12:00:00.000Z',
      audienceList: EVERYONE_AUDIENCE,
    }
    ownRecords['3kownreply22'] = {
      $type: PP,
      text: 'reply',
      createdAt: '2026-10-15T12:00:00.000Z',
      audienceList: EVERYONE_AUDIENCE,
      reply: {
        root: {uri: ownRoot, cid: RECORD_CID},
        parent: {uri: ownRoot, cid: RECORD_CID},
      },
    }
    appviewAnswer = () => ({status: 500})
    const placed = await plan(ownReply)
    expect(placed.audienceUri).toBe(EVERYONE_AUDIENCE)
    expect(placed.blockCheck).toBeUndefined()
    expect(relationshipCalls()).toEqual([])
  })

  it('a Finish posting: no owner call either', async () => {
    blockOnly(THIRD_DID)
    const skipped = await plan(PARENT, {
      skipBlockCheck: true,
      queryClient: cachedParent(),
    })
    expect(skipped.blockCheck).toBeUndefined()
    expect(relationshipCalls()).toEqual([])
  })
})

describe('readAppviewRelationships', () => {
  it('judges each DID: a notFoundActor is unknown, a relationship judged; a 500 is unknown for all; no DID, no call', async () => {
    appviewAnswer = call => ({
      status: 200,
      body: {
        actor: call.params.get('actor'),
        relationships: [
          {
            $type: 'app.bsky.graph.defs#relationship',
            did: OTHER_DID,
            blocking: `at://${DID}/app.bsky.graph.block/3kblock22222`,
          },
          {
            $type: 'app.bsky.graph.defs#notFoundActor',
            actor: THIRD_DID,
            notFound: true,
          },
        ],
      },
    })
    const judged = await readAppviewRelationships(appview.client, DID, [
      OTHER_DID,
      THIRD_DID,
    ])
    expect(Object.fromEntries(judged)).toEqual({
      [OTHER_DID]: 'blocked',
      [THIRD_DID]: 'unknown',
    })

    appviewAnswer = () => ({status: 500, body: {error: 'InternalServerError'}})
    const failed = await readAppviewRelationships(appview.client, DID, [
      OTHER_DID,
      THIRD_DID,
    ])
    expect(Object.fromEntries(failed)).toEqual({
      [OTHER_DID]: 'unknown',
      [THIRD_DID]: 'unknown',
    })

    const before = relationshipCalls().length
    expect(await readAppviewRelationships(appview.client, DID, [])).toEqual(
      new Map(),
    )
    expect(relationshipCalls()).toHaveLength(before)
  })
})

describe('the re-check reads every pair (R8, R9)', () => {
  const clients = () => ({did: DID, appviewClient: appview.client})
  const pairs: ReplyBlockCheck['pairs'] = [
    {did: OTHER_DID},
    {did: THIRD_DID},
  ]

  it('one AppView call with every pair', async () => {
    REPLY_BLOCK_TIMING.freshMs = 0
    await recheckReplyBlock(clients(), {pairs, checkedAt: 0})
    expect(relationshipCalls().map(c => c.params.getAll('others'))).toEqual([
      [OTHER_DID, THIRD_DID],
    ])
  })

  it.each([
    ['the owner blocks the member', {blockedBy: THIRD_BLOCK}],
    [
      'the owner list-blocks the member',
      {
        blockedByList: `at://${THIRD_DID}/app.bsky.graph.listblock/3kblock22222`,
      },
    ],
  ])('%s since the plan: the owner pair is read, reply-blocked', async (_name, fields) => {
    REPLY_BLOCK_TIMING.freshMs = 0
    appviewAnswer = call =>
      relationshipsReply(call, did => (did === THIRD_DID ? fields : {})) ?? {
        status: 501,
      }
    await expect(
      recheckReplyBlock(clients(), {pairs, checkedAt: 0}),
    ).rejects.toBeInstanceOf(PrivateReplyBlockedError)
  })

  it('no relationship for the owner at the re-check: cannot check', async () => {
    REPLY_BLOCK_TIMING.freshMs = 0
    appviewAnswer = call => ({
      status: 200,
      body: {
        actor: call.params.get('actor'),
        relationships: [
          {$type: 'app.bsky.graph.defs#relationship', did: OTHER_DID},
        ],
      },
    })
    await expect(
      recheckReplyBlock(clients(), {pairs, checkedAt: 0}),
    ).rejects.toBeInstanceOf(PrivateReplyCheckError)
  })

  it('returns the check it holds: the same one when fresh, a new one when it read, and force reads although fresh', async () => {
    const fresh: ReplyBlockCheck = {pairs, checkedAt: Date.now()}
    expect(await recheckReplyBlock(clients(), fresh)).toBe(fresh)
    expect(relationshipCalls()).toEqual([])

    const stale: ReplyBlockCheck = {pairs, checkedAt: 0}
    const start = Date.now()
    const taken = await recheckReplyBlock(clients(), stale)
    expect(taken).not.toBe(stale)
    expect(taken?.pairs).toBe(pairs)
    expect(taken?.checkedAt).toBeGreaterThanOrEqual(start)
    expect(relationshipCalls()).toHaveLength(1)

    const forced = await recheckReplyBlock(clients(), fresh, {force: true})
    expect(forced).not.toBe(fresh)
    expect(relationshipCalls()).toHaveLength(2)
  })
})
