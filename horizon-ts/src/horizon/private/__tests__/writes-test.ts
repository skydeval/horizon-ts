import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

const mockResolveSpoilerRT = jest.fn(
  (_client: unknown, richtext: {text: string}, _mode: string) =>
    Promise.resolve({text: richtext.text, facets: undefined}),
)
jest.mock('#/horizon/spoilers/write', () => ({
  ...jest.requireActual<object>('#/horizon/spoilers/write'),
  resolveSpoilerRT: (...args: [unknown, {text: string}, string]) =>
    mockResolveSpoilerRT(...args),
}))
const mockResolveEmbed = jest.fn(() => Promise.resolve(undefined))
const mockResolveReply = jest.fn()
jest.mock('#/lib/api/index', () => ({
  resolveEmbed: () => mockResolveEmbed(),
  resolveReply: (...args: unknown[]) => mockResolveReply(...args),
}))
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))
jest.mock('#/state/queries/profile', () => ({
  RQKEY: (did: string) => ['profile', did],
}))
jest.mock('#/state/queries/resolve-link', () => ({
  RQKEY_LINK: (url: string) => ['resolve-link', url],
}))
let mockPrismClient: unknown
jest.mock('#/horizon/routing/prism', () => ({
  getPrismClient: () => mockPrismClient,
}))

import {TID} from '@atproto/common-web'
import {type Client} from '@atproto/lex'
import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {computeCid} from '#/lib/api/computeCid'
import {type PostOpts} from '#/lib/api/index'
import {logger} from '#/logger'
import {type ThreadDraft} from '#/view/com/composer/state/composer'
import {
  EMPTY_COMPOSE_SPOILERS,
  replaceComposeSpoilers,
} from '#/horizon/media-spoilers/compose-store'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {repoRouteForDid, resetWriteRoutes} from '#/horizon/routing/write-route'
import {clockIdFor} from '#/horizon/tid-clock'
import {
  PrivateAudienceMissingError,
  PrivateAudienceUnpickedError,
} from '../api/audiences'
import {
  PrivateReplyBlockedError,
  PrivateReplyCheckError,
  REPLY_BLOCK_TIMING,
} from '../api/reply-block'
import {PrivateRouteUnavailableError} from '../api/writer'
import {
  deletePrivatePost,
  postPrivate,
  PrivateGatesNotSavedError,
  PrivateParentBusyError,
  PrivateParentUnavailableError,
  PrivateReplyRefusedError,
  PrivateThreadPartlyPostedError,
  stopPrivateConfirmations,
} from '../api/writes'
import {PUBLIC_COMPOSE, setComposeVisibility} from '../composer/state'
import {clearPrivateStores, getPendingBatch, getPendingPost} from '../store'
import {
  AUDIENCE,
  blob,
  type Call,
  DID,
  fakeClient,
  OTHER_AUDIENCE,
  OTHER_DID,
  privateUri,
  relationshipsReply,
  type Reply,
} from './fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

const PP = 'tools.kryphocron.feed.postPrivate'
const AUD = 'tools.kryphocron.policy.audience'
const EVERYONE_AUDIENCE = `at://${DID}/${AUD}/3keveryone22`
const COMMIT_CID = 'commit-cid-is-not-the-record-cid'

let recordCids: string[] = []

beforeAll(async () => {
  recordCids = await Promise.all(
    [1, 2, 3, 4, 5, 6].map(n => computeCid({n} as never)),
  )
})

type Stored = {record: Record<string, unknown>; cid: string}

/**
 * A fake aurora: the account's repo of private posts and audiences, with
 * hooks to fail a step.
 */
function fakePds() {
  const repo = new Map<string, Stored>()
  let created = 0
  const audiences: {uri: string; value: Record<string, unknown>}[] = [
    {uri: EVERYONE_AUDIENCE, value: {$type: AUD, mode: 'everyone'}},
  ]
  const failures: {
    create?: (
      call: Call,
      index: number,
    ) => Reply | 'store-then-fail' | undefined
    getRecordAfterCreate?: (rkey: string) => Reply | undefined
    delete?: (rkey: string) => Reply | undefined
    manageAudience?: Reply
    gateCreate?: (index: number) => Reply | undefined
    gateDelete?: (key: string) => Reply | undefined
    /** Holds each gate `createRecord` until it resolves. */
    gateHold?: () => Promise<void>
  } = {}
  /** Gate records by `<collection>/<rkey>`. */
  const gates = new Map<string, Record<string, unknown>>()
  let gatesCreated = 0

  const handler = (call: Call): Reply => {
    switch (call.nsid) {
      case 'tools.kryphocron.feed.createPostPrivate':
      case 'tools.kryphocron.actor.participatePrivate': {
        const index = created++
        const rkey = call.body?.rkey as string
        const failure = failures.create?.(call, index)
        const stored = {
          record: call.body?.record as Record<string, unknown>,
          cid: recordCids[index],
        }
        if (failure === 'store-then-fail') {
          repo.set(rkey, stored)
          return {status: 500, body: {error: 'InternalServerError'}}
        }
        if (failure) return failure
        repo.set(rkey, stored)
        return {status: 200, body: {uri: privateUri(rkey), cid: COMMIT_CID}}
      }
      case 'com.atproto.repo.getRecord': {
        const rkey = call.params.get('rkey') ?? ''
        const failure = failures.getRecordAfterCreate?.(rkey)
        if (failure) return failure
        const stored = repo.get(rkey)
        if (!stored) {
          return {
            status: 400,
            body: {error: 'RecordNotFound', message: 'Could not locate record'},
          }
        }
        return {
          status: 200,
          body: {uri: privateUri(rkey), cid: stored.cid, value: stored.record},
        }
      }
      case 'tools.kryphocron.feed.deletePostPrivate': {
        const rkey = call.body?.rkey as string
        const failure = failures.delete?.(rkey)
        if (failure) return failure
        repo.delete(rkey)
        return {status: 200, body: {}}
      }
      case 'com.atproto.repo.createRecord': {
        const failure = failures.gateCreate?.(gatesCreated++)
        if (failure) return failure
        const key = `${call.body?.collection as string}/${call.body?.rkey as string}`
        gates.set(key, call.body?.record as Record<string, unknown>)
        return {
          status: 200,
          body: {uri: `at://${DID}/${key}`, cid: recordCids[5]},
        }
      }
      case 'com.atproto.repo.deleteRecord': {
        const key = `${call.body?.collection as string}/${call.body?.rkey as string}`
        const failure = failures.gateDelete?.(key)
        if (failure) return failure
        gates.delete(key)
        // A stock PDS deletes a private post as any record (2K 4.4).
        if (call.body?.collection === PP) repo.delete(call.body?.rkey as string)
        return {status: 200, body: {}}
      }
      case 'com.atproto.repo.listRecords':
        return {
          status: 200,
          body: {
            records: audiences.map(a => ({
              uri: a.uri,
              cid: recordCids[5],
              value: a.value,
            })),
          },
        }
      case 'tools.kryphocron.policy.manageAudience':
        if (failures.manageAudience) return failures.manageAudience
        return {
          status: 200,
          body: {uri: `at://${DID}/${AUD}/3kcreated22`, cid: COMMIT_CID},
        }
      default:
        return {status: 501, body: {error: 'MethodNotImplemented'}}
    }
  }
  const {client, calls} = fakeClient(DID, call =>
    call.nsid === 'com.atproto.repo.createRecord' && failures.gateHold
      ? failures.gateHold().then(() => handler(call))
      : handler(call),
  )
  return {client, calls, repo, audiences, failures, gates}
}

let prismHandler: (call: Call) => Reply
let pds: ReturnType<typeof fakePds>
let prism: ReturnType<typeof fakeClient>
let appview: Client
/** The AppView's answer to anything but `getRelationships`. */
let appviewHandler: (call: Call) => Reply

function draft(text: string) {
  return {
    id: text,
    richtext: {text},
    labels: [],
    embed: {quote: undefined, media: undefined, link: undefined},
    shortenedGraphemeLength: text.length,
  }
}

function opts(
  texts: string[],
  replyTo?: string,
  limits: {threadgate?: unknown[]; postgate?: Record<string, unknown>} = {},
): PostOpts {
  return {
    thread: {
      posts: texts.map(draft),
      postgate: limits.postgate ?? {},
      threadgate: limits.threadgate ?? [{type: 'everybody'}],
    } as unknown as ThreadDraft,
    replyTo,
    appviewClient: appview,
    chatClient: appview,
    pdsClient: pds.client,
  }
}

function nsids(calls: Call[]) {
  return calls.map(call => call.nsid)
}

/** Publish the account's clients with its PDS at `pdsUrl`. */
function publishPds(pdsUrl: string) {
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl,
    pdsClient: pds.client,
    prismClient: prism.client,
    appviewClient: appview,
  })
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

type ServedPost = {
  uri: string
  cid: string
  author: {did: string; handle: string}
  record: Record<string, unknown>
  indexedAt: string
  labels: never[]
}

