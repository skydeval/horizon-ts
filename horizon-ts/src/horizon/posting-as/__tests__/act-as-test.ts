import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * Act as another signed-in account on like, repost and follow (Phase 5
 * design 8.6, B-19; section 13 and live check L11): every write goes to the
 * acting account's own repo through its temporary client, server-keyed;
 * nothing reaches the current account's or a third account's repo; the
 * state shown is the acting account's own, kept apart from the current
 * account's post and profile shadows; no preferences are read or written;
 * a kryphocron post is acted on only when prism serves it to that account.
 * The temporary client is replaced by each fake account's client.
 */
const mockAccounts: Record<string, unknown>[] = []
jest.mock('#/state/persisted', () => ({
  get: (key: string) =>
    key === 'session' ? {accounts: mockAccounts} : undefined,
  write: () => Promise.resolve(),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: [], currentAccount: undefined}),
  useMaybePdsClient: () => null,
}))
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => Promise.reject(new Error('no network in tests')),
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
// The current account's shadows: an act-as action must never touch them.
const mockPostShadow = jest.fn()
const mockProfileShadow = jest.fn()
jest.mock('#/state/cache/post-shadow', () => ({
  updatePostShadow: (...args: unknown[]) => mockPostShadow(...args),
}))
jest.mock('#/state/cache/profile-shadow', () => ({
  updateProfileShadow: (...args: unknown[]) => mockProfileShadow(...args),
}))
const mockTemps = new Map<
  string,
  {
    did: string
    handle: string
    pdsClient: unknown
    appviewClient: unknown
    chatClient: unknown
    prismClient: unknown
  }
>()
const mockHolds: {did: string; op: 'acquire' | 'release'; identity: boolean}[] =
  []
jest.mock('#/horizon/posting-as/temp-client', () => {
  const actual = jest.requireActual<Record<string, unknown>>(
    '#/horizon/posting-as/temp-client',
  )
  return {
    ...actual,
    acquireTemporaryClient: (did: string, hold?: {identity?: boolean}) => {
      const held = mockTemps.get(did)
      if (!held) {
        const {TemporaryClientUnavailableError} = actual as {
          TemporaryClientUnavailableError: new (did: string) => Error
        }
        throw new TemporaryClientUnavailableError(did)
      }
      mockHolds.push({did, op: 'acquire', identity: hold?.identity ?? true})
      return held
    },
    releaseTemporaryClient: (did: string, hold?: {identity?: boolean}) => {
      mockHolds.push({did, op: 'release', identity: hold?.identity ?? true})
    },
  }
})

import {i18n} from '@lingui/core'

