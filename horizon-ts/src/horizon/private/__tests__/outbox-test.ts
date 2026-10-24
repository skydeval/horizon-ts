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
 * 2K-9: the outbox (2K design 4.11, PA-28, 8.4; T-23, T-24, T-31). The
 * encoder module is mocked: the real one is never loaded in jest. Web Locks
 * are the outbox's in-tab fallback, so "another tab" is a lock this test
 * takes itself.
 */
const mockResolveEmbed = jest.fn(() => Promise.resolve(undefined))
jest.mock('#/lib/api/index', () => ({
  resolveEmbed: () => mockResolveEmbed(),
  resolveReply: () => Promise.reject(new Error('no public reply here')),
}))
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))
jest.mock('#/state/queries/profile', () => ({
  RQKEY: (did: string) => ['profile', did],
}))
jest.mock('#/state/queries/resolve-link', () => ({
  RQKEY_LINK: (url: string) => ['resolve-link', url],
}))
// The stock gate helpers the settings dialog's save uses; never reached here.
const mockGateUpsert = jest.fn(() => Promise.resolve())
jest.mock('#/state/queries/threadgate', () => ({
  upsertThreadgate: () => mockGateUpsert(),
}))
jest.mock('#/state/queries/postgate', () => ({
  upsertPostgate: () => mockGateUpsert(),
}))
jest.mock('#/view/com/composer/drafts/state/storage', () => ({
  deleteMediaFromLocal: () => Promise.resolve(),
}))
let mockPrismClient: unknown
jest.mock('#/horizon/routing/prism', () => ({
  getPrismClient: () => mockPrismClient,
}))
let mockDirectClient: unknown
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => mockDirectClient,
}))

/** When set, a checked device write whose value matches fails (quota). */
let mockFailChecked: ((value: string | undefined) => boolean) | undefined
jest.mock('#/horizon/session/local-store', () => {
  const actual = jest.requireActual<{
    writeLocalChecked: (key: string, value: string | undefined) => boolean
  }>('#/horizon/session/local-store')
  return {
    ...actual,
    writeLocalChecked: (key: string, value: string | undefined) =>
      mockFailChecked?.(value) ? false : actual.writeLocalChecked(key, value),
  }
})

type EncodeArgs = {did: string; rkey: string; nowSecs: number}
const mockEncode = jest.fn<(input: EncodeArgs) => Record<string, unknown>>()
const mockLoadEncoder = jest.fn<() => Promise<unknown>>()
const mockPrewarm = jest.fn()
jest.mock('#/horizon/private/encoder', () => ({
  ...jest.requireActual<object>('#/horizon/private/encoder/types'),
  encoderAvailable: () => true,
  prewarmEncoder: () => mockPrewarm(),
  loadEncoder: () => mockLoadEncoder(),
}))

import {type Client} from '@atproto/lex'
import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {computeCid} from '#/lib/api/computeCid'
import {type PostOpts} from '#/lib/api/index'
import {type ThreadDraft} from '#/view/com/composer/state/composer'
import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'
import {
  resetPostingRecord,
  startPostingRecord,
  updatePosting,
} from '#/horizon/posting-as/compose-store'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {
  type ProbeEnvironment,
  resetMembership,
  startMembershipProbe,
} from '#/horizon/routing/membership'
import {getWriteRoute, resetWriteRoutes} from '#/horizon/routing/write-route'
import {
  listLocalKeys,
  readLocal,
  writeLocal,
} from '#/horizon/session/local-store'
import {REPLY_BLOCK_TIMING} from '../api/reply-block'
import {PrivateRouteUnavailableError} from '../api/writer'
import {postPrivate, stopPrivateConfirmations} from '../api/writes'
import {PUBLIC_COMPOSE, setComposeVisibility} from '../composer/state'
import {PrivateEncodeFailedError} from '../encoder/types'
import {missVerdict, resetKnown} from '../known'
import {
  beginOutboxEdit,
  checkOutboxEntry,
  deletePostedOutboxEntry,
  discardOutboxEntry,
  forgetRemovedAccount,
  isAnsweredWrite,
  listUnsent,
  OUTBOX_TIMING,
  outboxNextUse,
  type OutboxNotice,
  type OutboxSeen,
  PrivateMediaUnreadableError,
  PrivateOutboxNotSavedError,
  removeOutboxEntryFromDevice,
  resetOutbox,
  retryOutboxEntry,
  setOutboxPaused,
  subscribeOutboxNotices,
  takeStagedOutboxEdit,
  whenOutboxIdle,
} from '../outbox'
import {outboxEntryActions} from '../outbox/actions'
import {heldLockNames, resetLocalLocks, tryRunLock} from '../outbox/locks'
import {
  listOutboxRecords,
  type OutboxRecord,
  readOutboxRecord,
  saveOutboxRecord,
} from '../outbox/record'
import {runLockName} from '../outbox/running'
import {hidesGateControls} from '../render/controls'
import {
  PrivatePostPendingError,
  savePrivatePostGates,
} from '../settings/save-gates'
import {clearPrivateStores, getPendingPost, pendingPhase} from '../store'
import {
  type Call,
  DID,
  fakeClient,
  OTHER_DID,
  relationshipsReply,
  type Reply,
} from './fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

const PP = 'tools.kryphocron.feed.postPrivate'
const AUD = 'tools.kryphocron.policy.audience'
const TG = 'app.bsky.feed.threadgate'
const PG = 'app.bsky.feed.postgate'
const EVERYONE_AUDIENCE = `at://${DID}/${AUD}/3keveryone22`
const LIST_AUDIENCE = `at://${DID}/${AUD}/3klistaaaa22`
const STOCK = 'https://pds.stock.example'
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

let cids: string[] = []

beforeAll(async () => {
  cids = await Promise.all(
    Array.from({length: 40}, (_x, n) => computeCid({n} as never)),
  )
})

type Stored = {value: Record<string, unknown>; cid: string}

/**
 * A stock PDS with posts, gates and audiences. `fail` answers a call before
 * the store does; returning `undefined` lets it through.
 */
function fakePds() {
  const posts = new Map<string, Stored>()
  const gates = new Map<string, Stored>()
  let next = 0
  const state: {fail?: (call: Call) => Reply | undefined} = {}
  const audiences: {uri: string; value: Record<string, unknown>}[] = [
    {uri: EVERYONE_AUDIENCE, value: {$type: AUD, mode: 'everyone'}},
    {uri: LIST_AUDIENCE, value: {$type: AUD, mode: 'list', name: 'Friends'}},
  ]
  const handler = (call: Call): Reply => {
    const failure = state.fail?.(call)
    if (failure) return failure
    const collection = (call.body?.collection ??
      call.params.get('collection')) as string
    const rkey = (call.body?.rkey ?? call.params.get('rkey')) as string
    const store = collection === PP ? posts : gates
    const key = collection === PP ? rkey : `${collection}/${rkey}`
    switch (call.nsid) {
      case 'com.atproto.repo.createRecord': {
        if (collection === AUD) {
          const uri = `at://${DID}/${AUD}/3kcreated${next}`
          audiences.push({
            uri,
            value: call.body?.record as Record<string, unknown>,
          })
          return {status: 200, body: {uri, cid: cids[next++]}}
        }
        if (store.has(key)) {
          return {status: 400, body: {error: 'InvalidRequest'}}
        }
        const cid = cids[next++]
        store.set(key, {
          value: call.body?.record as Record<string, unknown>,
          cid,
        })
        return {
          status: 200,
          body: {uri: `at://${DID}/${collection}/${rkey}`, cid},
        }
      }
      case 'com.atproto.repo.putRecord': {
        const stored = store.get(key)
        if (stored && call.body?.swapRecord !== stored.cid) {
          return {status: 400, body: {error: 'InvalidSwap'}}
        }
        const cid = cids[next++]
        store.set(key, {
          value: call.body?.record as Record<string, unknown>,
          cid,
        })
        return {
          status: 200,
          body: {uri: `at://${DID}/${collection}/${rkey}`, cid},
        }
      }
      case 'com.atproto.repo.getRecord': {
        const stored = store.get(key)
        if (!stored) return {status: 400, body: {error: 'RecordNotFound'}}
        return {
          status: 200,
          body: {
            uri: `at://${DID}/${collection}/${rkey}`,
            cid: stored.cid,
            value: stored.value,
          },
        }
      }
      case 'com.atproto.repo.deleteRecord':
        store.delete(key)
        return {status: 200, body: {}}
      case 'com.atproto.repo.listRecords':
        return {
          status: 200,
          body: {
            records: audiences.map(a => ({
              uri: a.uri,
              cid: cids[39],
              value: a.value,
            })),
          },
        }
      default:
        return {status: 501, body: {error: 'MethodNotImplemented'}}
    }
  }
  const {client, calls} = fakeClient(DID, handler)
  return {client, calls, posts, gates, audiences, state}
}