/**
 * A private post as prism serves it.
 */
function served(
  uri: string,
  did: string,
  cid: string,
  fields: Record<string, unknown>,
): ServedPost {
  return {
    uri,
    cid,
    author: {did, handle: did === DID ? 'alice.test' : 'bob.test'},
    record: {
      $type: PP,
      text: 'post',
      createdAt: '2026-10-15T12:00:00.000Z',
      ...fields,
    },
    indexedAt: '2026-10-15T12:00:00.000Z',
    labels: [],
  }
}

/**
 * A fake prism serving exactly `posts` by URI.
 */
function servePrism(posts: ServedPost[]) {
  const byUri = new Map(posts.map(post => [post.uri, post]))
  prism = fakeClient(DID, call => {
    if (call.nsid === 'app.nearhorizon.private.getPosts') {
      const found = call.params
        .getAll('uris')
        .map(uri => byUri.get(uri))
        .filter(post => !!post)
      return {status: 200, body: {posts: found}}
    }
    return {status: 200, body: {status: 'indexed'}}
  })
  mockPrismClient = prism.client
}

beforeEach(() => {
  pds = fakePds()
  prismHandler = () => ({status: 200, body: {status: 'indexed'}})
  prism = fakeClient(DID, call =>
    call.nsid === 'app.nearhorizon.private.getPosts'
      ? {status: 200, body: {posts: []}}
      : prismHandler(call),
  )
  mockPrismClient = prism.client
  appviewHandler = call => relationshipsReply(call) ?? {status: 500, body: {}}
  appview = fakeClient(DID, call => appviewHandler(call)).client
  REPLY_BLOCK_TIMING.freshMs = 2_000
  REPLY_BLOCK_TIMING.prePostFreshMs = 10_000
  // The jest setup's locus origin: the locus writers (2K T-12).
  publishPds('https://pds.example')
  resetWriteRoutes()
  clearPrivateStores()
  setComposeVisibility({
    visibility: 'private',
    audience: {kind: 'mode', mode: 'everyone'},
    locked: false,
  })
  mockResolveReply.mockReset()
  mockResolveSpoilerRT.mockClear()
  resetPrismFeatures()
  resetPrismHealth()
})

afterEach(() => {
  stopPrivateConfirmations()
  setComposeVisibility(PUBLIC_COMPOSE)
})

describe('postPrivate', () => {
  it('writes spoilers with their markers until prism serves facets, then strips them', async () => {
    await postPrivate(new QueryClient(), opts(['a ||b|| c']))
    expect(mockResolveSpoilerRT).toHaveBeenCalledTimes(1)
    expect(mockResolveSpoilerRT.mock.calls[0][2]).toBe('keep')
    answerPrismFeatures(DID, ['private', 'private.embeds'])
    await postPrivate(new QueryClient(), opts(['a ||b|| c']))
    expect(mockResolveSpoilerRT.mock.calls[1][2]).toBe('strip')
  })

  it('reads the posts at once when prism caught up with the last one (5.7, T8)', async () => {
    prismHandler = () => ({
      status: 200,
      body: {status: 'indexed', caughtUp: true},
    })
    await postPrivate(new QueryClient(), opts(['hello']))
    await settle()
    // Before the first scheduled confirmation (1 s).
    expect(prism.calls.map(call => call.nsid)).toEqual([
      'app.nearhorizon.index.requestRecord',
      'app.nearhorizon.private.getPosts',
    ])
  })

  it('without caughtUp the confirmation waits for the schedule', async () => {
    await postPrivate(new QueryClient(), opts(['hello']))
    await settle()
    expect(prism.calls.map(call => call.nsid)).toEqual([
      'app.nearhorizon.index.requestRecord',
    ])
  })

  it('writes a top-level post through createPostPrivate, then getRecord, then requestRecord', async () => {
    const queryClient = new QueryClient()
    const {uris} = await postPrivate(queryClient, opts(['hello']))
    await settle()

    expect(nsids(pds.calls)).toEqual([
      'com.atproto.repo.listRecords',
      'tools.kryphocron.feed.createPostPrivate',
      'com.atproto.repo.getRecord',
    ])
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.applyWrites')
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.createRecord')

    const create = pds.calls[1]
    const rkey = create.body?.rkey as string
    expect(rkey).toMatch(/^[a-z2-7]{13}$/)
    expect(uris).toEqual([privateUri(rkey)])
    expect(create.body?.repo).toBe(DID)
    const record = create.body?.record as Record<string, unknown>
    expect(record.$type).toBe(PP)
    expect(record.text).toBe('hello')
    expect(record.audienceList).toBe(EVERYONE_AUDIENCE)
    expect(record.langs).toBeUndefined()
    expect(pds.calls[2].params.get('rkey')).toBe(rkey)
    expect(pds.calls[2].params.get('collection')).toBe(PP)

    expect(nsids(prism.calls)).toContain('app.nearhorizon.index.requestRecord')
    expect(
      prism.calls.find(c => c.nsid === 'app.nearhorizon.index.requestRecord')
        ?.body?.uri,
    ).toBe(uris[0])

    const pending = getPendingPost(uris[0])
    expect(pending?.cid).toBe(recordCids[0])
    expect(pending?.postView.record.$type).toBe('app.bsky.feed.post')
    expect(getPendingBatch(uris[0]).map(p => p.uri)).toEqual(uris)
  })

  it('post 2 replies to post 1 with the CID from getRecord, not the procedure’s', async () => {
    const {uris} = await postPrivate(new QueryClient(), opts(['one', 'two']))
    const creates = pds.calls.filter(
      c => c.nsid === 'tools.kryphocron.feed.createPostPrivate',
    )
    expect(creates).toHaveLength(2)
    const second = creates[1].body?.record as {
      reply: {
        root: {uri: string; cid: string}
        parent: {uri: string; cid: string}
      }
    }
    expect(second.reply.parent).toEqual({uri: uris[0], cid: recordCids[0]})
    expect(second.reply.root).toEqual({uri: uris[0], cid: recordCids[0]})
    expect(second.reply.parent.cid).not.toBe(COMMIT_CID)
  })

  it('a reply in another account’s thread participates with the root’s audience and root', async () => {
    const parentUri = privateUri('3kparent2222', OTHER_DID)
    const rootUri = privateUri('3kroot222222', OTHER_DID)
    servePrism([
      served(parentUri, OTHER_DID, recordCids[3], {
        audienceList: OTHER_AUDIENCE,
        reply: {
          root: {uri: rootUri, cid: recordCids[4]},
          parent: {uri: rootUri, cid: recordCids[4]},
        },
      }),
      served(rootUri, OTHER_DID, recordCids[4], {
        audienceList: OTHER_AUDIENCE,
      }),
    ])
    // The composer says Public; a private parent routes private anyway.
    setComposeVisibility(PUBLIC_COMPOSE)

    await postPrivate(new QueryClient(), opts(['reply'], parentUri))
    const participate = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.actor.participatePrivate',
    )
    expect(participate).toBeDefined()
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.feed.createPostPrivate',
    )
    const record = participate?.body?.record as {
      audienceList: string
      reply: {root: unknown; parent: unknown}
    }
    expect(record.audienceList).toBe(OTHER_AUDIENCE)
    expect(record.reply.root).toEqual({uri: rootUri, cid: recordCids[4]})
    expect(record.reply.parent).toEqual({uri: parentUri, cid: recordCids[3]})
    // No audience was looked up or created for a reply.
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.listRecords')
  })

  it('a reply to the author’s own pending post takes the parent from the pending store', async () => {
    const first = await postPrivate(new QueryClient(), opts(['first']))
    prism.calls.length = 0
    await postPrivate(new QueryClient(), opts(['second'], first.uris[0]))
    expect(nsids(prism.calls)).not.toContain('app.nearhorizon.private.getPosts')
    const creates = pds.calls.filter(
      c => c.nsid === 'tools.kryphocron.feed.createPostPrivate',
    )
    const record = creates[1].body?.record as {
      audienceList: string
      reply: {parent: {uri: string; cid: string}}
    }
    expect(record.reply.parent).toEqual({
      uri: first.uris[0],
      cid: recordCids[0],
    })
    expect(record.audienceList).toBe(EVERYONE_AUDIENCE)
  })

  it('a failure at post 2 deletes post 1 and throws', async () => {
    pds.failures.create = (_call, index) =>
      index === 1
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    await expect(
      postPrivate(new QueryClient(), opts(['one', 'two'])),
    ).rejects.toBeDefined()
    const deletes = pds.calls.filter(
      c => c.nsid === 'tools.kryphocron.feed.deletePostPrivate',
    )
    const firstRkey = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.feed.createPostPrivate',
    )?.body?.rkey
    expect(deletes.map(d => d.body?.rkey)).toEqual([firstRkey])
    expect(pds.repo.size).toBe(0)
  })

  it('a create error whose record getRecord then finds is deleted too (k = 1)', async () => {
    pds.failures.create = (_call, index) =>
      index === 0 ? 'store-then-fail' : undefined
    await expect(
      postPrivate(new QueryClient(), opts(['one'])),
    ).rejects.toBeDefined()
    expect(nsids(pds.calls)).toContain(
      'tools.kryphocron.feed.deletePostPrivate',
    )
    expect(pds.repo.size).toBe(0)
  })

  it('a create error at post 2 whose record was stored deletes post 2 and post 1, newest first', async () => {
    pds.failures.create = (_call, index) =>
      index === 1 ? 'store-then-fail' : undefined
    await expect(
      postPrivate(new QueryClient(), opts(['one', 'two'])),
    ).rejects.toBeDefined()
    const creates = pds.calls
      .filter(c => c.nsid === 'tools.kryphocron.feed.createPostPrivate')
      .map(c => c.body?.rkey)
    const deletes = pds.calls
      .filter(c => c.nsid === 'tools.kryphocron.feed.deletePostPrivate')
      .map(c => c.body?.rkey)
    expect(deletes).toEqual([creates[1], creates[0]])
    expect(pds.repo.size).toBe(0)
  })

  it('a create error with RecordNotFound afterwards deletes nothing', async () => {
    pds.failures.create = () => ({
      status: 500,
      body: {error: 'InternalServerError'},
    })
    await expect(
      postPrivate(new QueryClient(), opts(['one'])),
    ).rejects.toBeDefined()
    expect(nsids(pds.calls)).toContain('com.atproto.repo.getRecord')
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.feed.deletePostPrivate',
    )
  })

  it('names what may remain when a rollback delete fails', async () => {
    pds.failures.create = (_call, index) =>
      index === 1
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    pds.failures.delete = () => ({status: 500, body: {error: 'Oops'}})
    await expect(
      postPrivate(new QueryClient(), opts(['one', 'two'])),
    ).rejects.toBeInstanceOf(PrivateThreadPartlyPostedError)
  })

  it('a failed requestRecord does not fail the write', async () => {
    prismHandler = () => ({status: 429, body: {error: 'RateLimitExceeded'}})
    const {uris} = await postPrivate(new QueryClient(), opts(['hello']))
    await settle()
    expect(uris).toHaveLength(1)
  })

  it('an audience creation failure throws before any post write', async () => {
    pds.audiences.length = 0
    pds.failures.manageAudience = {status: 500, body: {error: 'Oops'}}
    await expect(
      postPrivate(new QueryClient(), opts(['hello'])),
    ).rejects.toBeDefined()
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.feed.createPostPrivate',
    )
  })

  it('a list audience missing from the account’s list is refused before any write', async () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'list', uri: `at://${DID}/${AUD}/3kgone222222`},
      locked: false,
    })
    await expect(
      postPrivate(new QueryClient(), opts(['hello'])),
    ).rejects.toBeInstanceOf(PrivateAudienceMissingError)
    // Checked against the cached list, then refetched once.
    expect(
      nsids(pds.calls).filter(n => n === 'com.atproto.repo.listRecords'),
    ).toHaveLength(2)
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.feed.createPostPrivate',
    )
  })

  it('maps aurora’s audience denial to the reply refusal text', async () => {
    const parentUri = privateUri('3kparent2222', OTHER_DID)
    servePrism([
      served(parentUri, OTHER_DID, recordCids[3], {
        audienceList: OTHER_AUDIENCE,
      }),
    ])
    pds.failures.create = () => ({
      status: 403,
      body: {
        error: 'AuthorizationError',
        message: 'Not authorized: Audience check denied',
      },
    })
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], parentUri),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyRefusedError)
    expect((error as Error).message).toBe(
      'You can’t reply in this conversation. You may not be among the people who can see it.',
    )
  })
})

