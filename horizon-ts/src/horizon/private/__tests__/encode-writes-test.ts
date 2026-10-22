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

/*
 * 2K-3: private posting on posting route `encode` (2K design 4.2, 4.7, 4.9;
 * T-4, T-6, T-7, T-8, T-11, T-14). The encoder module is mocked (T-4): the
 * real one is never loaded in jest. From 2K-9 the compose runs in the
 * outbox's background job (PA-28): each test awaits the job after the press.
 */
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
let mockDirectClient: unknown
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => mockDirectClient,
}))

type EncodeArgs = {
  did: string
  rkey: string
  content: {text: string; facets?: unknown; embed?: unknown}
  nowSecs: number
}
const mockEncode = jest.fn<(input: EncodeArgs) => Record<string, unknown>>()
const mockLoadEncoder = jest.fn<() => Promise<unknown>>()
const mockEncoderAvailable = jest.fn(() => true)
jest.mock('#/horizon/private/encoder', () => ({
  ...jest.requireActual<object>('#/horizon/private/encoder/types'),
  encoderAvailable: () => mockEncoderAvailable(),
  prewarmEncoder: () => {},
  loadEncoder: () => mockLoadEncoder(),
}))

import {type Client} from '@atproto/lex'
import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {computeCid} from '#/lib/api/computeCid'
import {type PostOpts} from '#/lib/api/index'
import {logger} from '#/logger'
import {type ThreadDraft} from '#/view/com/composer/state/composer'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {
  type ProbeEnvironment,
  resetMembership,
  startMembershipProbe,
} from '#/horizon/routing/membership'
import {
  getWriteRoute,
  repoRouteForDid,
  resetWriteRoutes,
} from '#/horizon/routing/write-route'
import {writeLocal} from '#/horizon/session/local-store'
import {createListAudience} from '../api/audiences'
import {changePrivatePostAudience} from '../api/update-audience'
import {
  PrivateAudienceChangeUnavailableError,
  PrivateKryphocronHostError,
} from '../api/writer'
import {postPrivate, stopPrivateConfirmations} from '../api/writes'
import {PUBLIC_COMPOSE, setComposeVisibility} from '../composer/state'
import {
  type EncodeFailureClass,
  PrivateEncodeFailedError,
} from '../encoder/types'
import {resetOutbox, whenOutboxIdle} from '../outbox'
import {resetLocalLocks} from '../outbox/locks'
import {listOutboxRecords} from '../outbox/record'
import {outboxFailureText} from '../outbox/texts'
import {clearPrivateStores, getPendingPost} from '../store'
import {
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
const CREATED_AUDIENCE = `at://${DID}/${AUD}/3kcreated222`
/** A stock PDS: repo route `stock`. */
const STOCK = 'https://pds.stock.example'
/** A kryphocron host missing from `LOCUS_PDS_ORIGINS` (PA-5). */
const OTHER_LOCUS = 'https://locus-two.example'
const SECRET = 'a private secret 7f3a'
const LIMITS = {
  threadgate: [{type: 'mention'}],
  postgate: {embeddingRules: [{$type: 'app.bsky.feed.postgate#disableRule'}]},
}

const quietEnv: ProbeEnvironment = {
  setTimeout: () => undefined,
  clearTimeout: () => {},
  isHidden: () => false,
  onVisible: () => () => {},
}

let recordCids: string[] = []

beforeAll(async () => {
  recordCids = await Promise.all(
    [1, 2, 3, 4, 5, 6, 7].map(n => computeCid({n} as never)),
  )
})

type Stored = {record: Record<string, unknown>; cid: string}

/**
 * A fake stock PDS: every write is a stock repo call.
 */
function fakePds() {
  const repo = new Map<string, Stored>()
  let created = 0
  const audiences: {uri: string; value: Record<string, unknown>}[] = [
    {uri: EVERYONE_AUDIENCE, value: {$type: AUD, mode: 'everyone'}},
  ]
  const failures: {
    create?: (call: Call, index: number) => Reply | undefined
    deletePost?: (rkey: string) => Reply | undefined
  } = {}
  const gates = new Map<string, Record<string, unknown>>()
  /** What prism and the direct client had been asked when each post was written. */
  const prismCallsAtPostWrite: number[] = []

  const handler = (call: Call): Reply => {
    switch (call.nsid) {
      case 'com.atproto.repo.createRecord': {
        const collection = call.body?.collection as string
        if (collection === PP) {
          prismCallsAtPostWrite.push(prism.calls.length + direct.calls.length)
          const index = created++
          const failure = failures.create?.(call, index)
          if (failure) return failure
          const rkey = call.body?.rkey as string
          repo.set(rkey, {
            record: call.body?.record as Record<string, unknown>,
            cid: recordCids[index],
          })
          return {
            status: 200,
            body: {uri: privateUri(rkey), cid: recordCids[index]},
          }
        }
        if (collection === AUD) {
          audiences.push({
            uri: CREATED_AUDIENCE,
            value: call.body?.record as Record<string, unknown>,
          })
          return {
            status: 200,
            body: {uri: CREATED_AUDIENCE, cid: recordCids[6]},
          }
        }
        const key = `${collection}/${call.body?.rkey as string}`
        gates.set(key, call.body?.record as Record<string, unknown>)
        return {
          status: 200,
          body: {uri: `at://${DID}/${key}`, cid: recordCids[5]},
        }
      }
      case 'com.atproto.repo.getRecord': {
        const rkey = call.params.get('rkey') ?? ''
        const stored = repo.get(rkey)
        if (!stored) {
          return {status: 400, body: {error: 'RecordNotFound'}}
        }
        return {
          status: 200,
          body: {uri: privateUri(rkey), cid: stored.cid, value: stored.record},
        }
      }
      case 'com.atproto.repo.deleteRecord': {
        const collection = call.body?.collection as string
        const rkey = call.body?.rkey as string
        if (collection === PP) {
          const failure = failures.deletePost?.(rkey)
          if (failure) return failure
          repo.delete(rkey)
        } else {
          gates.delete(`${collection}/${rkey}`)
        }
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
      default:
        return {status: 501, body: {error: 'MethodNotImplemented'}}
    }
  }
  const {client, calls} = fakeClient(DID, handler)
  return {
    client,
    calls,
    repo,
    audiences,
    failures,
    gates,
    prismCallsAtPostWrite,
  }
}

let pds: ReturnType<typeof fakePds>
let prism: ReturnType<typeof fakeClient>
let direct: ReturnType<typeof fakeClient>
let prismPosts: Map<string, Record<string, unknown>>
let caughtUp: boolean
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

function postCreates() {
  return pds.calls.filter(
    c =>
      c.nsid === 'com.atproto.repo.createRecord' && c.body?.collection === PP,
  )
}

function writes() {
  return pds.calls.filter(
    c =>
      c.nsid === 'com.atproto.repo.createRecord' ||
      c.nsid === 'com.atproto.repo.putRecord' ||
      c.nsid === 'com.atproto.repo.deleteRecord',
  )
}

let queryClient: QueryClient

function publishPds(pdsUrl: string) {
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl,
    pdsClient: pds.client,
    prismClient: prism.client,
    appviewClient: appview,
    chatClient: appview,
    queryClient,
  })
}