let pds: ReturnType<typeof fakePds>
let prism: ReturnType<typeof fakeClient>
let direct: ReturnType<typeof fakeClient>
let appview: ReturnType<typeof fakeClient>
/** The AppView's `getRelationships` answer; the default is no block. */
let relationships: (call: Call) => Reply | undefined
let queryClient: QueryClient
let notices: OutboxNotice[]
let unsubscribeNotices: () => void

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
  {
    replyTo,
    limits = {},
    langs,
  }: {
    replyTo?: string
    limits?: {threadgate?: unknown[]; postgate?: Record<string, unknown>}
    langs?: string[]
  } = {},
): PostOpts {
  return {
    thread: {
      posts: texts.map(draft),
      postgate: limits.postgate ?? {},
      threadgate: limits.threadgate ?? [{type: 'everybody'}],
    } as unknown as ThreadDraft,
    replyTo,
    langs,
    appviewClient: appview.client,
    chatClient: appview.client,
    pdsClient: pds.client,
  }
}

function publish(did = DID, pdsClient: Client = pds.client) {
  clearCurrentClients()
  publishCurrentClients({
    did,
    handle: 'alice.test',
    pdsUrl: STOCK,
    pdsClient,
    prismClient: prism.client,
    appviewClient: appview.client,
    chatClient: appview.client,
    queryClient,
  })
}

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0))
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function answerMembership() {
  const probe = fakeClient(DID, () => ({
    status: 200,
    body: {status: 'member', features: ['private', 'private.anyPds']},
  }))
  const cancel = startMembershipProbe(DID, probe.client, quietEnv)
  await settle()
  cancel()
}

let encodes = 0
function fieldsFor(input: EncodeArgs): Record<string, unknown> {
  encodes++
  return {
    encodedContent: new Uint8Array([7, encodes]),
    encodedContentCodec: 'codec/0.2',
    encodedContentGeneration: `codec/${String(input.nowSecs).padStart(20, '0')}/${'a'.repeat(64)}`,
  }
}

/** Press Post, then wait for the job. */
async function press(options: PostOpts) {
  const result = await postPrivate(queryClient, options)
  await whenOutboxIdle()
  await settle()
  return result
}

function records(): OutboxRecord[] {
  return listOutboxRecords(DID)
}

function only(): OutboxRecord {
  const all = records()
  expect(all).toHaveLength(1)
  return all[0]
}

function seen(record: OutboxRecord): OutboxSeen {
  const {id, did, state, failure, present, deleting} = record
  return {id, did, state, failure, present, deleting}
}

function nsids(calls: Call[]) {
  return calls.map(call => call.nsid)
}

function postWrites() {
  return pds.calls.filter(
    c =>
      (c.nsid === 'com.atproto.repo.createRecord' ||
        c.nsid === 'com.atproto.repo.putRecord') &&
      c.body?.collection === PP,
  )
}

function deletes() {
  return pds.calls.filter(c => c.nsid === 'com.atproto.repo.deleteRecord')
}

function uriOf(rkey: string) {
  return `at://${DID}/${PP}/${rkey}`
}

/** A record written straight to the device, as another run left it. */
function storeRecord(partial: Partial<OutboxRecord> & {rkeys: string[]}) {
  const record: OutboxRecord = {
    v: 1,
    id: partial.id ?? `rec${Math.random().toString(36).slice(2, 8)}`,
    did: DID,
    pressedAt: Date.now() - 60_000,
    state: 'sending',
    posts: partial.rkeys.map((_rkey, index) => ({
      text: `post ${index + 1}`,
      labels: [],
      refs: {},
      media: {images: 0, video: false},
      spoilers: {imageCount: 0, images: [], video: false},
    })),
    visibility: 'private',
    audience: {kind: 'mode', mode: 'everyone'},
    locked: false,
    gates: {threadgate: [{type: 'everybody'}], postgate: {} as never},
    ...partial,
  }
  saveOutboxRecord(record)
  return record
}

function storedPost(rkey: string, value: Record<string, unknown> = {}) {
  pds.posts.set(rkey, {
    value: {$type: PP, audienceList: EVERYONE_AUDIENCE, ...value},
    cid: cids[30 + pds.posts.size],
  })
}

beforeEach(async () => {
  resetOutbox()
  resetLocalLocks()
  for (const key of listLocalKeys('horizon-')) writeLocal(key, undefined)
  queryClient = new QueryClient()
  pds = fakePds()
  prism = fakeClient(DID, () => ({status: 200, body: {status: 'indexed'}}))
  direct = fakeClient(DID, () => ({status: 200, body: {posts: []}}))
  relationships = call => relationshipsReply(call)
  appview = fakeClient(
    DID,
    call => relationships(call) ?? {status: 200, body: {}},
  )
  REPLY_BLOCK_TIMING.freshMs = 2_000
  REPLY_BLOCK_TIMING.prePostFreshMs = 10_000
  mockPrismClient = prism.client
  mockDirectClient = direct.client
  mockFailChecked = undefined
  encodes = 0
  mockEncode.mockReset()
  mockEncode.mockImplementation(fieldsFor)
  mockLoadEncoder.mockReset()
  mockLoadEncoder.mockResolvedValue({encode: mockEncode})
  mockPrewarm.mockReset()
  OUTBOX_TIMING.callMs = 60_000
  OUTBOX_TIMING.settleMs = 3 * 60_000
  resetMembership()
  resetPrismFeatures()
  resetWriteRoutes()
  clearPrivateStores()
  publish()
  await answerMembership()
  setComposeVisibility({
    visibility: 'private',
    audience: {kind: 'mode', mode: 'everyone'},
    locked: false,
  })
  notices = []
  unsubscribeNotices = subscribeOutboxNotices(notice => notices.push(notice))
  pds.calls.length = 0
  prism.calls.length = 0
})

afterEach(async () => {
  setOutboxPaused(false)
  await whenOutboxIdle()
  unsubscribeNotices()
  stopPrivateConfirmations()
  setComposeVisibility(PUBLIC_COMPOSE)
  jest.restoreAllMocks()
})