describe('postPrivate: where a reply goes (A-12, A-13)', () => {
  const PUBLIC_ROOT = `at://${OTHER_DID}/app.bsky.feed.post/3kpubroot222`
  const PUBLIC_PARENT = `at://${OTHER_DID}/app.bsky.feed.post/3kpubpar2222`
  const NEW_OTHER = `at://${OTHER_DID}/${AUD}/3knewlist222`
  const NEW_OWN = `at://${DID}/${AUD}/3knewown2222`
  const ONLY_ME = `at://${DID}/${AUD}/3konlyme2222`

  function publicRef(uri: string, cid: string) {
    return {uri, cid}
  }

  /** The one post write of the compose: its procedure and record. */
  function written() {
    const call = pds.calls.find(
      c =>
        c.nsid === 'tools.kryphocron.feed.createPostPrivate' ||
        c.nsid === 'tools.kryphocron.actor.participatePrivate',
    )
    return {
      nsid: call?.nsid,
      record: call?.body?.record as
        | {
            audienceList: string
            reply: {
              root: {uri: string; cid: string}
              parent: {uri: string; cid: string}
            }
          }
        | undefined,
    }
  }

  function postWrites() {
    return nsids(pds.calls).filter(
      n =>
        n === 'tools.kryphocron.feed.createPostPrivate' ||
        n === 'tools.kryphocron.actor.participatePrivate',
    )
  }

  /** The writer's own record, as their PDS stores it. */
  function storeOwn(
    rkey: string,
    cid: string,
    fields: Record<string, unknown>,
  ) {
    pds.repo.set(rkey, {
      cid,
      record: {
        $type: PP,
        text: 'own',
        createdAt: '2026-10-15T12:00:00.000Z',
        ...fields,
      },
    })
  }

  it('a reply to an older reply after a move names the root’s current audience, not the parent’s', async () => {
    const rootUri = privateUri('3kroot222222', OTHER_DID)
    const olderUri = privateUri('3kolder22222', OTHER_DID)
    servePrism([
      served(rootUri, OTHER_DID, recordCids[4], {audienceList: NEW_OTHER}),
      served(olderUri, OTHER_DID, recordCids[3], {
        audienceList: OTHER_AUDIENCE,
        reply: {
          root: {uri: rootUri, cid: recordCids[2]},
          parent: {uri: rootUri, cid: recordCids[2]},
        },
      }),
    ])
    await postPrivate(new QueryClient(), opts(['reply'], olderUri))
    const {nsid, record} = written()
    expect(nsid).toBe('tools.kryphocron.actor.participatePrivate')
    expect(record?.audienceList).toBe(NEW_OTHER)
    // The root ref is the parent's, as stock copies it.
    expect(record?.reply.root).toEqual({uri: rootUri, cid: recordCids[2]})
    expect(record?.reply.parent).toEqual({uri: olderUri, cid: recordCids[3]})
  })

  it('a reply in the writer’s own thread reads the root’s audience from the writer’s PDS and uses createPostPrivate', async () => {
    const rootUri = privateUri('3kownroot222')
    const parentUri = privateUri('3kparent2222', OTHER_DID)
    // prism still serves the root's audience from before the move.
    servePrism([
      served(rootUri, DID, recordCids[4], {audienceList: AUDIENCE}),
      served(parentUri, OTHER_DID, recordCids[3], {
        audienceList: AUDIENCE,
        reply: {
          root: {uri: rootUri, cid: recordCids[4]},
          parent: {uri: rootUri, cid: recordCids[4]},
        },
      }),
    ])
    storeOwn('3kownroot222', recordCids[4], {audienceList: NEW_OWN})
    await postPrivate(new QueryClient(), opts(['reply'], parentUri))
    const {nsid, record} = written()
    expect(nsid).toBe('tools.kryphocron.feed.createPostPrivate')
    expect(record?.audienceList).toBe(NEW_OWN)
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.listRecords')
  })

  it('a private reply to a public post is a branch root: the composer’s audience, createPostPrivate and the stock reply refs', async () => {
    mockResolveReply.mockImplementation(() =>
      Promise.resolve({
        root: publicRef(PUBLIC_ROOT, recordCids[4]),
        parent: publicRef(PUBLIC_PARENT, recordCids[3]),
      }),
    )
    await postPrivate(new QueryClient(), opts(['branch'], PUBLIC_PARENT))
    expect(mockResolveReply).toHaveBeenCalledWith(appview, PUBLIC_PARENT)
    const {nsid, record} = written()
    expect(nsid).toBe('tools.kryphocron.feed.createPostPrivate')
    expect(record?.audienceList).toBe(EVERYONE_AUDIENCE)
    expect(record?.reply.root).toEqual({uri: PUBLIC_ROOT, cid: recordCids[4]})
    expect(record?.reply.parent).toEqual({
      uri: PUBLIC_PARENT,
      cid: recordCids[3],
    })
    expect(nsids(prism.calls)).not.toContain('app.nearhorizon.private.getPosts')
  })

  it('a reply inside the writer’s own branch walks to the branch root and uses createPostPrivate', async () => {
    const branchUri = privateUri('3kbranch2222')
    const middleUri = privateUri('3kmiddle2222', OTHER_DID)
    const branchReply = {
      root: publicRef(PUBLIC_ROOT, recordCids[4]),
      parent: publicRef(PUBLIC_PARENT, recordCids[4]),
    }
    servePrism([
      served(branchUri, DID, recordCids[2], {
        audienceList: AUDIENCE,
        reply: branchReply,
      }),
      served(middleUri, OTHER_DID, recordCids[3], {
        audienceList: AUDIENCE,
        reply: {
          root: publicRef(PUBLIC_ROOT, recordCids[4]),
          parent: {uri: branchUri, cid: recordCids[2]},
        },
      }),
    ])
    storeOwn('3kbranch2222', recordCids[2], {
      audienceList: NEW_OWN,
      reply: branchReply,
    })
    await postPrivate(new QueryClient(), opts(['reply'], middleUri))
    const {nsid, record} = written()
    expect(nsid).toBe('tools.kryphocron.feed.createPostPrivate')
    expect(record?.audienceList).toBe(NEW_OWN)
    expect(record?.reply.root).toEqual({uri: PUBLIC_ROOT, cid: recordCids[4]})
    expect(record?.reply.parent).toEqual({uri: middleUri, cid: recordCids[3]})
    expect(mockResolveReply).not.toHaveBeenCalled()
  })

  it('a reply inside another account’s branch participates with the branch root’s current audience', async () => {
    const branchUri = privateUri('3kbranch2222', OTHER_DID)
    const firstUri = privateUri('3kfirst22222')
    const secondUri = privateUri('3ksecond2222', OTHER_DID)
    servePrism([
      served(branchUri, OTHER_DID, recordCids[2], {
        audienceList: NEW_OTHER,
        reply: {
          root: publicRef(PUBLIC_ROOT, recordCids[4]),
          parent: publicRef(PUBLIC_PARENT, recordCids[4]),
        },
      }),
      served(firstUri, DID, recordCids[3], {
        audienceList: OTHER_AUDIENCE,
        reply: {
          root: publicRef(PUBLIC_ROOT, recordCids[4]),
          parent: {uri: branchUri, cid: recordCids[2]},
        },
      }),
      served(secondUri, OTHER_DID, recordCids[5], {
        audienceList: OTHER_AUDIENCE,
        reply: {
          root: publicRef(PUBLIC_ROOT, recordCids[4]),
          parent: {uri: firstUri, cid: recordCids[3]},
        },
      }),
    ])
    // The writer's own hop is read from their PDS (busy design 9, BR15-N8).
    storeOwn('3kfirst22222', recordCids[3], {
      audienceList: OTHER_AUDIENCE,
      reply: {
        root: publicRef(PUBLIC_ROOT, recordCids[4]),
        parent: {uri: branchUri, cid: recordCids[2]},
      },
    })
    await postPrivate(new QueryClient(), opts(['reply'], secondUri))
    const {nsid, record} = written()
    expect(nsid).toBe('tools.kryphocron.actor.participatePrivate')
    expect(record?.audienceList).toBe(NEW_OTHER)
    expect(record?.reply.root).toEqual({uri: PUBLIC_ROOT, cid: recordCids[4]})
    // Only the writer's own record was read from a PDS.
    const reads = pds.calls.filter(c => c.nsid === 'com.atproto.repo.getRecord')
    expect(reads.map(c => c.params.get('repo'))).toEqual(reads.map(() => DID))
  })

  it('the writer’s own branch hop gone from their PDS is parent-unavailable, never reply-refused (BR18-N3)', async () => {
    const branchUri = privateUri('3kbranch3333', OTHER_DID)
    const firstUri = privateUri('3kfirst33333')
    const secondUri = privateUri('3ksecond3333', OTHER_DID)
    servePrism([
      served(branchUri, OTHER_DID, recordCids[2], {
        audienceList: NEW_OTHER,
        reply: {
          root: publicRef(PUBLIC_ROOT, recordCids[4]),
          parent: publicRef(PUBLIC_PARENT, recordCids[4]),
        },
      }),
      served(secondUri, OTHER_DID, recordCids[5], {
        audienceList: OTHER_AUDIENCE,
        reply: {
          root: publicRef(PUBLIC_ROOT, recordCids[4]),
          parent: {uri: firstUri, cid: recordCids[3]},
        },
      }),
    ])
    await expect(
      postPrivate(new QueryClient(), opts(['reply'], secondUri)),
    ).rejects.toBeInstanceOf(PrivateParentUnavailableError)
    expect(postWrites()).toEqual([])
  })

  it('a reply to the writer’s own Only me post names that audience, with nothing found or created', async () => {
    const rootUri = privateUri('3konlyroot22')
    servePrism([served(rootUri, DID, recordCids[4], {audienceList: ONLY_ME})])
    storeOwn('3konlyroot22', recordCids[4], {audienceList: ONLY_ME})
    await postPrivate(new QueryClient(), opts(['note to self'], rootUri))
    const {nsid, record} = written()
    expect(nsid).toBe('tools.kryphocron.feed.createPostPrivate')
    expect(record?.audienceList).toBe(ONLY_ME)
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.listRecords')
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.policy.manageAudience',
    )
  })

  it('an anchor that names no audience is refused before any write', async () => {
    const rootUri = privateUri('3knoaudience')
    servePrism([served(rootUri, DID, recordCids[4], {})])
    storeOwn('3knoaudience', recordCids[4], {})
    await expect(
      postPrivate(new QueryClient(), opts(['reply'], rootUri)),
    ).rejects.toBeInstanceOf(PrivateReplyRefusedError)
    expect(postWrites()).toEqual([])
  })

  it('a branch whose root prism leaves out fails before any write with parent-busy’s text, which the composer shows (busy design 9, BR18-L1)', async () => {
    const middleUri = privateUri('3kmiddle2222', OTHER_DID)
    servePrism([
      served(middleUri, OTHER_DID, recordCids[3], {
        audienceList: OTHER_AUDIENCE,
        reply: {
          root: publicRef(PUBLIC_ROOT, recordCids[4]),
          parent: {
            uri: privateUri('3kgone222222', OTHER_DID),
            cid: recordCids[2],
          },
        },
      }),
    ])
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], middleUri),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateParentBusyError)
    expect((error as Error).message).toBe(
      'Couldn’t reach the post you’re replying to. Try again in a moment.',
    )
    expect(postWrites()).toEqual([])
    // No read of another author's records on any PDS.
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.getRecord')
  })

  it('another author’s parent left out of a healthy answer shows parent-busy’s text; a transient planning error stays raw (BR18-L1)', async () => {
    const parentUri = privateUri('3kleftout222', OTHER_DID)
    servePrism([])
    const missed = await postPrivate(
      new QueryClient(),
      opts(['reply'], parentUri),
    ).catch((e: unknown) => e)
    expect(missed).toBeInstanceOf(PrivateParentBusyError)
    expect((missed as Error).message).toBe(
      'Couldn’t reach the post you’re replying to. Try again in a moment.',
    )

    prism = fakeClient(DID, () => ({
      status: 503,
      body: {error: 'Reindexing', retryAfter: 30},
    }))
    mockPrismClient = prism.client
    publishPds('https://pds.example')
    const raw = await postPrivate(
      new QueryClient(),
      opts(['reply'], parentUri),
    ).catch((e: unknown) => e)
    expect(raw).not.toBeInstanceOf(PrivateParentBusyError)
    expect((raw as {error?: string}).error).toBe('Reindexing')
    expect(postWrites()).toEqual([])
  })

  it('the writer’s own anchor gone from their PDS is parent-unavailable, never reply-refused (BQ-9, BR17-N2)', async () => {
    const rootUri = privateUri('3kownroot333')
    const parentUri = privateUri('3kparent3333', OTHER_DID)
    servePrism([
      served(rootUri, DID, recordCids[4], {audienceList: AUDIENCE}),
      served(parentUri, OTHER_DID, recordCids[3], {
        audienceList: AUDIENCE,
        reply: {
          root: {uri: rootUri, cid: recordCids[4]},
          parent: {uri: rootUri, cid: recordCids[4]},
        },
      }),
    ])
    await expect(
      postPrivate(new QueryClient(), opts(['reply'], parentUri)),
    ).rejects.toBeInstanceOf(PrivateParentUnavailableError)
    expect(postWrites()).toEqual([])
  })

  it('the writer’s own parent is placed from their PDS; gone there, it is parent-unavailable (busy design 9)', async () => {
    const ownUri = privateUri('3kownpar2222')
    servePrism([])
    storeOwn('3kownpar2222', recordCids[4], {audienceList: AUDIENCE})
    await postPrivate(new QueryClient(), opts(['reply'], ownUri))
    expect(written().record?.reply.parent).toEqual({
      uri: ownUri,
      cid: recordCids[4],
    })
    expect(nsids(prism.calls)).not.toContain('app.nearhorizon.private.getPosts')

    pds.calls.length = 0
    await expect(
      postPrivate(
        new QueryClient(),
        opts(['reply'], privateUri('3kowngone222')),
      ),
    ).rejects.toBeInstanceOf(PrivateParentUnavailableError)
    expect(postWrites()).toEqual([])
  })

  it('a branch walk reads at most 100 posts', async () => {
    const chain = (length: number) => {
      const uris = Array.from({length}, (_, i) =>
        privateUri(`3kchain${String(i).padStart(5, 'a')}`, OTHER_DID),
      )
      return uris.map((uri, i) =>
        served(uri, OTHER_DID, recordCids[3], {
          audienceList: OTHER_AUDIENCE,
          reply: {
            root: publicRef(PUBLIC_ROOT, recordCids[4]),
            parent:
              i === 0
                ? publicRef(PUBLIC_PARENT, recordCids[4])
                : {uri: uris[i - 1], cid: recordCids[3]},
          },
        }),
      )
    }
    const hundred = chain(100)
    servePrism(hundred)
    await postPrivate(new QueryClient(), opts(['deep'], hundred[99].uri))
    expect(written().nsid).toBe('tools.kryphocron.actor.participatePrivate')

    pds.calls.length = 0
    const hundredAndOne = chain(101)
    servePrism(hundredAndOne)
    await expect(
      postPrivate(
        new QueryClient(),
        opts(['too deep'], hundredAndOne[100].uri),
      ),
    ).rejects.toBeInstanceOf(PrivateReplyRefusedError)
    expect(postWrites()).toEqual([])
  })

  it('createPostPrivate’s fixed placement refusal maps to the refusal text; its other 400s do not', async () => {
    const rootUri = privateUri('3kownroot222')
    servePrism([served(rootUri, DID, recordCids[4], {audienceList: AUDIENCE})])
    storeOwn('3kownroot222', recordCids[4], {audienceList: AUDIENCE})
    pds.failures.create = () => ({
      status: 400,
      body: {
        error: 'InvalidRequest',
        message:
          'reply not permitted here; use tools.kryphocron.actor.participatePrivate',
      },
    })
    await expect(
      postPrivate(new QueryClient(), opts(['reply'], rootUri)),
    ).rejects.toBeInstanceOf(PrivateReplyRefusedError)

    pds.failures.create = () => ({
      status: 400,
      body: {error: 'InvalidRequest', message: 'audience does not exist'},
    })
    const other = await postPrivate(
      new QueryClient(),
      opts(['reply'], rootUri),
    ).catch((e: unknown) => e)
    expect(other).not.toBeInstanceOf(PrivateReplyRefusedError)
  })

  it('any 403 from participatePrivate maps to the refusal text', async () => {
    const parentUri = privateUri('3kparent2222', OTHER_DID)
    servePrism([
      served(parentUri, OTHER_DID, recordCids[3], {
        audienceList: OTHER_AUDIENCE,
      }),
    ])
    pds.failures.create = () => ({
      status: 403,
      body: {error: 'Forbidden', message: 'denied'},
    })
    await expect(
      postPrivate(new QueryClient(), opts(['reply'], parentUri)),
    ).rejects.toBeInstanceOf(PrivateReplyRefusedError)
  })
})