import {RECORD_CID, type Reply} from '#/horizon/private/__tests__/fixtures'
import {
  ActAsRefusedError,
  getActAs,
  holdActAsClients,
  loadActAsPost,
  loadActAsProfile,
  resetActAs,
  toggleActAs,
} from '../act-as'
import {
  callsOf,
  type FakeAccount,
  fakeAccount,
  LOCUS_URL,
  MAIN,
  OTHER,
  publishCurrent,
  settle,
  STOCKY,
  STRANGER,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const POST_URI = `at://${STRANGER}/app.bsky.feed.post/3kpostaaaa222`
const PRIVATE_URI = `at://${STRANGER}/tools.kryphocron.feed.postPrivate/3kprivaaaa222`
const post = {uri: POST_URI, cid: RECORD_CID}
const privatePost = {uri: PRIVATE_URI, cid: RECORD_CID}

/** Every write a repo can receive. */
const WRITES = [
  'com.atproto.repo.createRecord',
  'com.atproto.repo.putRecord',
  'com.atproto.repo.deleteRecord',
  'com.atproto.repo.applyWrites',
]

function writesOf(account: FakeAccount) {
  return account.calls.filter(call => WRITES.includes(call.nsid))
}

function postView(
  uri: string,
  viewer: Record<string, unknown> = {},
  authorViewer: Record<string, unknown> = {},
) {
  return {
    uri,
    cid: RECORD_CID,
    author: {did: STRANGER, handle: 'stranger.test', viewer: authorViewer},
    record: {},
    indexedAt: '2026-10-01T00:00:00.000Z',
    labels: [],
    viewer,
  }
}

/**
 * Give `account` an AppView, prism and repo for act-as: `getPosts` and
 * prism's `getPosts` answer `views`, `getProfile` answers `profile`, and
 * `createRecord` and `deleteRecord` write into `records`.
 */
function serve(
  account: FakeAccount,
  {
    views = [],
    privateViews = [],
    profileViewer = {},
    fail,
  }: {
    views?: unknown[]
    privateViews?: unknown[]
    profileViewer?: Record<string, unknown>
    fail?: (nsid: string) => Reply | undefined
  } = {},
) {
  let n = 0
  account.fail = call => {
    const failure = fail?.(call.nsid)
    if (failure) return failure
    switch (call.nsid) {
      case 'app.bsky.feed.getPosts':
        return {status: 200, body: {posts: views}}
      case 'app.nearhorizon.private.getPosts':
        return {status: 200, body: {posts: privateViews}}
      case 'app.bsky.actor.getProfile':
        return {
          status: 200,
          body: {
            did: STRANGER,
            handle: 'stranger.test',
            viewer: profileViewer,
          },
        }
      case 'com.atproto.repo.createRecord': {
        const body = call.body as {repo: string; collection: string}
        n++
        return {
          status: 200,
          body: {
            uri: `at://${body.repo}/${body.collection}/3kserveraaaa${'234567abcdefghij'[n]}`,
            cid: RECORD_CID,
          },
        }
      }
      case 'com.atproto.repo.deleteRecord':
        return {status: 200, body: {}}
      default:
        return undefined
    }
  }
}

let main: FakeAccount
let other: FakeAccount
let stocky: FakeAccount

function temp(account: FakeAccount, handle: string) {
  mockTemps.set(account.did, {
    did: account.did,
    handle,
    pdsClient: account.client,
    appviewClient: account.client,
    chatClient: account.client,
    prismClient: account.client,
  })
}

beforeEach(() => {
  resetActAs()
  mockTemps.clear()
  mockHolds.length = 0
  mockPostShadow.mockReset()
  mockProfileShadow.mockReset()
  main = fakeAccount(MAIN)
  other = fakeAccount(OTHER)
  stocky = fakeAccount(STOCKY)
  serve(main, {views: [postView(POST_URI)]})
  serve(other, {views: [postView(POST_URI)]})
  serve(stocky, {views: [postView(POST_URI)]})
  publishCurrent(main, LOCUS_URL, 'main.test')
  temp(other, 'other.test')
  temp(stocky, 'stocky.test')
})

describe('a like as another account (8.6)', () => {
  it('writes to that account’s repo only, server-keyed, through its own client', async () => {
    await loadActAsPost(OTHER, post)
    await expect(toggleActAs(OTHER, 'like', post)).resolves.toBe(true)

    const creates = callsOf(other, 'com.atproto.repo.createRecord')
    expect(creates).toHaveLength(1)
    const body = creates[0].body as Record<string, unknown>
    expect(body.repo).toBe(OTHER)
    expect(body.collection).toBe('app.bsky.feed.like')
    // Server-keyed: no rkey, so no client clock is involved.
    expect('rkey' in body).toBe(false)
    const record = body.record as Record<string, unknown>
    expect(record.subject).toEqual({uri: POST_URI, cid: RECORD_CID})
    expect('via' in record).toBe(false)

    // Nothing reaches the current account, nor a third account.
    expect(main.calls).toEqual([])
    expect(stocky.calls).toEqual([])
    // The client was held only for the action, with identity reads left on prism.
    expect(mockHolds.every(hold => hold.did === OTHER)).toBe(true)
    expect(mockHolds.every(hold => !hold.identity)).toBe(true)
    expect(mockHolds.filter(hold => hold.op === 'acquire')).toHaveLength(
      mockHolds.filter(hold => hold.op === 'release').length,
    )
  })

  it('reposts and follows go to that account’s repo the same way', async () => {
    await loadActAsPost(OTHER, post)
    await toggleActAs(OTHER, 'repost', post)
    await loadActAsProfile(OTHER, STRANGER)
    await toggleActAs(OTHER, 'follow', STRANGER)

    const creates = callsOf(other, 'com.atproto.repo.createRecord').map(
      call => call.body as Record<string, unknown>,
    )
    expect(creates.map(body => body.collection)).toEqual([
      'app.bsky.feed.repost',
      'app.bsky.graph.follow',
    ])
    for (const body of creates) {
      expect(body.repo).toBe(OTHER)
      expect('rkey' in body).toBe(false)
    }
    expect((creates[1].record as Record<string, unknown>).subject).toBe(
      STRANGER,
    )
    expect(main.calls).toEqual([])
    expect(stocky.calls).toEqual([])
  })

  it('an undo deletes that account’s own record, in its repo', async () => {
    const own = `at://${OTHER}/app.bsky.feed.like/3kownlikea222`
    serve(other, {views: [postView(POST_URI, {like: own})]})
    await loadActAsPost(OTHER, post)
    await expect(toggleActAs(OTHER, 'like', post)).resolves.toBe(false)
    const deletes = callsOf(other, 'com.atproto.repo.deleteRecord')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].body).toMatchObject({
      repo: OTHER,
      collection: 'app.bsky.feed.like',
      rkey: '3kownlikea222',
    })
    expect(writesOf(main)).toEqual([])
    expect(writesOf(stocky)).toEqual([])
  })

  it('a like URI outside the acting account’s repo is never read as its own, nor deleted', async () => {
    const foreign = `at://${MAIN}/app.bsky.feed.like/3kmainlike222`
    serve(other, {views: [postView(POST_URI, {like: foreign})]})
    await loadActAsPost(OTHER, post)
    expect(getActAs(OTHER, POST_URI)).toMatchObject({status: 'ready'})
    expect((getActAs(OTHER, POST_URI) as {like?: string}).like).toBeUndefined()
    await toggleActAs(OTHER, 'like', post)
    expect(callsOf(other, 'com.atproto.repo.deleteRecord')).toEqual([])
    expect(writesOf(main)).toEqual([])
  })

  it('a client whose session is another account’s is refused before any write', async () => {
    await loadActAsPost(OTHER, post)
    const swapped = {
      did: OTHER,
      handle: 'other.test',
      pdsClient: stocky.client,
      appviewClient: stocky.client,
      chatClient: stocky.client,
      prismClient: stocky.client,
    }
    mockTemps.set(OTHER, swapped)
    await expect(toggleActAs(OTHER, 'like', post)).rejects.toThrow(
      'the session does not match',
    )
    expect(stocky.calls).toEqual([])
    expect(writesOf(other)).toEqual([])
    resetActAs()
    mockTemps.set(OTHER, {
      did: OTHER,
      handle: 'other.test',
      pdsClient: stocky.client,
      appviewClient: stocky.client,
      chatClient: stocky.client,
      prismClient: stocky.client,
    })
    await loadActAsPost(OTHER, post)
    expect(getActAs(OTHER, POST_URI)).toEqual({status: 'error'})
    await expect(toggleActAs(OTHER, 'like', post)).rejects.toBeInstanceOf(
      ActAsRefusedError,
    )
    expect(stocky.calls).toEqual([])
  })

  it('an account that cannot act here is refused, and nothing is sent', async () => {
    mockTemps.delete(OTHER)
    await loadActAsPost(OTHER, post)
    await expect(toggleActAs(OTHER, 'like', post)).rejects.toBeInstanceOf(
      ActAsRefusedError,
    )
    expect(main.calls).toEqual([])
    expect(other.calls).toEqual([])
  })
})