describe('the press (PA-28 step 1, T-23)', () => {
  it('returns the URIs with no network call, the run lock held, the record queued with no media or encoded bytes, and the posts sending', async () => {
    expect(getWriteRoute(DID).postingRoute).toBe('encode')
    setOutboxPaused(true)
    const {uris} = await postPrivate(
      queryClient,
      opts(['one', 'two'], {limits: LIMITS, langs: ['en']}),
    )
    expect(pds.calls).toEqual([])
    expect(prism.calls).toEqual([])
    expect(appview.calls).toEqual([])
    const record = only()
    expect(record.state).toBe('queued')
    expect(record.rkeys.map(uriOf)).toEqual(uris)
    expect(record.posts.map(post => post.text)).toEqual(['one', 'two'])
    expect(record.langs).toEqual(['en'])
    expect(record.audience).toEqual({kind: 'mode', mode: 'everyone'})
    expect(readLocal(`horizon-outbox:${DID}:${record.id}`)).not.toContain(
      'encodedContent',
    )
    expect(await heldLockNames()).toContain(runLockName(record.id))
    for (const uri of uris) {
      const pending = getPendingPost(uri)
      expect(pending && pendingPhase(pending)).toBe('sending')
    }
    expect(mockEncode).not.toHaveBeenCalled()
    setOutboxPaused(false)
    await whenOutboxIdle()
    await settle()
    expect(records()).toEqual([])
    expect(postWrites().map(c => c.body?.rkey)).toEqual(record.rkeys)
    for (const uri of uris) {
      const pending = getPendingPost(uri)
      expect(pending && pendingPhase(pending)).toBe('written')
    }
  })

  it('refuses on posting route checking with the composer open and no record (K8-L2)', async () => {
    resetMembership()
    expect(getWriteRoute(DID).postingRoute).toBe('checking')
    await expect(
      postPrivate(queryClient, opts(['one'])),
    ).rejects.toBeInstanceOf(PrivateRouteUnavailableError)
    expect(records()).toEqual([])
    expect(pds.calls).toEqual([])
  })

  it('a record that cannot be saved fails the press, releases the lock and starts no job (K8-N8)', async () => {
    mockFailChecked = () => true
    await expect(
      postPrivate(queryClient, opts(['one'])),
    ).rejects.toBeInstanceOf(PrivateOutboxNotSavedError)
    mockFailChecked = undefined
    await whenOutboxIdle()
    expect(records()).toEqual([])
    expect(pds.calls).toEqual([])
    expect(
      Array.from(await heldLockNames()).filter(name =>
        name.startsWith('horizon-outbox-run:'),
      ),
    ).toEqual([])
  })

  it('an image that cannot be read fails the press before anything is saved', async () => {
    const options = opts(['one'])
    ;(options.thread.posts[0].embed as unknown as {media: unknown}).media = {
      type: 'images',
      images: [
        {
          alt: '',
          source: {
            id: 'img',
            path: 'blob:gone',
            width: 1,
            height: 1,
            mime: 'image/jpeg',
          },
        },
      ],
    }
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('revoked'))
    await expect(postPrivate(queryClient, options)).rejects.toBeInstanceOf(
      PrivateMediaUnreadableError,
    )
    expect(fetchSpy).toHaveBeenCalledWith('blob:gone')
    expect(records()).toEqual([])
  })
})

describe('failures (PA-28 steps 2 and 4, T-23)', () => {
  it('an encoder failure is Not posted, with the toast, nothing written, and no draft call', async () => {
    mockLoadEncoder.mockRejectedValue(new PrivateEncodeFailedError('load'))
    const {uris} = await press(opts(['one'], {limits: LIMITS}))
    expect(only()).toMatchObject({
      state: 'failed',
      failure: 'encoder',
      present: [],
    })
    expect(
      pds.calls.filter(c => c.nsid !== 'com.atproto.repo.listRecords'),
    ).toEqual([])
    expect(pendingPhase(getPendingPost(uris[0])!)).toBe('failed')
    expect(notices.map(n => n.text)).toEqual([
      'Your private post wasn’t posted. It’s saved on this device in Unsent.',
    ])
    expect(
      nsids(appview.calls).filter(n => n.startsWith('app.bsky.draft')),
    ).toEqual([])
  })

  it('an answered 400 on a post whose read finds it absent is Not posted at once', async () => {
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP
        ? {status: 400, body: {error: 'InvalidRecord'}}
        : undefined
    await press(opts(['one']))
    expect(only()).toMatchObject({
      state: 'failed',
      failure: 'post',
      present: [],
    })
    expect(nsids(pds.calls)).toContain('com.atproto.repo.getRecord')
  })

  it('a gate createRecord answering 400 is Not posted at once, with no delete and no post (K11-N1)', async () => {
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PG
        ? {status: 400, body: {error: 'InvalidRecord'}}
        : undefined
    await press(opts(['one'], {limits: LIMITS}))
    expect(only()).toMatchObject({state: 'failed', failure: 'gates'})
    expect(deletes()).toEqual([])
    expect(postWrites()).toEqual([])
    expect(pds.gates.size).toBe(1)
  })

  it('a failing lastWriteAt write stops before the gate write: no gate createRecord, Not posted', async () => {
    mockFailChecked = value => !!value?.includes('"lastWriteAt"')
    await press(opts(['one'], {limits: LIMITS}))
    mockFailChecked = undefined
    expect(only()).toMatchObject({state: 'failed', failure: 'not-saved'})
    expect(
      pds.calls.filter(
        c =>
          c.nsid === 'com.atproto.repo.createRecord' &&
          c.body?.collection !== AUD,
      ),
    ).toEqual([])
  })

  it('a post failing after post 1 is Partly posted: nothing deleted, gates kept (T-7, v12)', async () => {
    let posts = 0
    pds.state.fail = call => {
      if (
        call.nsid !== 'com.atproto.repo.createRecord' ||
        call.body?.collection !== PP
      ) {
        return undefined
      }
      return posts++ === 1
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    }
    const {uris} = await press(opts(['one', 'two', 'three'], {limits: LIMITS}))
    expect(only()).toMatchObject({
      state: 'failed',
      failure: 'post',
      present: [uris[0]],
    })
    expect(deletes()).toEqual([])
    expect(pds.posts.size).toBe(1)
    expect(pds.gates.size).toBe(4)
    expect(notices.map(n => n.text)).toEqual([
      'Only part of your private post was posted. Finish or delete it in Unsent.',
    ])
    // Post 1 goes back to failed with the rest (K11-N2).
    for (const uri of uris)
      expect(pendingPhase(getPendingPost(uri)!)).toBe('failed')
  })

  it('a write with no answer is undecided until its settle time, with no read and no delete (K9-L1)', async () => {
    OUTBOX_TIMING.settleMs = 300
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP
        ? new TypeError('Network request failed')
        : undefined
    const {uris} = await press(opts(['one'], {limits: LIMITS}))
    const record = only()
    expect(record.state).toBe('undecided')
    expect(record.settleAfter).toBe(record.lastWriteAt! + 300)
    expect(record.lastWriteKind).toBe('create')
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.getRecord')
    expect(pendingPhase(getPendingPost(uris[0])!)).toBe('failed')
    // Check now inside the window: absent decides nothing.
    pds.state.fail = undefined
    await checkOutboxEntry(seen(record))
    expect(only().state).toBe('undecided')
    // The settle timer decides it, deleting nothing.
    await sleep(400)
    await settle()
    expect(only()).toMatchObject({state: 'failed', present: []})
    expect(deletes()).toEqual([])
    expect(pds.gates.size).toBe(2)
  })

  it('a write that commits after its answer was lost is found by Check now inside the window: done', async () => {
    pds.state.fail = call => {
      if (
        call.nsid !== 'com.atproto.repo.createRecord' ||
        call.body?.collection !== PP
      ) {
        return undefined
      }
      pds.posts.set(call.body?.rkey as string, {
        value: call.body?.record as Record<string, unknown>,
        cid: cids[20],
      })
      return new TypeError('Network request failed')
    }
    const {uris} = await press(opts(['one']))
    const record = only()
    expect(record.state).toBe('undecided')
    pds.state.fail = undefined
    await checkOutboxEntry(seen(record))
    await settle()
    expect(records()).toEqual([])
    expect(getPendingPost(uris[0])).toMatchObject({
      phase: 'written',
      cid: cids[20],
    })
  })

  it('classes the answers: edge statuses and a bad body are unanswered (K10-N1, K11-N1)', async () => {
    expect(isAnsweredWrite(new TypeError('fetch failed'))).toBe(false)
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP
        ? {status: 502, body: {error: 'BadGateway'}}
        : undefined
    await press(opts(['one']))
    expect(only().state).toBe('undecided')
    expect(only().settleAfter).toBeDefined()
  })

  it('a 2xx whose body fails the output schema is unanswered', async () => {
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP
        ? {status: 200, body: {}}
        : undefined
    await press(opts(['one']))
    expect(only()).toMatchObject({state: 'undecided'})
    expect(only().settleAfter).toBeDefined()
  })

  it('an answered 500 whose read fails is undecided with no settle time, and Check now decides it at once (K11-L3)', async () => {
    let reads = 0
    pds.state.fail = call => {
      if (
        call.nsid === 'com.atproto.repo.createRecord' &&
        call.body?.collection === PP
      ) {
        return {status: 500, body: {error: 'InternalServerError'}}
      }
      if (call.nsid === 'com.atproto.repo.getRecord' && reads++ === 0) {
        return {status: 500, body: {error: 'InternalServerError'}}
      }
      return undefined
    }
    const {uris} = await press(opts(['one']))
    const record = only()
    expect(record).toMatchObject({state: 'undecided'})
    expect(record.settleAfter).toBeUndefined()
    expect(record.lastWriteAt).toBeUndefined()
    storedPost(record.rkeys[0])
    await checkOutboxEntry(seen(record))
    await settle()
    expect(records()).toEqual([])
    expect(getPendingPost(uris[0])?.phase).toBe('written')
  })

  it('a stall is aborted at its timeout and the next compose in the queue runs (K8-N4)', async () => {
    OUTBOX_TIMING.callMs = 50
    let first = true
    pds.state.fail = call => {
      if (
        call.nsid === 'com.atproto.repo.createRecord' &&
        call.body?.collection === PP &&
        first
      ) {
        first = false
        return new Promise<never>(() => {}) as never
      }
      return undefined
    }
    await postPrivate(queryClient, opts(['stalls']))
    await press(opts(['second']))
    const states = records().map(r => r.state)
    expect(states).toEqual(['undecided'])
    expect(pds.posts.size).toBe(1)
  })
})