describe('postPrivate: reply and quote limits (4.14)', () => {
  const LIMITS = {
    threadgate: [{type: 'mention'}],
    postgate: {embeddingRules: [{$type: 'app.bsky.feed.postgate#disableRule'}]},
  }

  it('writes the threadgate (first rkey) and each postgate with createRecord before any post', async () => {
    const {uris} = await postPrivate(
      new QueryClient(),
      opts(['one', 'two'], undefined, LIMITS),
    )
    const order = nsids(pds.calls)
    const firstCreatePost = order.indexOf(
      'tools.kryphocron.feed.createPostPrivate',
    )
    const gateCalls = pds.calls.filter(
      c => c.nsid === 'com.atproto.repo.createRecord',
    )
    expect(gateCalls).toHaveLength(3)
    expect(order.lastIndexOf('com.atproto.repo.createRecord')).toBeLessThan(
      firstCreatePost,
    )
    const [first, second] = uris.map(uri => uri.split('/').pop())
    expect(
      gateCalls.map(c => [c.body?.collection, c.body?.rkey, c.body?.repo]),
    ).toEqual([
      ['app.bsky.feed.threadgate', first, DID],
      ['app.bsky.feed.postgate', first, DID],
      ['app.bsky.feed.postgate', second, DID],
    ])
    const threadgate = pds.gates.get(`app.bsky.feed.threadgate/${first}`)
    expect(threadgate?.post).toBe(uris[0])
    expect(threadgate?.allow).toEqual([
      {$type: 'app.bsky.feed.threadgate#mentionRule'},
    ])
    expect(pds.gates.get(`app.bsky.feed.postgate/${first}`)?.post).toBe(uris[0])
    expect(pds.gates.get(`app.bsky.feed.postgate/${second}`)?.post).toBe(
      uris[1],
    )
    expect(
      pds.gates.get(`app.bsky.feed.postgate/${second}`)?.embeddingRules,
    ).toEqual([{$type: 'app.bsky.feed.postgate#disableRule'}])
  })

  it('resolves every post’s media before the first gate or post write (D2-151)', async () => {
    const writesSoFar = () =>
      pds.calls.filter(
        c =>
          c.nsid === 'com.atproto.repo.createRecord' ||
          c.nsid === 'tools.kryphocron.feed.createPostPrivate',
      ).length
    const seen: number[] = []
    const record = () => {
      seen.push(writesSoFar())
      return Promise.resolve(undefined)
    }
    mockResolveEmbed
      .mockImplementationOnce(record)
      .mockImplementationOnce(record)
      .mockImplementationOnce(record)
    await postPrivate(
      new QueryClient(),
      opts(['one', 'two', 'three'], undefined, LIMITS),
    )
    expect(seen).toEqual([0, 0, 0])
    expect(writesSoFar()).toBe(7)
  })

  it('a failed upload in a later post writes no gate or post and deletes nothing', async () => {
    const failure = new Error('upload refused')
    mockResolveEmbed
      .mockImplementationOnce(() => Promise.resolve(undefined))
      .mockImplementationOnce(() => Promise.reject(failure))
    const error = await postPrivate(
      new QueryClient(),
      opts(['one', 'two'], undefined, LIMITS),
    ).catch((e: unknown) => e)
    expect(error).toBe(failure)
    const order = nsids(pds.calls)
    expect(order).not.toContain('com.atproto.repo.createRecord')
    expect(order).not.toContain('com.atproto.repo.deleteRecord')
    expect(order).not.toContain('tools.kryphocron.feed.createPostPrivate')
    expect(order).not.toContain('tools.kryphocron.feed.deletePostPrivate')
    expect(pds.gates.size).toBe(0)
    expect(pds.repo.size).toBe(0)
  })

  it('posts and gates carry the account’s own TID clock id (per-account TID clock, Appendix A)', async () => {
    const {uris} = await postPrivate(
      new QueryClient(),
      opts(['one', 'two'], undefined, LIMITS),
    )
    const rkeys = [
      ...uris.map(uri => uri.split('/').pop() as string),
      ...pds.calls
        .filter(c => c.nsid === 'com.atproto.repo.createRecord')
        .map(c => c.body?.rkey as string),
    ]
    expect(rkeys).toHaveLength(5)
    for (const rkey of rkeys) {
      expect(TID.fromStr(rkey).clockid()).toBe(clockIdFor(DID))
    }
    expect(clockIdFor(DID)).not.toBe(clockIdFor(OTHER_DID))
  })

  it('writes no gate with Anyone and quotes on', async () => {
    await postPrivate(new QueryClient(), opts(['one', 'two']))
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.createRecord')
  })

  it('a reply writes no threadgate', async () => {
    const first = await postPrivate(new QueryClient(), opts(['first']))
    pds.calls.length = 0
    await postPrivate(
      new QueryClient(),
      opts(['second'], first.uris[0], LIMITS),
    )
    const gateCalls = pds.calls.filter(
      c => c.nsid === 'com.atproto.repo.createRecord',
    )
    expect(gateCalls.map(c => c.body?.collection)).toEqual([
      'app.bsky.feed.postgate',
    ])
  })

  it('a gate failure throws before any post and deletes the gates already created', async () => {
    pds.failures.gateCreate = index =>
      index === 1 ? {status: 500, body: {error: 'Oops'}} : undefined
    const error = await postPrivate(
      new QueryClient(),
      opts(['one', 'two'], undefined, LIMITS),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateGatesNotSavedError)
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.feed.createPostPrivate',
    )
    expect(nsids(pds.calls)).toContain('com.atproto.repo.deleteRecord')
    expect(pds.gates.size).toBe(0)
  })

  it('a post failure deletes the posts, then the gates', async () => {
    pds.failures.create = (_call, index) =>
      index === 1
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    await expect(
      postPrivate(new QueryClient(), opts(['one', 'two'], undefined, LIMITS)),
    ).rejects.toBeDefined()
    const order = nsids(pds.calls)
    expect(
      order.lastIndexOf('tools.kryphocron.feed.deletePostPrivate'),
    ).toBeLessThan(order.indexOf('com.atproto.repo.deleteRecord'))
    expect(pds.repo.size).toBe(0)
    expect(pds.gates.size).toBe(0)
  })

  it('a gate that cannot be deleted is named in what may remain', async () => {
    pds.failures.create = () => ({
      status: 500,
      body: {error: 'InternalServerError'},
    })
    pds.failures.gateDelete = key =>
      key.startsWith('app.bsky.feed.threadgate')
        ? {status: 500, body: {error: 'Oops'}}
        : undefined
    const error = await postPrivate(
      new QueryClient(),
      opts(['one'], undefined, LIMITS),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateThreadPartlyPostedError)
    const remaining = (error as PrivateThreadPartlyPostedError).remaining
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatch(/app\.bsky\.feed\.threadgate/)
  })
})