describe('the shadow is the acting account’s (8.6)', () => {
  it('the like shows for the account that acted only, and the current account’s shadows are untouched', async () => {
    await loadActAsPost(OTHER, post)
    await loadActAsPost(STOCKY, post)
    const pending = toggleActAs(OTHER, 'like', post)
    // At once, before the write answers.
    expect(getActAs(OTHER, POST_URI)).toMatchObject({like: 'pending'})
    expect(getActAs(STOCKY, POST_URI)).not.toMatchObject({like: 'pending'})
    await pending
    const liked = getActAs(OTHER, POST_URI) as {like?: string}
    expect(liked.like).toMatch(new RegExp(`^at://${OTHER}/app.bsky.feed.like/`))
    expect((getActAs(STOCKY, POST_URI) as {like?: string}).like).toBeUndefined()
    expect(getActAs(MAIN, POST_URI)).toBeUndefined()
    expect(mockPostShadow).not.toHaveBeenCalled()
    expect(mockProfileShadow).not.toHaveBeenCalled()
  })

  it('a follow shows for the account that acted only', async () => {
    await loadActAsProfile(OTHER, STRANGER)
    await loadActAsProfile(STOCKY, STRANGER)
    await toggleActAs(OTHER, 'follow', STRANGER)
    expect(
      (getActAs(OTHER, STRANGER) as {following?: string}).following,
    ).toMatch(new RegExp(`^at://${OTHER}/app.bsky.graph.follow/`))
    expect(
      (getActAs(STOCKY, STRANGER) as {following?: string}).following,
    ).toBeUndefined()
    expect(mockProfileShadow).not.toHaveBeenCalled()
    expect(mockPostShadow).not.toHaveBeenCalled()
  })

  it('reads the state as that account: its own like, not the current account’s', async () => {
    const own = `at://${OTHER}/app.bsky.feed.like/3kownlikea222`
    serve(main, {
      views: [postView(POST_URI, {like: `at://${MAIN}/app.bsky.feed.like/x`})],
    })
    serve(other, {views: [postView(POST_URI, {like: own})]})
    await loadActAsPost(OTHER, post)
    await loadActAsPost(STOCKY, post)
    expect((getActAs(OTHER, POST_URI) as {like?: string}).like).toBe(own)
    expect((getActAs(STOCKY, POST_URI) as {like?: string}).like).toBeUndefined()
    expect(main.calls).toEqual([])
  })

  it('a failed write rolls back to what that account had', async () => {
    serve(other, {
      views: [postView(POST_URI)],
      fail: nsid =>
        nsid === 'com.atproto.repo.createRecord'
          ? {status: 500, body: {error: 'InternalServerError'}}
          : undefined,
    })
    await loadActAsPost(OTHER, post)
    await expect(toggleActAs(OTHER, 'like', post)).rejects.toThrow()
    expect(getActAs(OTHER, POST_URI)).toMatchObject({status: 'ready'})
    expect((getActAs(OTHER, POST_URI) as {like?: string}).like).toBeUndefined()
  })

  it('a read landing while a write is in flight does not overwrite it', async () => {
    let answer: (reply: Reply) => void = () => {}
    await loadActAsPost(OTHER, post)
    other.fail = call => {
      if (call.nsid === 'com.atproto.repo.createRecord') {
        return new Promise<Reply>(resolve => {
          answer = resolve
        })
      }
      if (call.nsid === 'app.bsky.feed.getPosts') {
        return {status: 200, body: {posts: [postView(POST_URI)]}}
      }
      return undefined
    }
    const pending = toggleActAs(OTHER, 'like', post)
    await settle()
    await loadActAsPost(OTHER, post)
    expect(getActAs(OTHER, POST_URI)).toMatchObject({like: 'pending'})
    answer({
      status: 200,
      body: {
        uri: `at://${OTHER}/app.bsky.feed.like/3kserverlike2`,
        cid: RECORD_CID,
      },
    })
    await pending
    expect((getActAs(OTHER, POST_URI) as {like?: string}).like).toBe(
      `at://${OTHER}/app.bsky.feed.like/3kserverlike2`,
    )
  })
})