describe('the decision at the next use (PA-28 step 5, T-23)', () => {
  it('nothing present: Not posted with the toast, nothing deleted, nothing written (no resume)', async () => {
    const record = storeRecord({rkeys: ['3kaaaa1', '3kaaaa2', '3kaaaa3']})
    pds.gates.set(`${TG}/3kaaaa1`, {value: {}, cid: cids[1]})
    await outboxNextUse(DID)
    expect(readOutboxRecord(DID, record.id)).toMatchObject({
      state: 'failed',
      present: [],
    })
    expect(deletes()).toEqual([])
    expect(postWrites()).toEqual([])
    expect(notices).toHaveLength(1)
  })

  it('all present: the record is dropped, requestRecord per post, no toast', async () => {
    const record = storeRecord({rkeys: ['3kbbbb1', '3kbbbb2']})
    storedPost('3kbbbb1')
    storedPost('3kbbbb2')
    await outboxNextUse(DID)
    await settle()
    expect(readOutboxRecord(DID, record.id)).toBeUndefined()
    expect(nsids(prism.calls)).toEqual([
      'app.nearhorizon.index.requestRecord',
      'app.nearhorizon.index.requestRecord',
    ])
    expect(notices).toEqual([])
  })

  it('the first present only: Partly posted, nothing deleted, Finish posting and Delete what was posted offered, no Edit', async () => {
    const record = storeRecord({rkeys: ['3kcccc1', '3kcccc2', '3kcccc3']})
    storedPost('3kcccc1')
    await outboxNextUse(DID)
    const decided = readOutboxRecord(DID, record.id)!
    expect(decided).toMatchObject({
      state: 'failed',
      present: [uriOf('3kcccc1')],
    })
    expect(deletes()).toEqual([])
    const actions = outboxEntryActions(
      {
        record: decided,
        holdsCapture: false,
        runningHere: false,
        runningElsewhere: false,
      },
      getWriteRoute(DID),
      {inUnsent: true},
    )
    expect(actions).toMatchObject({
      retry: {finish: true, disabled: false},
      deletePosted: true,
      edit: false,
      discard: false,
      remove: true,
    })
  })

  it('a failing read leaves it undecided, never Not posted', async () => {
    const record = storeRecord({rkeys: ['3kdddd1']})
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.getRecord'
        ? new TypeError('offline')
        : undefined
    await outboxNextUse(DID)
    expect(readOutboxRecord(DID, record.id)?.state).toBe('undecided')
    pds.state.fail = undefined
    await outboxNextUse(DID)
    expect(readOutboxRecord(DID, record.id)?.state).toBe('failed')
  })

  it('a record left mid-write waits for its settle time from lastWriteAt', async () => {
    OUTBOX_TIMING.settleMs = 200
    const record = storeRecord({
      rkeys: ['3keeee1'],
      lastWriteAt: Date.now(),
      lastWriteKind: 'create',
    })
    await outboxNextUse(DID)
    expect(readOutboxRecord(DID, record.id)?.state).toBe('undecided')
    await sleep(300)
    await settle()
    expect(readOutboxRecord(DID, record.id)?.state).toBe('failed')
  })

  it('a record whose run lock another tab holds is left alone, shown as posting elsewhere', async () => {
    const record = storeRecord({rkeys: ['3kffff1']})
    const other = await tryRunLock(runLockName(record.id))
    await outboxNextUse(DID)
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.getRecord')
    const unsent = listUnsent(DID, await heldLockNames())
    expect(unsent).toHaveLength(1)
    expect(unsent[0].runningElsewhere).toBe(true)
    expect(
      outboxEntryActions(unsent[0], getWriteRoute(DID), {inUnsent: true}),
    ).toMatchObject({
      label: 'Posting in another tab...',
      remove: false,
      discard: false,
    })
    other?.release()
  })

  it('a failed record is not decided again', async () => {
    storeRecord({rkeys: ['3kgggg1'], state: 'failed', present: []})
    await outboxNextUse(DID)
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.getRecord')
  })
})

describe('Retry and Finish posting (T-24)', () => {
  it('Retry posts at the same rkeys with a fresh encode, and leaves the outbox', async () => {
    mockLoadEncoder.mockRejectedValueOnce(new PrivateEncodeFailedError('load'))
    const {uris} = await press(opts(['one']))
    const record = only()
    await retryOutboxEntry(seen(record))
    await whenOutboxIdle()
    await settle()
    expect(mockPrewarm).toHaveBeenCalled()
    expect(records()).toEqual([])
    expect(postWrites().map(c => c.body?.rkey)).toEqual([record.rkeys[0]])
    expect(getPendingPost(uris[0])?.phase).toBe('written')
  })

  it('Finish posting writes only the absent posts with fresh encodes, post 2 replying to post 1’s read CID, and no gate or delete', async () => {
    let posts = 0
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP &&
      posts++ === 1
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    const {uris} = await press(opts(['one', 'two', 'three'], {limits: LIMITS}))
    pds.state.fail = undefined
    const firstBytes = (
      postWrites()[0].body?.record as {encodedContent: unknown}
    ).encodedContent
    const record = only()
    pds.calls.length = 0
    await retryOutboxEntry(seen(record))
    await whenOutboxIdle()
    await settle()
    expect(records()).toEqual([])
    const written = postWrites()
    expect(written.map(c => c.body?.rkey)).toEqual(record.rkeys.slice(1))
    const post2 = written[0].body?.record as {
      reply: {root: unknown; parent: unknown}
      encodedContent: unknown
    }
    expect(post2.reply.parent).toEqual({
      uri: uris[0],
      cid: pds.posts.get(record.rkeys[0])!.cid,
    })
    expect(post2.reply.root).toEqual({
      uri: uris[0],
      cid: pds.posts.get(record.rkeys[0])!.cid,
    })
    expect(post2.encodedContent).not.toEqual(firstBytes)
    expect(
      pds.calls.filter(
        c =>
          (c.nsid === 'com.atproto.repo.createRecord' ||
            c.nsid === 'com.atproto.repo.putRecord') &&
          c.body?.collection !== PP,
      ),
    ).toEqual([])
    expect(deletes()).toEqual([])
  })

  it('Finish posting names post 1’s stored audience, makes no audience and runs no placement (K11-L2)', async () => {
    let posts = 0
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP &&
      posts++ === 1
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    await press(opts(['one', 'two']))
    pds.state.fail = undefined
    const record = only()
    const post1 = pds.posts.get(record.rkeys[0])!
    post1.value = {...post1.value, audienceList: LIST_AUDIENCE}
    pds.audiences.splice(0, 1)
    pds.calls.length = 0
    await retryOutboxEntry(seen(record))
    await whenOutboxIdle()
    const written = postWrites()
    expect(written).toHaveLength(1)
    expect(
      (written[0].body?.record as {audienceList: string}).audienceList,
    ).toBe(LIST_AUDIENCE)
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.listRecords')
  })

  it('a Retry after a gate failure keeps an equal gate and rewrites a differing one with its CID as swap (K6-N10)', async () => {
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PG
        ? {status: 400, body: {error: 'InvalidRecord'}}
        : undefined
    await press(opts(['one'], {limits: LIMITS}))
    pds.state.fail = undefined
    const record = only()
    const threadgate = pds.gates.get(`${TG}/${record.rkeys[0]}`)!
    pds.calls.length = 0
    await retryOutboxEntry(seen(record))
    await whenOutboxIdle()
    const gateWrites = pds.calls.filter(
      c =>
        (c.nsid === 'com.atproto.repo.createRecord' ||
          c.nsid === 'com.atproto.repo.putRecord') &&
        c.body?.collection !== PP,
    )
    expect(
      gateWrites.map(c => `${c.nsid} ${String(c.body?.collection)}`),
    ).toEqual([`com.atproto.repo.createRecord ${PG}`])
    expect(pds.gates.get(`${TG}/${record.rkeys[0]}`)).toBe(threadgate)
    expect(records()).toEqual([])
  })

  it('a record-only Retry (after a reload) writes the captured langs', async () => {
    mockLoadEncoder.mockRejectedValueOnce(new PrivateEncodeFailedError('load'))
    await press(opts(['hello'], {langs: ['de', 'en']}))
    const record = only()
    resetOutbox()
    await retryOutboxEntry(seen(record))
    await whenOutboxIdle()
    const written = postWrites()[0].body?.record as {langs?: string[]}
    expect(written.langs).toEqual(['de', 'en'])
  })

  it('a record-only Retry (after a reload) writes the fronters chosen at press, in the clear and never in the payload (Phase 5 B-11)', async () => {
    const WREN = '3m4kq2xv7ad2c'
    startPostingRecord(DID, 'alice.test')
    updatePosting({
      members: [WREN],
      data: {
        did: DID,
        isSystem: true,
        members: [
          {
            rkey: WREN,
            value: {
              displayName: 'Wren',
              pronouns: [],
              roles: [],
              memberTypes: [],
              raw: {},
            },
          },
        ],
      },
    })
    mockLoadEncoder.mockRejectedValueOnce(new PrivateEncodeFailedError('load'))
    await press(opts(['hello']))
    const record = only()
    expect(record.fronters).toEqual([WREN])
    // The composer is gone, and so is this tab's capture.
    resetPostingRecord()
    resetOutbox()
    await retryOutboxEntry(seen(record))
    await whenOutboxIdle()
    const written = postWrites()[0].body?.record as Record<string, unknown>
    expect(written[PLURAL_FRONTERS_KEY]).toEqual({members: [{id: WREN}]})
    const encoded = mockEncode.mock.calls.at(-1)?.[0] as unknown as {
      content: Record<string, unknown>
    }
    expect(Object.keys(encoded.content)).toEqual(['text'])
  })
})