describe('deletePrivatePost', () => {
  it('calls deletePostPrivate with the rkey, then requestRecord', async () => {
    const {uris} = await postPrivate(new QueryClient(), opts(['hello']))
    prism.calls.length = 0
    await deletePrivatePost(pds.client, uris[0])
    await settle()
    const del = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.feed.deletePostPrivate',
    )
    expect(del?.body).toEqual({repo: DID, rkey: uris[0].split('/').pop()})
    expect(nsids(prism.calls)).toContain('app.nearhorizon.index.requestRecord')
    expect(getPendingPost(uris[0])).toBeUndefined()
  })

  it('a delete whose procedure fails but whose record is gone counts as done', async () => {
    pds.failures.delete = () => ({status: 500, body: {error: 'Oops'}})
    await expect(
      deletePrivatePost(pds.client, privateUri('3knotthere22')),
    ).resolves.toBeUndefined()
  })

  it('a delete whose procedure fails while the record remains rethrows', async () => {
    const {uris} = await postPrivate(new QueryClient(), opts(['hello']))
    pds.failures.delete = () => ({status: 500, body: {error: 'Oops'}})
    await expect(deletePrivatePost(pds.client, uris[0])).rejects.toBeDefined()
  })
})

describe('languages and content warnings (K-1)', () => {
  it('writes at most three languages and the composer’s self-labels, and the pending view carries the labels', async () => {
    const withExtras = opts(['hello'])
    withExtras.langs = ['en', 'fr', 'de', 'es']
    ;(withExtras.thread.posts[0] as {labels: string[]}).labels = ['nudity']
    const {uris} = await postPrivate(new QueryClient(), withExtras)
    const create = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.feed.createPostPrivate',
    )
    const record = create?.body?.record as Record<string, unknown>
    expect(record.langs).toEqual(['en', 'fr', 'de'])
    expect(record.labels).toEqual({
      $type: 'tools.kryphocron.feed.postPublic#selfLabels',
      values: [{val: 'nudity'}],
    })
    const pending = getPendingPost(uris[0])
    expect(pending?.postView.labels).toEqual([
      expect.objectContaining({src: DID, uri: uris[0], val: 'nudity'}),
    ])
    expect((pending?.postView.record as {labels?: unknown}).labels).toEqual({
      $type: 'com.atproto.label.defs#selfLabels',
      values: [{val: 'nudity'}],
    })
  })
})