describe('no preferences read or written, no client-minted key', () => {
  it('liking, reposting and following as another account never touches preferences', async () => {
    await loadActAsPost(OTHER, post)
    await toggleActAs(OTHER, 'like', post)
    await toggleActAs(OTHER, 'repost', post)
    await loadActAsProfile(OTHER, STRANGER)
    await toggleActAs(OTHER, 'follow', STRANGER)
    await toggleActAs(OTHER, 'like', post)
    for (const account of [main, other, stocky]) {
      expect(callsOf(account, 'app.bsky.actor.putPreferences')).toEqual([])
      expect(callsOf(account, 'app.bsky.actor.getPreferences')).toEqual([])
    }
    for (const call of callsOf(other, 'com.atproto.repo.createRecord')) {
      expect('rkey' in (call.body as object)).toBe(false)
    }
    expect(other.prefs).toEqual([])
  })
})

describe('kryphocron posts (8.6)', () => {
  it('liked as another account only when prism serves the post to that account', async () => {
    serve(other, {privateViews: []})
    await loadActAsPost(OTHER, privatePost)
    expect(getActAs(OTHER, PRIVATE_URI)).toEqual({
      status: 'refused',
      reason: 'unseen',
    })
    await expect(toggleActAs(OTHER, 'like', privatePost)).rejects.toThrow(
      'That account can’t see this post.',
    )
    expect(writesOf(other)).toEqual([])
    // Asked of prism as that account, never of the current account.
    expect(callsOf(other, 'app.nearhorizon.private.getPosts')).toHaveLength(1)
    expect(main.calls).toEqual([])
  })

  it('a kryphocron post prism serves to that account is liked in its repo', async () => {
    serve(other, {privateViews: [postView(PRIVATE_URI)]})
    await loadActAsPost(OTHER, privatePost)
    await toggleActAs(OTHER, 'like', privatePost)
    const creates = callsOf(other, 'com.atproto.repo.createRecord')
    expect(creates).toHaveLength(1)
    expect(creates[0].body).toMatchObject({
      repo: OTHER,
      collection: 'app.bsky.feed.like',
      record: {subject: {uri: PRIVATE_URI, cid: RECORD_CID}},
    })
    expect(callsOf(other, 'app.bsky.feed.getPosts')).toEqual([])
    expect(main.calls).toEqual([])
  })

  it('a public post that account’s AppView does not serve is refused the same way', async () => {
    serve(other, {views: []})
    await loadActAsPost(OTHER, post)
    await expect(toggleActAs(OTHER, 'repost', post)).rejects.toThrow(
      'That account can’t see this post.',
    )
    expect(writesOf(other)).toEqual([])
  })
})