describe('the member’s deletes (K10-L1, T-23)', () => {
  async function partlyPosted() {
    let posts = 0
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP &&
      posts++ === 2
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    const {uris} = await press(opts(['one', 'two', 'three'], {limits: LIMITS}))
    pds.state.fail = undefined
    pds.calls.length = 0
    return {uris, record: only()}
  }

  it('Delete what was posted deletes newest first, confirms, then the gates, and ends Not posted', async () => {
    const {uris, record} = await partlyPosted()
    expect(record.present).toEqual([uris[0], uris[1]])
    await deletePostedOutboxEntry(seen(record))
    const order = deletes().map(
      c => `${String(c.body?.collection)}/${String(c.body?.rkey)}`,
    )
    expect(order.slice(0, 2)).toEqual([
      `${PP}/${record.rkeys[1]}`,
      `${PP}/${record.rkeys[0]}`,
    ])
    expect(order.slice(2).every(key => !key.startsWith(PP))).toBe(true)
    expect(pds.posts.size).toBe(0)
    expect(pds.gates.size).toBe(0)
    expect(only()).toMatchObject({state: 'failed', present: []})
    expect(only().deleting).toBeUndefined()
  })

  it('a failed post delete keeps that post and every gate: Deleting didn’t finish', async () => {
    const {uris, record} = await partlyPosted()
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.deleteRecord' &&
      call.body?.rkey === record.rkeys[0]
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    await deletePostedOutboxEntry(seen(record))
    expect(only()).toMatchObject({
      state: 'failed',
      failure: 'delete-posted',
      present: [uris[0]],
    })
    expect(deletes().filter(c => c.body?.collection !== PP)).toEqual([])
    expect(pds.gates.size).toBe(4)
    expect(notices.at(-1)?.text).toBe(
      'Some of this post couldn’t be deleted. Try again.',
    )
  })

  it('an unanswered delete leaves it undecided with lastWriteKind delete', async () => {
    const {record} = await partlyPosted()
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.deleteRecord'
        ? new TypeError('offline')
        : undefined
    await deletePostedOutboxEntry(seen(record))
    expect(only()).toMatchObject({
      state: 'undecided',
      lastWriteKind: 'delete',
      deleting: 'posted',
    })
    expect(only().settleAfter).toBeDefined()
  })

  it('Discard of a Not posted entry with an orphan threadgate deletes the gate and removes the record', async () => {
    let posts = 0
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP &&
      posts++ === 0
        ? {status: 400, body: {error: 'InvalidRecord'}}
        : undefined
    const {uris} = await press(opts(['one'], {limits: LIMITS}))
    pds.state.fail = undefined
    expect(pds.gates.size).toBe(2)
    await discardOutboxEntry(seen(only()))
    expect(records()).toEqual([])
    expect(pds.gates.size).toBe(0)
    expect(getPendingPost(uris[0])).toBeUndefined()
  })

  it('Remove from this device makes no PDS call and makes a waiting reply parent-gone (SQ-19)', async () => {
    mockLoadEncoder.mockRejectedValueOnce(new PrivateEncodeFailedError('load'))
    const parent = await press(opts(['parent']))
    const parentRecord = only()
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'parent'},
      locked: true,
    })
    await press(opts(['reply'], {replyTo: parent.uris[0]}))
    const reply = records().find(r => r.id !== parentRecord.id)!
    expect(reply).toMatchObject({state: 'failed', failure: 'parent-not-posted'})
    pds.calls.length = 0
    await removeOutboxEntryFromDevice(seen(parentRecord))
    await settle()
    expect(pds.calls).toEqual([])
    expect(readOutboxRecord(DID, parentRecord.id)).toBeUndefined()
    expect(readOutboxRecord(DID, reply.id)?.failure).toBe('parent-gone')
  })
})

describe('a reply behind a failed parent (PA-28 step 2)', () => {
  it('fails before any read or write, then gets its Retry once the parent is posted', async () => {
    mockLoadEncoder.mockRejectedValueOnce(new PrivateEncodeFailedError('load'))
    setOutboxPaused(true)
    const parent = await postPrivate(queryClient, opts(['parent']))
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'parent'},
      locked: true,
    })
    await postPrivate(queryClient, opts(['reply'], {replyTo: parent.uris[0]}))
    setOutboxPaused(false)
    await whenOutboxIdle()
    await settle()
    const [parentRecord, reply] = records()
    expect(reply).toMatchObject({state: 'failed', failure: 'parent-not-posted'})
    expect(postWrites()).toEqual([])
    expect(
      outboxEntryActions(
        {
          record: reply,
          holdsCapture: true,
          runningHere: false,
          runningElsewhere: false,
        },
        getWriteRoute(DID),
        {inUnsent: false},
      ).retry,
    ).toBeUndefined()
    await retryOutboxEntry(seen(parentRecord))
    await whenOutboxIdle()
    await settle(20)
    const cleared = readOutboxRecord(DID, reply.id)!
    expect(cleared.failure).toBeUndefined()
    await retryOutboxEntry(seen(cleared))
    await whenOutboxIdle()
    await settle()
    expect(records()).toEqual([])
    const replyRecord = postWrites()[1].body?.record as {
      reply: {parent: {uri: string}}
    }
    expect(replyRecord.reply.parent.uri).toBe(parent.uris[0])
  })
})