describe('media spoilers and content warnings (2J, T5)', () => {
  afterEach(() => {
    replaceComposeSpoilers(EMPTY_COMPOSE_SPOILERS)
  })

  it('writes the captured snapshot: CW text, flags and the CW label', async () => {
    const withMedia = opts(['hello'])
    ;(withMedia.thread.posts[0] as {embed: unknown}).embed = {
      quote: undefined,
      link: undefined,
      media: {
        type: 'images',
        images: [{source: {id: 'img-1'}}, {source: {id: 'img-2'}}],
      },
    }
    mockResolveEmbed.mockImplementationOnce(() =>
      Promise.resolve({
        $type: 'app.bsky.embed.images',
        images: [
          {image: blob(), alt: 'one'},
          {image: blob(), alt: 'two'},
        ],
      } as never),
    )
    replaceComposeSpoilers({
      ...EMPTY_COMPOSE_SPOILERS,
      images: new Set(['img-2']),
      cw: new Map([['other-post', {line: 'not this one'}]]),
    })
    const pending = postPrivate(new QueryClient(), withMedia)
    // Changed after the call: the write keeps what it captured.
    replaceComposeSpoilers({
      ...EMPTY_COMPOSE_SPOILERS,
      cw: new Map([['hello', {line: 'cw'}]]),
    })
    await pending
    const first = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.feed.createPostPrivate',
    )?.body?.record as Record<string, unknown>
    expect(first.text).toBe('hello')
    expect(first.labels).toBeUndefined()
    const images = (first.embed as {images: Record<string, unknown>[]}).images
    expect(images.map(i => i['app.nearhorizon.spoiler'])).toEqual([
      undefined,
      true,
    ])

    replaceComposeSpoilers({
      ...EMPTY_COMPOSE_SPOILERS,
      cw: new Map([['hello', {line: 'cw'}]]),
    })
    await postPrivate(new QueryClient(), opts(['hello']))
    const creates = pds.calls.filter(
      c => c.nsid === 'tools.kryphocron.feed.createPostPrivate',
    )
    const second = creates[creates.length - 1]?.body?.record as Record<
      string,
      unknown
    >
    expect(second.text).toBe('cw\n||hello||')
    expect(second.labels).toEqual({
      $type: 'tools.kryphocron.feed.postPublic#selfLabels',
      values: [{val: 'app.nearhorizon.cw'}],
    })
    expect(second.facets).toEqual([
      expect.objectContaining({
        features: [{$type: 'app.nearhorizon.richtext.facet#spoilerMarker'}],
      }),
      expect.objectContaining({
        index: {byteStart: 5, byteEnd: 10},
        features: [
          {$type: 'app.nearhorizon.richtext.facet#spoiler'},
          {$type: 'app.nearhorizon.richtext.facet#contentWarning'},
        ],
      }),
      expect.objectContaining({
        features: [{$type: 'app.nearhorizon.richtext.facet#spoilerMarker'}],
      }),
    ])
    // Only the first post, which has no content warning.
    expect(mockResolveSpoilerRT).toHaveBeenCalledTimes(1)
  })
})

