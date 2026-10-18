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

import {type Client} from '@atproto/lex'
import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {computeCid} from '#/lib/api/computeCid'
import {type PostOpts} from '#/lib/api/index'
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
import {PrivateAudienceMissingError} from '../api/audiences'
import {
  deletePrivatePost,
  postPrivate,
  PrivateGatesNotSavedError,
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
  const {client, calls} = fakeClient(DID, handler)
  return {client, calls, repo, audiences, failures, gates}
}

let prismHandler: (call: Call) => Reply
let pds: ReturnType<typeof fakePds>
let prism: ReturnType<typeof fakeClient>
let appview: Client

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
  appview = fakeClient(DID, () => ({status: 500, body: {}})).client
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl: 'https://pds.example',
    pdsClient: pds.client,
    prismClient: prism.client,
    appviewClient: appview,
  })
  clearPrivateStores()
  setComposeVisibility({
    visibility: 'private',
    audience: {kind: 'mode', mode: 'everyone'},
    locked: false,
  })
  mockResolveReply.mockReset()
  mockResolveSpoilerRT.mockClear()
  resetPrismFeatures()
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
    await postPrivate(new QueryClient(), opts(['reply'], secondUri))
    const {nsid, record} = written()
    expect(nsid).toBe('tools.kryphocron.actor.participatePrivate')
    expect(record?.audienceList).toBe(NEW_OTHER)
    expect(record?.reply.root).toEqual({uri: PUBLIC_ROOT, cid: recordCids[4]})
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

  it('a branch whose root cannot be read is refused before any write', async () => {
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
    await expect(
      postPrivate(new QueryClient(), opts(['reply'], middleUri)),
    ).rejects.toBeInstanceOf(PrivateReplyRefusedError)
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