describe('a reply prism cannot place (busy design 9, T-11)', () => {
  const PARENT = `at://${OTHER_DID}/${PP}/3kotherpar22`
  const OTHER_AUDIENCE = `at://${OTHER_DID}/${AUD}/3kotheraud22`
  const BUSY =
    'Couldn’t reach the post you’re replying to. Try again in a moment.'

  function parentView() {
    return {
      uri: PARENT,
      cid: cids[38],
      author: {did: OTHER_DID, handle: 'bob.test'},
      record: {
        $type: PP,
        text: 'parent',
        createdAt: '2026-10-15T12:00:00.000Z',
        audienceList: OTHER_AUDIENCE,
      },
      indexedAt: '2026-10-15T12:00:00.000Z',
      labels: [],
    }
  }

  /** prism answers `getPosts` with `reply` (a promise holds it). */
  function prismAnswers(reply: () => Reply | Promise<Reply>) {
    prism = fakeClient(DID, call =>
      call.nsid === 'app.nearhorizon.private.getPosts'
        ? reply()
        : {status: 200, body: {status: 'indexed'}},
    )
    mockPrismClient = prism.client
    publish()
  }

  const serving = () => ({status: 200, body: {posts: [parentView()]}})

  function actionsOf(record: OutboxRecord) {
    return outboxEntryActions(
      {
        record,
        holdsCapture: true,
        runningHere: false,
        runningElsewhere: false,
      },
      getWriteRoute(DID),
      {inUnsent: true},
    )
  }

  function replyAsParent() {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'parent'},
      locked: true,
    })
  }

  beforeEach(() => {
    resetPrismHealth()
    resetKnown()
  })

  it.each([
    [
      '503 Reindexing',
      {status: 503, body: {error: 'Reindexing', retryAfter: 30}},
    ],
    ['a 500', {status: 500, body: {error: 'InternalServerError'}}],
    ['a network failure', new TypeError('Network request failed')],
  ] as [string, Reply][])(
    'a planning read failing with %s fails at once as parent-busy: nothing written, the lock released, Retry, Edit and Discard',
    async (_name, reply) => {
      prismAnswers(() => reply)
      replyAsParent()
      await press(opts(['reply'], {replyTo: PARENT}))
      const record = only()
      expect(record).toMatchObject({
        state: 'failed',
        failure: 'parent-busy',
        present: [],
      })
      expect(postWrites()).toEqual([])
      expect(Array.from(await heldLockNames())).not.toContain(
        runLockName(record.id),
      )
      const actions = actionsOf(record)
      expect(actions.detail).toBe(BUSY)
      expect(actions.retry).toEqual({finish: false, disabled: false})
      expect(actions.edit).toBe(true)
      expect(actions.discard).toBe(true)
    },
  )

  it('a planning read that outlasts the call timeout is parent-busy', async () => {
    OUTBOX_TIMING.callMs = 50
    let release: (reply: Reply) => void = () => {}
    prismAnswers(() => new Promise<Reply>(resolve => (release = resolve)))
    replyAsParent()
    await press(opts(['reply'], {replyTo: PARENT}))
    expect(only()).toMatchObject({state: 'failed', failure: 'parent-busy'})
    // Answer the read the timeout gave up on, so its deadline timer ends.
    release({status: 200, body: {posts: []}})
    await settle()
  })

  it('another author’s parent left out of a healthy answer is parent-busy, never "may have been deleted", and adds no suspect; Retry posts once prism serves it', async () => {
    prismAnswers(() => ({status: 200, body: {posts: []}}))
    replyAsParent()
    await press(opts(['reply'], {replyTo: PARENT}))
    const record = only()
    expect(record.failure).toBe('parent-busy')
    expect(actionsOf(record).detail).not.toMatch(/deleted/)
    expect(missVerdict(DID, PARENT)).toBe('unknown')
    // No PDS read of another author.
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.getRecord')

    prismAnswers(serving)
    await retryOutboxEntry(seen(record))
    await whenOutboxIdle()
    await settle()
    expect(records()).toEqual([])
    const written = postWrites()[0].body?.record as {
      audienceList: string
      reply: {parent: {uri: string}}
    }
    expect(written.reply.parent.uri).toBe(PARENT)
    expect(written.audienceList).toBe(OTHER_AUDIENCE)
  })

  it('a reply to the failed reply ends parent-not-posted at once; a top-level post pressed after both posts at once', async () => {
    prismAnswers(() => ({status: 503, body: {error: 'Reindexing'}}))
    replyAsParent()
    const first = await press(opts(['reply'], {replyTo: PARENT}))
    await press(opts(['reply to reply'], {replyTo: first.uris[0]}))
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    const top = await press(opts(['top level']))
    const failures = records().map(r => r.failure)
    expect(failures).toEqual(['parent-busy', 'parent-not-posted'])
    expect(getPendingPost(top.uris[0])?.phase).toBe('written')
  })

  it('a Finish posting whose placement read fails transiently is parent-busy, never post, and keeps its posts (BR17-N3)', async () => {
    prismAnswers(serving)
    replyAsParent()
    let posts = 0
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP &&
      posts++ === 1
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    const {uris} = await press(opts(['one', 'two'], {replyTo: PARENT}))
    pds.state.fail = undefined
    const partly = only()
    expect(partly).toMatchObject({failure: 'post', present: [uris[0]]})
    prismAnswers(() => ({status: 503, body: {error: 'Reindexing'}}))
    await retryOutboxEntry(seen(partly))
    await whenOutboxIdle()
    await settle()
    const after = only()
    expect(after).toMatchObject({
      state: 'failed',
      failure: 'parent-busy',
      present: [uris[0]],
    })
    expect(actionsOf(after).detail).toBe(BUSY)
  })

  it('the writer’s own parent gone from their PDS fails at once as parent-unavailable', async () => {
    prismAnswers(() => ({status: 200, body: {posts: []}}))
    replyAsParent()
    await press(opts(['reply'], {replyTo: uriOf('3kowngone222')}))
    expect(only()).toMatchObject({
      state: 'failed',
      failure: 'parent-unavailable',
    })
  })

  it('a top-level post whose planning fails transiently keeps today’s failure, never parent-busy (BR18-N1)', async () => {
    pds.audiences.splice(0, pds.audiences.length)
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.listRecords'
        ? {status: 503, body: {error: 'NotEnoughResources'}}
        : undefined
    await press(opts(['top level']))
    expect(only().failure).not.toBe('parent-busy')
  })
})

describe('account switch (PA-28 step 7, K8-L3)', () => {
  it('stops before the next call with no rollback; back on the account the thread is Partly posted, and Finish posting completes it', async () => {
    const other = fakeClient(OTHER_DID, () => ({status: 500, body: {}}))
    let posts = 0
    pds.state.fail = call => {
      if (
        call.nsid === 'com.atproto.repo.createRecord' &&
        call.body?.collection === PP
      ) {
        if (posts++ === 0) {
          // The switch lands while post 1 is being written.
          publish(OTHER_DID, other.client)
        }
      }
      return undefined
    }
    const {uris} = await postPrivate(queryClient, opts(['one', 'two']))
    await sleep(20)
    await whenOutboxIdle()
    pds.state.fail = undefined
    expect(postWrites()).toHaveLength(1)
    expect(deletes()).toEqual([])
    expect(other.calls).toEqual([])
    expect(only().state).toBe('sending')
    publish()
    await outboxNextUse(DID)
    const decided = only()
    expect(decided).toMatchObject({state: 'failed', present: [uris[0]]})
    await retryOutboxEntry(seen(decided))
    await whenOutboxIdle()
    expect(records()).toEqual([])
    expect(postWrites().map(c => c.body?.rkey)).toEqual(decided.rkeys)
  })
})