describe('the write routes (2K-1)', () => {
  /** Bluesky's PDS, and a stock PDS: repo route `stock`. */
  const BSKY_SHARD = 'https://chalciporus.us-west.host.bsky.network'
  const STOCK = 'https://pds.stock.example'
  /** A kryphocron host missing from `LOCUS_PDS_ORIGINS` (PA-5). */
  const OTHER_LOCUS = 'https://locus-two.example'

  function store(rkey: string) {
    pds.repo.set(rkey, {
      cid: recordCids[0],
      record: {$type: PP, text: 'mine', createdAt: '2026-10-15T12:00:00.000Z'},
    })
  }

  it.each([BSKY_SHARD, STOCK])(
    'on %s a private compose is refused before any read, upload or write (4.9, the 2K-1 fault)',
    async pdsUrl => {
      publishPds(pdsUrl)
      mockResolveEmbed.mockClear()
      const onStateChange = jest.fn()
      const error = await postPrivate(new QueryClient(), {
        ...opts(['hello']),
        onStateChange,
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(PrivateRouteUnavailableError)
      expect((error as Error).message).toBe(
        'Private posting isn’t available for your account right now. Nothing was posted.',
      )
      expect(pds.calls).toEqual([])
      expect(prism.calls).toEqual([])
      expect(mockResolveEmbed).not.toHaveBeenCalled()
      expect(onStateChange).not.toHaveBeenCalled()
    },
  )

  it('on a stock PDS a private post is deleted with deleteRecord, then requestRecord (4.4, T-9)', async () => {
    publishPds(STOCK)
    store('3kmine222222')
    await deletePrivatePost(pds.client, privateUri('3kmine222222'))
    await settle()
    expect(nsids(pds.calls)).toEqual(['com.atproto.repo.deleteRecord'])
    expect(pds.calls[0].body).toEqual({
      repo: DID,
      collection: PP,
      rkey: '3kmine222222',
    })
    expect(pds.repo.has('3kmine222222')).toBe(false)
    expect(nsids(prism.calls)).toEqual(['app.nearhorizon.index.requestRecord'])
  })

  it('a stock delete that fails while the record remains rethrows; one already gone counts as done', async () => {
    publishPds(STOCK)
    pds.failures.gateDelete = () => ({status: 500, body: {error: 'Oops'}})
    store('3kmine222222')
    await expect(
      deletePrivatePost(pds.client, privateUri('3kmine222222')),
    ).rejects.toBeDefined()
    await expect(
      deletePrivatePost(pds.client, privateUri('3knotthere22')),
    ).resolves.toBeUndefined()
  })

  it.each([
    'KryphocronRecordRequiresDedicatedEndpoint',
    'KryphocronRecordNotYetSupported',
  ])(
    'a stock delete refused with %s is retried once through deletePostPrivate, and the routes become locus (PA-5, T-8)',
    async refusal => {
      publishPds(OTHER_LOCUS)
      expect(repoRouteForDid(DID)).toBe('stock')
      pds.failures.gateDelete = key =>
        key.startsWith(PP) ? {status: 400, body: {error: refusal}} : undefined
      store('3kmine222222')
      await deletePrivatePost(pds.client, privateUri('3kmine222222'))
      expect(nsids(pds.calls)).toEqual([
        'com.atproto.repo.deleteRecord',
        'tools.kryphocron.feed.deletePostPrivate',
      ])
      expect(pds.repo.has('3kmine222222')).toBe(false)
      expect(repoRouteForDid(DID)).toBe('locus')
    },
  )

  it('a generic 400 on a stock delete is not a PA-5 match', async () => {
    publishPds(OTHER_LOCUS)
    pds.failures.gateDelete = () => ({
      status: 400,
      body: {error: 'InvalidRequest'},
    })
    store('3kmine222222')
    await expect(
      deletePrivatePost(pds.client, privateUri('3kmine222222')),
    ).rejects.toBeDefined()
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.feed.deletePostPrivate',
    )
    expect(repoRouteForDid(DID)).toBe('stock')
  })

  it('a compose’s rollback deletes through the repo writer taken at entry, though the route moved mid-compose (PA-20, T-17)', async () => {
    pds.failures.create = (_call, index) => {
      if (index !== 1) return undefined
      // The account's PDS now reads as another host: the compose keeps its writers.
      publishPds(STOCK)
      return {status: 500, body: {error: 'InternalServerError'}}
    }
    await expect(
      postPrivate(new QueryClient(), opts(['one', 'two'])),
    ).rejects.toBeDefined()
    expect(repoRouteForDid(DID)).toBe('stock')
    expect(nsids(pds.calls)).toContain(
      'tools.kryphocron.feed.deletePostPrivate',
    )
    expect(
      pds.calls.filter(
        c =>
          c.nsid === 'com.atproto.repo.deleteRecord' &&
          c.body?.collection === PP,
      ),
    ).toEqual([])
    expect(pds.repo.size).toBe(0)
  })
})

describe('postPrivate: the reply block check on the locus route', () => {
  const PARENT = privateUri('3kblocked222', OTHER_DID)
  const BLOCK_URI = `at://${OTHER_DID}/app.bsky.graph.block/3kblock22222`
  const LIMITS = {threadgate: [{type: 'mention'}]}

  function writesAny() {
    return nsids(pds.calls).filter(
      n =>
        n === 'tools.kryphocron.feed.createPostPrivate' ||
        n === 'tools.kryphocron.actor.participatePrivate' ||
        n === 'com.atproto.repo.createRecord' ||
        n === 'com.atproto.repo.putRecord' ||
        n === 'tools.kryphocron.policy.manageAudience',
    )
  }

  beforeEach(() => {
    servePrism([
      served(PARENT, OTHER_DID, recordCids[3], {audienceList: OTHER_AUDIENCE}),
    ])
    mockResolveEmbed.mockClear()
  })

  it('a parent whose author blocked the member: the composer shows “You can’t reply to this post.”, and no upload, gate or post is written', async () => {
    appviewHandler = () => ({status: 500, body: {}})
    appview = fakeClient(
      DID,
      call =>
        relationshipsReply(call, {blockedBy: BLOCK_URI}) ??
        appviewHandler(call),
    ).client
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], PARENT, LIMITS),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyBlockedError)
    expect((error as Error).message).toBe('You can’t reply to this post.')
    expect(mockResolveEmbed).not.toHaveBeenCalled()
    expect(writesAny()).toEqual([])
  })

  it('a check that cannot be made shows the neutral text and writes nothing', async () => {
    appview = fakeClient(DID, () => ({status: 500, body: {}})).client
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], PARENT, LIMITS),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyCheckError)
    expect((error as Error).message).toBe(
      'Couldn’t reach the post you’re replying to. Try again in a moment.',
    )
    expect(writesAny()).toEqual([])
  })

  it('a block made during the uploads is caught before the first gate or post (PR2-L1)', async () => {
    REPLY_BLOCK_TIMING.freshMs = 0
    let blocked = false
    mockResolveEmbed.mockImplementation(() => {
      blocked = true
      return Promise.resolve(undefined)
    })
    appview = fakeClient(
      DID,
      call =>
        relationshipsReply(call, blocked ? {blockingByList: BLOCK_URI} : {}) ??
        appviewHandler(call),
    ).client
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], PARENT, LIMITS),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyBlockedError)
    expect(mockResolveEmbed).toHaveBeenCalled()
    expect(writesAny()).toEqual([])
    mockResolveEmbed.mockImplementation(() => Promise.resolve(undefined))
  })

  it('the AppView failing at the recheck after the uploads: the neutral text, nothing written', async () => {
    REPLY_BLOCK_TIMING.freshMs = 0
    let uploaded = false
    mockResolveEmbed.mockImplementation(() => {
      uploaded = true
      return Promise.resolve(undefined)
    })
    appview = fakeClient(DID, call =>
      uploaded && call.nsid === 'app.bsky.graph.getRelationships'
        ? {status: 500, body: {}}
        : (relationshipsReply(call) ?? appviewHandler(call)),
    ).client
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], PARENT, LIMITS),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyCheckError)
    expect(writesAny()).toEqual([])
    mockResolveEmbed.mockImplementation(() => Promise.resolve(undefined))
  })

  it('the verdict still fresh after the uploads: the AppView is asked once, and nothing reads a PDS listing', async () => {
    await postPrivate(new QueryClient(), opts(['reply'], PARENT, LIMITS))
    expect(nsids(pds.calls)).toContain(
      'tools.kryphocron.actor.participatePrivate',
    )
    expect(
      pds.calls.filter(
        c =>
          c.nsid === 'com.atproto.repo.listRecords' &&
          c.params.get('collection') !== AUD,
      ),
    ).toEqual([])
  })

  it('the thread’s owner (the root’s author) blocked, the parent’s author not: refused on the locus route (model (c))', async () => {
    const thirdDid = 'did:plc:thirdcccccccccccccccccccc'
    const rootUri = privateUri('3krootblk222', thirdDid)
    const replyUri = privateUri('3kreplyok222', OTHER_DID)
    servePrism([
      served(rootUri, thirdDid, recordCids[4], {
        audienceList: OTHER_AUDIENCE,
      }),
      served(replyUri, OTHER_DID, recordCids[3], {
        audienceList: OTHER_AUDIENCE,
        reply: {
          root: {uri: rootUri, cid: recordCids[4]},
          parent: {uri: rootUri, cid: recordCids[4]},
        },
      }),
    ])
    appview = fakeClient(
      DID,
      call =>
        relationshipsReply(call, did =>
          did === thirdDid ? {blockedBy: BLOCK_URI} : {},
        ) ?? appviewHandler(call),
    ).client
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], replyUri, {
        postgate: {
          embeddingRules: [{$type: 'app.bsky.feed.postgate#disableRule'}],
        },
      }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyBlockedError)
    expect((error as Error).message).toBe('You can’t reply to this post.')
    expect(writesAny()).toEqual([])
    expect(pds.gates.size).toBe(0)
    expect(mockResolveEmbed).not.toHaveBeenCalled()
  })

  it('a reply inside another account’s branch whose branch root’s author blocks the member: the owner asked after placement, refused, nothing written', async () => {
    const thirdDid = 'did:plc:thirdcccccccccccccccccccc'
    const publicRoot = `at://${thirdDid}/app.bsky.feed.post/3kpubroot222`
    const publicParent = `at://${thirdDid}/app.bsky.feed.post/3kpubpar2222`
    const branchUri = privateUri('3kbranch2222', thirdDid)
    const secondUri = privateUri('3ksecond2222', OTHER_DID)
    const publicRef = {uri: publicRoot, cid: recordCids[4]}
    servePrism([
      served(branchUri, thirdDid, recordCids[2], {
        audienceList: OTHER_AUDIENCE,
        reply: {
          root: publicRef,
          parent: {uri: publicParent, cid: recordCids[4]},
        },
      }),
      served(secondUri, OTHER_DID, recordCids[5], {
        audienceList: OTHER_AUDIENCE,
        reply: {root: publicRef, parent: {uri: branchUri, cid: recordCids[2]}},
      }),
    ])
    const relationshipCalls: string[][] = []
    appview = fakeClient(DID, call => {
      if (call.nsid === 'app.bsky.graph.getRelationships') {
        relationshipCalls.push(call.params.getAll('others'))
      }
      return (
        relationshipsReply(call, did =>
          did === thirdDid ? {blockedBy: BLOCK_URI} : {},
        ) ?? appviewHandler(call)
      )
    }).client
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], secondUri),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyBlockedError)
    expect(relationshipCalls).toEqual([[OTHER_DID], [thirdDid]])
    expect(writesAny()).toEqual([])
  })
})