/** Press Post, then wait for the outbox's job (PA-28). */
async function post(options: PostOpts) {
  const result = await postPrivate(queryClient, options)
  await whenOutboxIdle()
  return result
}

function onlyRecord() {
  const records = listOutboxRecords(DID)
  expect(records).toHaveLength(1)
  return records[0]
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
}

/** Answer one `getMembership` for the account and let it settle. */
async function answerMembership(body: Record<string, unknown>) {
  const probe = fakeClient(DID, () => ({status: 200, body}))
  const cancel = startMembershipProbe(DID, probe.client, quietEnv)
  await settle()
  cancel()
}

/** The encoder's answer for one post: distinct bytes per call. */
let encodes = 0
function fieldsFor(input: EncodeArgs): Record<string, unknown> {
  encodes++
  return {
    encodedContent: new Uint8Array([1, 2, encodes]),
    encodedContentCodec: 'codec/0.2',
    encodedContentGeneration: `codec/${String(input.nowSecs).padStart(20, '0')}/${'a'.repeat(64)}`,
  }
}

/** A private post as prism serves it. */
function served(uri: string, did: string, cid: string, fields: object) {
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

function prismHandler(call: Call): Reply {
  if (call.nsid === 'app.nearhorizon.private.getPosts') {
    const posts = call.params
      .getAll('uris')
      .map(uri => prismPosts.get(uri))
      .filter(post => !!post)
    return {status: 200, body: {posts}}
  }
  return {status: 200, body: {status: 'indexed', caughtUp}}
}

beforeEach(async () => {
  queryClient = new QueryClient()
  resetOutbox()
  resetLocalLocks()
  for (const record of listOutboxRecords(DID)) {
    writeLocal(`horizon-outbox:${DID}:${record.id}`, undefined)
  }
  pds = fakePds()
  prismPosts = new Map()
  caughtUp = false
  prism = fakeClient(DID, prismHandler)
  direct = fakeClient(DID, prismHandler)
  mockPrismClient = prism.client
  mockDirectClient = direct.client
  appview = fakeClient(DID, () => ({status: 500, body: {}})).client
  encodes = 0
  mockEncode.mockReset()
  mockEncode.mockImplementation(fieldsFor)
  mockLoadEncoder.mockReset()
  mockLoadEncoder.mockResolvedValue({encode: mockEncode})
  mockEncoderAvailable.mockReturnValue(true)
  mockResolveReply.mockReset()
  resetMembership()
  resetPrismFeatures()
  resetWriteRoutes()
  clearPrivateStores()
  publishPds(STOCK)
  await answerMembership({
    status: 'member',
    features: ['private', 'private.anyPds'],
  })
  setComposeVisibility({
    visibility: 'private',
    audience: {kind: 'mode', mode: 'everyone'},
    locked: false,
  })
  // The calls the membership answer made are not the compose's.
  pds.calls.length = 0
  prism.calls.length = 0
})

afterEach(() => {
  stopPrivateConfirmations()
  setComposeVisibility(PUBLIC_COMPOSE)
  jest.restoreAllMocks()
})

describe('the encode route (2K-3)', () => {
  it('a member on a stock PDS whose prism lists private.anyPds is on posting route encode', () => {
    expect(getWriteRoute(DID)).toMatchObject({
      repoRoute: 'stock',
      postingRoute: 'encode',
    })
  })

  it('a top-level post is encoded locally and written with createRecord at its rkey, with no prism call or token before the write (T-4)', async () => {
    const before = Math.floor(Date.now() / 1000)
    const withLangs = opts(['hello'])
    withLangs.langs = ['en']
    const {uris} = await post(withLangs)
    const after = Math.floor(Date.now() / 1000)

    expect(nsids(pds.calls)).toEqual([
      'com.atproto.repo.listRecords',
      'com.atproto.repo.createRecord',
    ])
    expect(pds.prismCallsAtPostWrite).toEqual([0])
    expect(nsids(pds.calls)).not.toContain('com.atproto.server.getServiceAuth')

    const create = postCreates()[0]
    const rkey = create.body?.rkey as string
    expect(rkey).toMatch(/^[a-z2-7]{13}$/)
    expect(uris).toEqual([privateUri(rkey)])
    expect(create.body?.repo).toBe(DID)
    expect(create.body?.collection).toBe(PP)
    expect(create.body).not.toHaveProperty('validate')
    expect(create.body).not.toHaveProperty('swapCommit')

    expect(mockEncode).toHaveBeenCalledTimes(1)
    const input = mockEncode.mock.calls[0][0]
    expect(input.did).toBe(DID)
    expect(input.rkey).toBe(rkey)
    expect(input.content).toEqual({text: 'hello'})
    expect(input.nowSecs).toBeGreaterThanOrEqual(before)
    expect(input.nowSecs).toBeLessThanOrEqual(after)

    const record = create.body?.record as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(
      [
        '$type',
        'audienceList',
        'createdAt',
        'encodedContent',
        'encodedContentCodec',
        'encodedContentGeneration',
        'langs',
      ].sort(),
    )
    expect(record.$type).toBe(PP)
    expect(record.audienceList).toBe(EVERYONE_AUDIENCE)
    expect(record.langs).toEqual(['en'])
    expect(record.encodedContent).toEqual({$bytes: 'AQIB'})
    expect(record.encodedContentCodec).toBe('codec/0.2')
    expect(JSON.stringify(record)).not.toContain('hello')

    // The pending view shows the plaintext; its CID is createRecord's answer.
    const pending = getPendingPost(uris[0])
    expect(pending?.cid).toBe(recordCids[0])
    expect(pending?.record.text).toBe('hello')
  })

  it('the confirmation reads go to prism directly, never through the PDS (PA-7)', async () => {
    caughtUp = true
    await post(opts(['hello']))
    await settle()
    expect(nsids(prism.calls)).toEqual(['app.nearhorizon.index.requestRecord'])
    expect(nsids(direct.calls)).toEqual(['app.nearhorizon.private.getPosts'])
  })

  it('a thread is encoded post by post at its own rkeys before any gate, and post 2 replies with post 1’s createRecord CID (T-4, PA-11, PA-12)', async () => {
    const order: string[] = []
    const writesAtEncode: number[] = []
    mockEncode.mockImplementation(input => {
      order.push(`encode ${input.rkey}`)
      writesAtEncode.push(writes().length)
      return fieldsFor(input)
    })
    const {uris} = await post(opts(['one', 'two', 'three'], undefined, LIMITS))
    const rkeys = uris.map(uri => uri.split('/').pop())
    expect(order).toEqual(rkeys.map(rkey => `encode ${rkey}`))
    expect(mockEncode.mock.calls.map(([input]) => input.content.text)).toEqual([
      'one',
      'two',
      'three',
    ])
    // Every encode before the first gate write; the gates before any post.
    expect(writesAtEncode).toEqual([0, 0, 0])
    expect(
      writes()
        .slice(0, 3)
        .map(c => c.body?.collection),
    ).toEqual([
      'app.bsky.feed.threadgate',
      'app.bsky.feed.postgate',
      'app.bsky.feed.postgate',
    ])
    expect(postCreates().map(c => c.body?.rkey)).toEqual(rkeys)
    const records = postCreates().map(
      c => c.body?.record as {reply?: {root: unknown; parent: unknown}},
    )
    expect(records[0].reply).toBeUndefined()
    expect(records[1].reply).toEqual({
      root: {uri: uris[0], cid: recordCids[0]},
      parent: {uri: uris[0], cid: recordCids[0]},
    })
    expect(records[2].reply).toEqual({
      root: {uri: uris[0], cid: recordCids[0]},
      parent: {uri: uris[1], cid: recordCids[1]},
    })
    // createRecord's CID: no getRecord read-back on success.
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.getRecord')
  })

  it.each<EncodeFailureClass>(['load', 'encode', 'input', 'output'])(
    'an encoder %s failure writes no post or gate and shows 4.9’s text, logged by class only (T-4, T-6, T-14)',
    async failureClass => {
      const warn = jest.spyOn(logger, 'warn')
      if (failureClass === 'load') {
        mockLoadEncoder.mockRejectedValue(new PrivateEncodeFailedError('load'))
      } else {
        mockEncode.mockImplementation(() => {
          throw new PrivateEncodeFailedError(failureClass)
        })
      }
      // The press returns at once; the job fails at the encode (PA-28).
      const {uris} = await post(opts([SECRET], undefined, LIMITS))
      expect(writes()).toEqual([])
      const record = onlyRecord()
      expect(record).toMatchObject({state: 'failed', failure: 'encoder'})
      expect(record.present).toEqual([])
      expect(outboxFailureText(record.failure)).toBe(
        'Private posting isn’t available right now. Nothing was posted.',
      )
      expect(getPendingPost(uris[0])?.phase).toBe('failed')
      expect(warn).toHaveBeenCalledWith('encode: failed', {failureClass})
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)
    },
  )

  it('an invalid assembly writes nothing and is logged by key path only (PA-10, T-22)', async () => {
    const error = jest.spyOn(logger, 'error')
    mockEncode.mockImplementation(input => ({
      ...fieldsFor(input),
      mentionDids: ['not a did'],
    }))
    await post(opts([SECRET], undefined, LIMITS))
    expect(onlyRecord()).toMatchObject({state: 'failed', failure: 'encoder'})
    expect(writes()).toEqual([])
    expect(error).toHaveBeenCalledWith('encode: assembled record invalid', {
      path: expect.stringMatching(/^mentionDids/),
    })
    expect(JSON.stringify(error.mock.calls)).not.toContain('not a did')
  })

  it('a first-use standing audience is created with createRecord and prism asked to catch up before the post is written (4.7, T-4)', async () => {
    pds.audiences.length = 0
    await post(opts(['hello']))
    const audienceCreates = pds.calls.filter(
      c =>
        c.nsid === 'com.atproto.repo.createRecord' &&
        c.body?.collection === AUD,
    )
    expect(audienceCreates).toHaveLength(1)
    expect(audienceCreates[0].body?.record).toMatchObject({
      $type: AUD,
      mode: 'everyone',
    })
    expect(audienceCreates[0].body).not.toHaveProperty('rkey')
    // The audience's requestRecord came before the post write.
    expect(pds.prismCallsAtPostWrite).toEqual([1])
    expect(prism.calls[0].body?.uri).toBe(CREATED_AUDIENCE)
    const record = postCreates()[0].body?.record as Record<string, unknown>
    expect(record.audienceList).toBe(CREATED_AUDIENCE)
  })

  it('a reply in another account’s private thread places through prism’s proxied read, then writes to the writer’s own repo (PA-34, T-4)', async () => {
    const parentUri = privateUri('3kparent2222', OTHER_DID)
    prismPosts.set(
      parentUri,
      served(parentUri, OTHER_DID, recordCids[3], {
        audienceList: OTHER_AUDIENCE,
      }),
    )
    setComposeVisibility(PUBLIC_COMPOSE)
    await post(opts(['reply'], parentUri))
    expect(nsids(prism.calls)[0]).toBe('app.nearhorizon.private.getPosts')
    expect(nsids(pds.calls)).not.toContain('com.atproto.server.getServiceAuth')
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.actor.participatePrivate',
    )
    const create = postCreates()[0]
    expect(create.body?.repo).toBe(DID)
    const record = create.body?.record as {
      audienceList: string
      reply: unknown
    }
    expect(record.audienceList).toBe(OTHER_AUDIENCE)
    expect(record.reply).toEqual({
      root: {uri: parentUri, cid: recordCids[3]},
      parent: {uri: parentUri, cid: recordCids[3]},
    })
  })

  it('a reply to the writer’s own pending post places from the pending entry, with no prism read (L-22)', async () => {
    const first = await post(opts(['first']))
    prism.calls.length = 0
    await post(opts(['second'], first.uris[0]))
    expect(nsids(prism.calls)).not.toContain('app.nearhorizon.private.getPosts')
    const record = postCreates()[1].body?.record as {
      reply: {parent: unknown}
    }
    expect(record.reply.parent).toEqual({
      uri: first.uris[0],
      cid: recordCids[0],
    })
  })

  it('a failure at post 2 deletes nothing: post 1 and the gates stay, and the compose is Partly posted (T-7, v12)', async () => {
    pds.failures.create = (_call, index) =>
      index === 1
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    const {uris} = await post(opts(['one', 'two'], undefined, LIMITS))
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.deleteRecord')
    expect(pds.repo.size).toBe(1)
    expect(pds.gates.size).toBe(3)
    expect(onlyRecord()).toMatchObject({
      state: 'failed',
      failure: 'post',
      present: [uris[0]],
    })
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.feed.deletePostPrivate',
    )
  })

  it('a create refused with locus’s answer writes no post, moves the routes to locus and shows PA-5’s text (T-8)', async () => {
    publishPds(OTHER_LOCUS)
    expect(getWriteRoute(DID).postingRoute).toBe('encode')
    pds.failures.create = () => ({
      status: 400,
      body: {error: 'KryphocronRecordRequiresDedicatedEndpoint'},
    })
    await post(opts(['hello']))
    expect(onlyRecord()).toMatchObject({
      state: 'failed',
      failure: 'kryphocron-host',
      present: [],
    })
    expect(outboxFailureText('kryphocron-host')).toBe(
      new PrivateKryphocronHostError().message,
    )
    expect(pds.repo.size).toBe(0)
    expect(repoRouteForDid(DID)).toBe('locus')
    expect(getWriteRoute(DID).postingRoute).toBe('locus')
  })

  it('no logged value carries the post’s text, on success or failure (T-14)', async () => {
    const spies = (['info', 'warn', 'error', 'debug', 'log'] as const).map(
      level => jest.spyOn(logger, level),
    )
    prism = fakeClient(DID, () => ({
      status: 500,
      body: {error: 'InternalServerError', message: SECRET},
    }))
    mockPrismClient = prism.client
    await post(opts([SECRET]))
    pds.failures.create = () => ({
      status: 500,
      body: {error: 'InternalServerError', message: SECRET},
    })
    await post(opts([SECRET])).catch(() => {})
    await settle()
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET)
    }
  })
})