describe('blocks, as the stock controls (8.6)', () => {
  it('a block between that account and the author refuses a like', async () => {
    serve(other, {views: [postView(POST_URI, {}, {blockedBy: true})]})
    await loadActAsPost(OTHER, post)
    await expect(toggleActAs(OTHER, 'like', post)).rejects.toThrow(
      'Cannot interact with a blocked user',
    )
    expect(writesOf(other)).toEqual([])
  })

  it('a block refuses a follow, and an account never follows itself', async () => {
    serve(other, {
      profileViewer: {blocking: `at://${OTHER}/app.bsky.graph.block/x`},
    })
    await loadActAsProfile(OTHER, STRANGER)
    await expect(toggleActAs(OTHER, 'follow', STRANGER)).rejects.toThrow(
      'Cannot interact with a blocked user',
    )
    serve(other)
    await loadActAsProfile(OTHER, OTHER)
    await expect(toggleActAs(OTHER, 'follow', OTHER)).rejects.toThrow(
      'An account can’t follow itself.',
    )
    expect(writesOf(other)).toEqual([])
  })
})

describe('the clients while the list is open', () => {
  it('holds each listed account’s client once, without its identity reads, and lets go once', () => {
    const release = holdActAsClients([OTHER, STOCKY, MAIN + 'x'])
    expect(mockHolds).toEqual([
      {did: OTHER, op: 'acquire', identity: false},
      {did: STOCKY, op: 'acquire', identity: false},
    ])
    release()
    release()
    expect(mockHolds.filter(hold => hold.op === 'release')).toEqual([
      {did: OTHER, op: 'release', identity: false},
      {did: STOCKY, op: 'release', identity: false},
    ])
  })
})