describe('postPrivate: the check before the post write on the locus route (RB-13, R11)', () => {
  const PARENT = privateUri('3kblocked222', OTHER_DID)
  const BLOCK_URI = `at://${OTHER_DID}/app.bsky.graph.block/3kblock22222`
  const POSTGATE = {
    postgate: {embeddingRules: [{$type: 'app.bsky.feed.postgate#disableRule'}]},
  }

  /** Whether the gate write has answered, as each AppView call saw it. */
  let gateAnswered: boolean
  let seenAtCall: boolean[]
  let answer: (call: Call, n: number) => Reply

  function postWrites() {
    return nsids(pds.calls).filter(
      n => n === 'tools.kryphocron.actor.participatePrivate',
    )
  }

  /** Hold every gate write for `ms`. */
  function slowGates(ms: number) {
    pds.failures.gateHold = async () => {
      await new Promise(r => setTimeout(r, ms))
      gateAnswered = true
    }
  }

  /** Clear at the plan; the forced read (the second call) answers `second`. */
  function blockAtSecond(second: Record<string, unknown> | Reply) {
    answer = (call, n) =>
      n >= 2
        ? 'status' in second || second instanceof Error
          ? (second as Reply)
          : (relationshipsReply(call, second) as Reply)
        : (relationshipsReply(call) as Reply)
  }

  beforeEach(() => {
    servePrism([
      served(PARENT, OTHER_DID, recordCids[3], {audienceList: OTHER_AUDIENCE}),
    ])
    mockResolveEmbed.mockClear()
    gateAnswered = false
    seenAtCall = []
    answer = call => relationshipsReply(call) as Reply
    let n = 0
    appview = fakeClient(DID, call => {
      if (call.nsid !== 'app.bsky.graph.getRelationships') {
        return appviewHandler(call)
      }
      seenAtCall.push(gateAnswered)
      return answer(call, ++n)
    }).client
  })

  it('slow gates: the forced read is sent while the gate write is pending; a block there deletes the gates and writes no post', async () => {
    REPLY_BLOCK_TIMING.prePostFreshMs = 30
    slowGates(200)
    blockAtSecond({blockedBy: BLOCK_URI})
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], PARENT, POSTGATE),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyBlockedError)
    expect((error as Error).message).toBe('You can’t reply to this post.')
    expect(seenAtCall).toEqual([false, false])
    expect(nsids(pds.calls)).toContain('com.atproto.repo.createRecord')
    expect(nsids(pds.calls)).toContain('com.atproto.repo.deleteRecord')
    expect(pds.gates.size).toBe(0)
    expect(postWrites()).toEqual([])
  })

  it('a verdict already stale when the gates start: the forced read starts at once, beside the gates', async () => {
    REPLY_BLOCK_TIMING.prePostFreshMs = 0
    slowGates(100)
    await postPrivate(new QueryClient(), opts(['reply'], PARENT, POSTGATE))
    /*
     * The plan, then the forced read beside the gates; with a zero
     * threshold the guarded call after the gates reads once more.
     */
    expect(seenAtCall).toEqual([false, false, true])
    expect(postWrites()).toHaveLength(1)
  })

  /*
   * Scaled time: the threshold is hundreds of milliseconds here for the
   * design's 10 s, with margin for the plan's own time under load.
   */
  it.each([
    ['soon after the forced read', 420],
    ['a while after it', 520],
  ])(
    '3b: gates done %s: the guarded call measures from the forced read and reads nothing more',
    async (_name, gateMs) => {
      REPLY_BLOCK_TIMING.prePostFreshMs = 400
      slowGates(gateMs)
      await postPrivate(new QueryClient(), opts(['reply'], PARENT, POSTGATE))
      expect(seenAtCall).toEqual([false, false])
      expect(postWrites()).toHaveLength(1)
    },
  )

  it('3d (PR8-L1): a gate slower than the threshold past a clear forced read: a block made meanwhile is read before the post, and refuses', async () => {
    REPLY_BLOCK_TIMING.prePostFreshMs = 100
    slowGates(450)
    const start = Date.now()
    answer = (call: Call) =>
      relationshipsReply(
        call,
        Date.now() - start >= 250 ? {blockedBy: BLOCK_URI} : {},
      ) as Reply
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], PARENT, POSTGATE),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyBlockedError)
    // The plan, the clear forced read beside the gates, the read after them.
    expect(seenAtCall).toEqual([false, false, true])
    expect(pds.gates.size).toBe(0)
    expect(postWrites()).toEqual([])
  })

  it('no gates: no timer and no forced read, one AppView call in all', async () => {
    REPLY_BLOCK_TIMING.prePostFreshMs = 0
    REPLY_BLOCK_TIMING.freshMs = 60_000
    await postPrivate(new QueryClient(), opts(['reply'], PARENT))
    expect(seenAtCall).toHaveLength(2)
    expect(postWrites()).toHaveLength(1)

    // Fresh before the post, with no gates: the plan's call only.
    seenAtCall = []
    REPLY_BLOCK_TIMING.prePostFreshMs = 10_000
    await postPrivate(new QueryClient(), opts(['reply'], PARENT))
    expect(seenAtCall).toHaveLength(1)
  })

  it('slow gates with the AppView failing at the forced read: the neutral text, the gates deleted, no post', async () => {
    REPLY_BLOCK_TIMING.prePostFreshMs = 30
    slowGates(200)
    blockAtSecond({status: 500, body: {error: 'InternalServerError'}})
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], PARENT, POSTGATE),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyCheckError)
    expect(pds.gates.size).toBe(0)
    expect(postWrites()).toEqual([])
  })

  it('fast gates (PR6-L1, PR7-L1): no forced read, and the reply posts though the AppView would fail any further call', async () => {
    blockAtSecond({status: 500, body: {error: 'InternalServerError'}})
    await postPrivate(new QueryClient(), opts(['reply'], PARENT, POSTGATE))
    expect(seenAtCall).toHaveLength(1)
    expect(pds.gates.size).toBe(1)
    expect(postWrites()).toHaveLength(1)
  })

  it('PR5-N5: a refusal whose gate delete fails keeps the block text and logs the gate left behind', async () => {
    REPLY_BLOCK_TIMING.prePostFreshMs = 30
    slowGates(200)
    blockAtSecond({blockedBy: BLOCK_URI})
    pds.failures.gateDelete = () => ({status: 500, body: {error: 'Oops'}})
    const logged = jest.spyOn(logger, 'error')
    const error = await postPrivate(
      new QueryClient(),
      opts(['reply'], PARENT, POSTGATE),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateReplyBlockedError)
    expect(error).not.toBeInstanceOf(PrivateThreadPartlyPostedError)
    const call = logged.mock.calls.find(
      ([message]) => message === 'private thread could not be fully removed',
    )
    expect((call?.[1] as {uris: string[]}).uris).toEqual([
      expect.stringMatching(/app\.bsky\.feed\.postgate/),
    ])
    expect(postWrites()).toEqual([])
    logged.mockRestore()
  })

  it.each([
    ['a block refusal wins', {blockedBy: BLOCK_URI}, PrivateReplyBlockedError],
    [
      'a check that cannot be made leaves the gates’ own error',
      {status: 500, body: {error: 'InternalServerError'}},
      PrivateGatesNotSavedError,
    ],
  ] as [string, Record<string, unknown> | Reply, new () => Error][])(
    'the gate write and the forced read both failing (PR7-N5): %s, with no unhandled rejection',
    async (_name, second, expected) => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      REPLY_BLOCK_TIMING.prePostFreshMs = 30
      slowGates(200)
      blockAtSecond(second)
      pds.failures.gateCreate = () => ({status: 500, body: {error: 'Oops'}})
      const error = await postPrivate(
        new QueryClient(),
        opts(['reply'], PARENT, POSTGATE),
      ).catch((e: unknown) => e)
      await settle()
      process.off('unhandledRejection', onUnhandled)
      expect(error).toBeInstanceOf(expected)
      expect(seenAtCall).toEqual([false, false])
      expect(postWrites()).toEqual([])
      expect(unhandled).toEqual([])
    },
  )
})

describe('postPrivate with no audience chosen (P5R7-L1)', () => {
  it('refuses first, before any read, create or send', async () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'unsaved'},
      locked: false,
    })
    const error = await postPrivate(new QueryClient(), opts(['hello'])).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(PrivateAudienceUnpickedError)
    expect((error as Error).message).toBe('Choose who can see this post.')
    expect(pds.calls).toEqual([])
    expect(prism.calls).toEqual([])
  })
})