describe('audiences on the encode route (4.7, T-11)', () => {
  it('a list is created with createRecord at a PDS-chosen rkey, then requestRecord', async () => {
    const uri = await createListAudience(
      new QueryClient(),
      {did: DID, pdsClient: pds.client, prismClient: prism.client},
      {name: 'Friends', members: [OTHER_DID]},
    )
    expect(uri).toBe(CREATED_AUDIENCE)
    const create = pds.calls.find(
      c => c.nsid === 'com.atproto.repo.createRecord',
    )
    expect(create?.body).toMatchObject({
      repo: DID,
      collection: AUD,
      record: {$type: AUD, mode: 'list', name: 'Friends', members: [OTHER_DID]},
    })
    expect(create?.body).not.toHaveProperty('rkey')
    await settle()
    expect(nsids(prism.calls)).toEqual(['app.nearhorizon.index.requestRecord'])
  })
})

describe('change of audience on the encode route (8.1, before 2K-8)', () => {
  it('is refused before any read or write while ENCODE_AUDIENCE_CHANGE is off', async () => {
    const error = await changePrivatePostAudience({
      queryClient: new QueryClient(),
      clients: {did: DID, pdsClient: pds.client, prismClient: prism.client},
      postUri: privateUri('3kmine222222'),
      swapCid: recordCids[0],
      audience: {kind: 'mode', mode: 'followers'},
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateAudienceChangeUnavailableError)
    expect(pds.calls).toEqual([])
    expect(prism.calls).toEqual([])
  })
})