describe('Edit (PA-28, K11-L3, K12-N1)', () => {
  it('after an answered failure, reads first; every post found present is done with the toast', async () => {
    pds.state.fail = call =>
      call.nsid === 'com.atproto.repo.createRecord' &&
      call.body?.collection === PP
        ? {status: 400, body: {error: 'InvalidRecord'}}
        : undefined
    const {uris} = await press(opts(['one']))
    pds.state.fail = undefined
    const record = only()
    storedPost(record.rkeys[0])
    pds.calls.length = 0
    const staged = await beginOutboxEdit(seen(record))
    expect(staged).toBeUndefined()
    expect(nsids(pds.calls)).toEqual(['com.atproto.repo.getRecord'])
    expect(records()).toEqual([])
    expect(notices.at(-1)?.text).toBe('This post was already posted.')
    expect(getPendingPost(uris[0])?.phase).toBe('written')
    expect(takeStagedOutboxEdit()).toBeUndefined()
  })

  it('after an encoder failure, needs no read, stages the entry, and its press replaces the old record', async () => {
    mockLoadEncoder.mockRejectedValueOnce(new PrivateEncodeFailedError('load'))
    await press(opts(['first draft']))
    const old = only()
    pds.calls.length = 0
    const staged = await beginOutboxEdit(seen(old))
    expect(staged).toEqual({replyTo: undefined})
    expect(pds.calls).toEqual([])
    expect(takeStagedOutboxEdit()).toBe(old.id)
    const {uris} = await press(opts(['edited']))
    expect(readOutboxRecord(DID, old.id)).toBeUndefined()
    expect(records()).toEqual([])
    expect(postWrites().map(c => c.body?.rkey)).not.toContain(old.rkeys[0])
    expect(uris[0]).not.toBe(uriOf(old.rkeys[0]))
  })
})

describe('the gates backstop (K10-L3, K11-N2)', () => {
  it('hides "Who can reply" and refuses a gate save on a sending or failed post, before any read or write', async () => {
    setOutboxPaused(true)
    const {uris} = await postPrivate(queryClient, opts(['one']))
    expect(hidesGateControls(uris[0])).toBe(true)
    const sending = await savePrivatePostGates({
      pdsClient: pds.client,
      currentDid: DID,
      postUri: uris[0],
      rootUri: uris[0],
      threadgate: [{type: 'nobody'}],
    }).catch((e: unknown) => e)
    expect(sending).toBeInstanceOf(PrivatePostPendingError)
    expect((sending as PrivatePostPendingError).phase).toBe('sending')
    mockLoadEncoder.mockRejectedValueOnce(new PrivateEncodeFailedError('load'))
    setOutboxPaused(false)
    await whenOutboxIdle()
    const failed = await savePrivatePostGates({
      pdsClient: pds.client,
      currentDid: DID,
      postUri: uris[0],
      rootUri: uris[0],
      threadgate: [{type: 'nobody'}],
    }).catch((e: unknown) => e)
    expect((failed as PrivatePostPendingError).message).toBe(
      'This post wasn’t fully posted. Finish or delete it in Unsent.',
    )
    expect(
      pds.calls.filter(
        c => c.body?.collection === TG || c.params.get('collection') === TG,
      ),
    ).toEqual([])
    expect(mockGateUpsert).not.toHaveBeenCalled()
  })
})

describe('Unsent’s table (8.4, T-31)', () => {
  it('offers Retry, Edit and Discard on Not posted; withholds Retry off route encode and when media were dropped', () => {
    const record = storeRecord({
      rkeys: ['3khhhh1'],
      state: 'failed',
      present: [],
    })
    const view = {
      record,
      holdsCapture: false,
      runningHere: false,
      runningElsewhere: false,
    }
    expect(
      outboxEntryActions(view, getWriteRoute(DID), {inUnsent: true}),
    ).toMatchObject({
      label: 'Not posted',
      retry: {finish: false, disabled: false},
      edit: true,
      discard: true,
      remove: true,
    })
    expect(
      outboxEntryActions(
        view,
        {...getWriteRoute(DID), postingRoute: 'none'},
        {inUnsent: false},
      ),
    ).toMatchObject({retry: {disabled: true}, remove: false})
    const withMedia = {
      ...record,
      posts: [
        {
          ...record.posts[0],
          media: {images: 1, video: false},
          spoilers: {imageCount: 1, images: [0], video: false},
        },
      ],
    }
    expect(
      outboxEntryActions({...view, record: withMedia}, getWriteRoute(DID), {
        inUnsent: true,
      }),
    ).toMatchObject({
      retry: undefined,
      edit: true,
      note: 'Images or video need adding again. Mark them as spoilers again.',
    })
  })

  it('offers Check now and Discard, no Retry or Edit, on an undecided entry', () => {
    const record = storeRecord({rkeys: ['3kiiii1'], state: 'undecided'})
    expect(
      outboxEntryActions(
        {
          record,
          holdsCapture: false,
          runningHere: false,
          runningElsewhere: false,
        },
        getWriteRoute(DID),
        {inUnsent: true},
      ),
    ).toMatchObject({
      label: 'Checking whether this was posted...',
      checkNow: true,
      discard: true,
      edit: false,
    })
  })

  it('lists failed and undecided entries but not this tab’s running ones', async () => {
    storeRecord({rkeys: ['3kjjjj1'], state: 'failed', present: []})
    setOutboxPaused(true)
    await postPrivate(queryClient, opts(['running here']))
    const unsent = listUnsent(DID, await heldLockNames())
    expect(unsent.map(view => view.record.state)).toEqual(['failed'])
  })
})

describe('an account removed from the device (K8-N3, K9-N7)', () => {
  it('takes its records and draft tables with it, but not a record another tab is running', async () => {
    const removed = 'did:plc:removedcccccccccccccccc'
    const kept = storeRecord({rkeys: ['3kkkkk1'], did: removed, id: 'keptone'})
    storeRecord({rkeys: ['3kkkkk2'], did: removed, id: 'goneone'})
    writeLocal(`horizon:draft-visibility:${removed}`, '[]')
    const held = await tryRunLock(runLockName(kept.id))
    await forgetRemovedAccount(removed)
    expect(readOutboxRecord(removed, 'goneone')).toBeUndefined()
    expect(readOutboxRecord(removed, 'keptone')).toBeDefined()
    held?.release()
    // A released Web Lock is free once its request settles.
    await settle()
    await forgetRemovedAccount(removed)
    expect(readOutboxRecord(removed, 'keptone')).toBeUndefined()
    expect(readLocal(`horizon:draft-visibility:${removed}`)).toBeUndefined()
  })
})

describe('the reply block check (reply design 2, skydeval 2026-10-23)', () => {
  const PARENT = `at://${OTHER_DID}/${PP}/3kblockpar22`
  const OTHER_AUDIENCE = `at://${OTHER_DID}/${AUD}/3kotheraud22`
  const BLOCK_URI = `at://${OTHER_DID}/app.bsky.graph.block/3kblock22222`
  const BLOCKED = 'You can’t reply to this post.'
  const BUSY =
    'Couldn’t reach the post you’re replying to. Try again in a moment.'

  function servePrism() {
    prism = fakeClient(DID, call =>
      call.nsid === 'app.nearhorizon.private.getPosts'
        ? {
            status: 200,
            body: {
              posts: [
                {
                  uri: PARENT,
                  cid: cids[38],
                  author: {did: OTHER_DID, handle: 'bob.test'},
                  record: {
                    $type: PP,
                    text: 'parent',
                    createdAt: '2026-10-15T12:00:00.000Z',
                    audienceList: OTHER_AUDIENCE,
                  },
                  indexedAt: '2026-10-15T12:00:00.000Z',
                  labels: [],
                },
              ],
            },
          }
        : {status: 200, body: {status: 'indexed'}},
    )
    mockPrismClient = prism.client
    publish()
  }

  function anyWrites() {
    return pds.calls.filter(
      c =>
        c.nsid === 'com.atproto.repo.createRecord' ||
        c.nsid === 'com.atproto.repo.putRecord',
    )
  }

  function actionsOf(record: OutboxRecord) {
    return outboxEntryActions(
      {record, holdsCapture: true, runningHere: false, runningElsewhere: false},
      getWriteRoute(DID),
      {inUnsent: true},
    )
  }

  beforeEach(() => {
    resetPrismHealth()
    resetKnown()
    servePrism()
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'parent'},
      locked: true,
    })
    mockResolveEmbed.mockClear()
  })

  it.each([
    ['blocks the member', {blockedBy: BLOCK_URI}],
    ['is blocked by the member', {blocking: BLOCK_URI}],
    ['list-blocks the member', {blockedByList: BLOCK_URI}],
    ['is list-blocked by the member', {blockingByList: BLOCK_URI}],
  ])(
    'a parent whose author %s fails at once as reply-blocked: no upload, gate or post, with Retry, Edit and Discard',
    async (_name, fields) => {
      relationships = call => relationshipsReply(call, fields)
      await press(opts(['reply'], {replyTo: PARENT, limits: LIMITS}))
      const record = only()
      expect(record).toMatchObject({
        state: 'failed',
        failure: 'reply-blocked',
        present: [],
      })
      expect(anyWrites()).toEqual([])
      expect(mockResolveEmbed).not.toHaveBeenCalled()
      const actions = actionsOf(record)
      expect(actions.detail).toBe(BLOCKED)
      expect(actions.retry).toEqual({finish: false, disabled: false})
      expect(actions.edit).toBe(true)
      expect(actions.discard).toBe(true)
      // The record round-trips with its failure kept.
      expect(readOutboxRecord(DID, record.id)?.failure).toBe('reply-blocked')
    },
  )

  it('a check that cannot be made fails as parent-busy with nothing written; Retry posts once the AppView answers', async () => {
    relationships = () => ({status: 502, body: {error: 'UpstreamFailure'}})
    await press(opts(['reply'], {replyTo: PARENT, limits: LIMITS}))
    const record = only()
    expect(record).toMatchObject({state: 'failed', failure: 'parent-busy'})
    expect(actionsOf(record).detail).toBe(BUSY)
    expect(anyWrites()).toEqual([])

    relationships = call => relationshipsReply(call)
    await retryOutboxEntry(seen(record))
    await whenOutboxIdle()
    await settle()
    expect(records()).toEqual([])
    expect(postWrites()).toHaveLength(1)
  })

  it('a block made during the uploads is reply-blocked, with no gate or post written (PR2-L1)', async () => {
    REPLY_BLOCK_TIMING.freshMs = 0
    let uploaded = false
    mockResolveEmbed.mockImplementation(() => {
      uploaded = true
      return Promise.resolve(undefined)
    })
    relationships = call =>
      relationshipsReply(call, uploaded ? {blockedBy: BLOCK_URI} : {})
    await press(opts(['reply'], {replyTo: PARENT, limits: LIMITS}))
    expect(only()).toMatchObject({state: 'failed', failure: 'reply-blocked'})
    expect(uploaded).toBe(true)
    expect(anyWrites()).toEqual([])
    mockResolveEmbed.mockImplementation(() => Promise.resolve(undefined))
  })

  it('the AppView failing at the recheck after the uploads: parent-busy, nothing written', async () => {
    REPLY_BLOCK_TIMING.freshMs = 0
    let uploaded = false
    mockResolveEmbed.mockImplementation(() => {
      uploaded = true
      return Promise.resolve(undefined)
    })
    relationships = call =>
      uploaded ? {status: 500, body: {}} : relationshipsReply(call)
    await press(opts(['reply'], {replyTo: PARENT, limits: LIMITS}))
    const record = only()
    expect(record).toMatchObject({state: 'failed', failure: 'parent-busy'})
    expect(actionsOf(record).detail).toBe(BUSY)
    expect(anyWrites()).toEqual([])
    mockResolveEmbed.mockImplementation(() => Promise.resolve(undefined))
  })

  it('the verdict still fresh after the uploads: the AppView is asked once, and nothing reads a PDS listing', async () => {
    await press(opts(['reply'], {replyTo: PARENT, limits: LIMITS}))
    expect(records()).toEqual([])
    expect(postWrites()).toHaveLength(1)
    expect(
      nsids(appview.calls).filter(n => n === 'app.bsky.graph.getRelationships'),
    ).toHaveLength(1)
    expect(
      pds.calls.filter(
        c =>
          c.nsid === 'com.atproto.repo.listRecords' &&
          c.params.get('collection') !== AUD,
      ),
    ).toEqual([])
  })

  it('a reply to the member’s own post asks the AppView nothing', async () => {
    relationships = () => ({status: 500, body: {}})
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    const first = await press(opts(['mine']))
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'parent'},
      locked: true,
    })
    await press(opts(['reply to mine'], {replyTo: first.uris[0]}))
    expect(records()).toEqual([])
    expect(nsids(appview.calls)).not.toContain(
      'app.bsky.graph.getRelationships',
    )
  })

  describe('again before the first post write (RB-13, R10)', () => {
    function relationshipCalls() {
      return appview.calls.filter(
        c => c.nsid === 'app.bsky.graph.getRelationships',
      )
    }

    /** Clear for the plan and the re-check after uploads, then `third`. */
    function answerFromThird(third: (call: Call) => Reply) {
      let n = 0
      relationships = call => {
        if (call.nsid !== 'app.bsky.graph.getRelationships') return undefined
        n++
        return n >= 3 ? third(call) : relationshipsReply(call)
      }
    }

    beforeEach(() => {
      // Every check reads: the plan, after the uploads, before the post.
      REPLY_BLOCK_TIMING.freshMs = 0
      REPLY_BLOCK_TIMING.prePostFreshMs = 0
    })

    it('a block appearing after the gates: failed reply-blocked at once, the gates written, no post, never undecided', async () => {
      answerFromThird(
        call => relationshipsReply(call, {blockedBy: BLOCK_URI}) as Reply,
      )
      await press(opts(['reply'], {replyTo: PARENT, limits: LIMITS}))
      const record = only()
      expect(record).toMatchObject({
        state: 'failed',
        failure: 'reply-blocked',
        present: [],
      })
      expect(record.lastWriteAt).toBeUndefined()
      expect(relationshipCalls()).toHaveLength(3)
      expect(pds.gates.size).toBe(1)
      expect(postWrites()).toEqual([])
    })

    it('the same with no gates to write: reply-blocked at once, no post', async () => {
      answerFromThird(
        call => relationshipsReply(call, {blockedBy: BLOCK_URI}) as Reply,
      )
      await press(opts(['reply'], {replyTo: PARENT}))
      expect(only()).toMatchObject({state: 'failed', failure: 'reply-blocked'})
      expect(relationshipCalls()).toHaveLength(3)
      expect(anyWrites()).toEqual([])
    })

    it('the check cannot be made before the post: failed parent-busy at once', async () => {
      answerFromThird(() => ({
        status: 500,
        body: {error: 'InternalServerError'},
      }))
      await press(opts(['reply'], {replyTo: PARENT, limits: LIMITS}))
      const record = only()
      expect(record).toMatchObject({state: 'failed', failure: 'parent-busy'})
      expect(record.lastWriteAt).toBeUndefined()
      expect(postWrites()).toEqual([])
    })

    it('fast gates, within prePostFreshMs: no third read, and the reply posts', async () => {
      REPLY_BLOCK_TIMING.prePostFreshMs = 10_000
      answerFromThird(
        call => relationshipsReply(call, {blockedBy: BLOCK_URI}) as Reply,
      )
      await press(opts(['reply'], {replyTo: PARENT, limits: LIMITS}))
      expect(records()).toEqual([])
      expect(relationshipCalls()).toHaveLength(2)
      expect(postWrites()).toHaveLength(1)
    })

    it('the member’s own parent in the owner’s thread, the owner blocking the member: reply-blocked, nothing uploaded or written', async () => {
      REPLY_BLOCK_TIMING.freshMs = 2_000
      REPLY_BLOCK_TIMING.prePostFreshMs = 10_000
      storedPost('3kownreply22', {
        reply: {
          root: {uri: PARENT, cid: cids[38]},
          parent: {uri: PARENT, cid: cids[38]},
        },
      })
      relationships = call => relationshipsReply(call, {blockedBy: BLOCK_URI})
      await press(
        opts(['reply'], {replyTo: uriOf('3kownreply22'), limits: LIMITS}),
      )
      expect(only()).toMatchObject({state: 'failed', failure: 'reply-blocked'})
      expect(relationshipCalls().map(c => c.params.getAll('others'))).toEqual([
        [OTHER_DID],
      ])
      expect(mockResolveEmbed).not.toHaveBeenCalled()
      expect(anyWrites()).toEqual([])
    })
  })
})
