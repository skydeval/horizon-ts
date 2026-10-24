import {beforeAll, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * Phase 5 design 8.3, 8.4, 8.5, 9, B-11, B-16, B-17 (section 13 "Posting
 * as", "Fronters fail closed", "Front update", "Private"): the fronters on
 * public and kryphocron records, the publish's client swap and its checks,
 * and the front update after a public post.
 */
const mockPostPrivate = jest.fn(() => Promise.resolve({uris: ['private']}))
jest.mock('#/horizon/private/api/writes', () => ({
  postPrivate: (...args: unknown[]) => mockPostPrivate(...(args as [])),
}))
jest.mock('#/state/gallery', () => ({compressImage: jest.fn()}))
jest.mock('#/state/queries/resolve-link', () => ({
  fetchResolveGifQuery: jest.fn(),
  fetchResolveLinkQuery: jest.fn(),
  RQKEY_LINK: (url: string) => ['resolve-link', url],
}))
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))
jest.mock('#/state/queries/profile', () => ({
  RQKEY: (did: string) => ['profile', did],
}))
jest.mock('#/lib/at-card', () => ({withCreator: jest.fn()}))
jest.mock('#/lib/api/upload-blob', () => ({uploadBlob: jest.fn()}))
jest.mock('#/state/queries/threadgate', () =>
  jest.requireActual('#/state/queries/threadgate/util'),
)
const mockToasts: unknown[] = []
jest.mock('#/components/Toast', () => ({
  show: (content: unknown) => mockToasts.push(content),
  Outer: () => null,
  Icon: () => null,
  Text: () => null,
  Action: () => null,
}))
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
  getAndMigrateDeviceId: () => Promise.resolve('device-id-1'),
}))
const mockTemps = new Map<string, Record<string, unknown>>()
const mockHolds: string[] = []
jest.mock('#/horizon/posting-as/temp-client', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '#/horizon/posting-as/temp-client',
  ),
  peekTemporaryClient: (did: string) => mockTemps.get(did),
  holdTemporaryClientUntil: (did: string) => mockHolds.push(did),
}))

import {TID} from '@atproto/common-web'
import {type Client, type LexMap} from '@atproto/lex'
import {RichText} from '@bsky/sdk/richtext'
import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {computeCid} from '#/lib/api/computeCid'
import {post} from '#/lib/api/index'
import {type ThreadDraft} from '#/view/com/composer/state/composer'
import {readFronters} from '#/horizon/identity/fronters'
import {type PluralFront, type PluralMember} from '#/horizon/identity/parse'
import {identityQueryKey} from '#/horizon/identity/queries'
import {resetIdentityReads} from '#/horizon/identity/reads'
import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'
import {EMPTY_COMPOSE_SPOILERS} from '#/horizon/media-spoilers/compose-store'
import {buildComposedPosts} from '#/horizon/private/api/compose'
import {
  assembleEncodedRecord,
  encoderContentOf,
} from '#/horizon/private/api/encoded-record'
import {
  PrivatePostInvalidError,
  validateEncodedRecord,
  validatePrivateRecord,
} from '#/horizon/private/api/validate'
import {
  PUBLIC_COMPOSE,
  setComposeVisibility,
} from '#/horizon/private/composer/state'
import {recordFronters} from '#/horizon/private/outbox/record'
import {clockIdFor} from '#/horizon/tid-clock'
import {
  resetPostingRecord,
  startPostingRecord,
  updatePosting,
} from '../compose-store'
import {postingFronters} from '../fronters'
import {ForeignAudienceError, ForeignReplyListError} from '../gates'
import {
  beginPostingPublish,
  nextFrontMembers,
  PostingAccountMismatchError,
  PostingAccountNotReadyError,
  updateFrontAfterPost,
} from '../publish'
import {
  audienceUri,
  fakeAccount,
  FRONT,
  listUri,
  LOCUS_URL,
  MAIN,
  OTHER,
  publishCurrent,
  ROBIN,
  settle,
  SPARROW,
  storedAccount,
  WREN,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const PP = 'tools.kryphocron.feed.postPrivate'

function draft(text: string) {
  return {
    id: text,
    richtext: new RichText({text}),
    labels: [],
    embed: {quote: undefined, media: undefined, link: undefined},
    shortenedGraphemeLength: text.length,
  }
}

function thread(
  texts: string[],
  threadgate: unknown[] = [{type: 'everybody'}],
): ThreadDraft {
  return {
    posts: texts.map(draft),
    postgate: {embeddingRules: []},
    threadgate,
  } as unknown as ThreadDraft
}

function member(name: string): PluralMember {
  return {
    displayName: name,
    pronouns: [],
    roles: [],
    memberTypes: [],
    raw: {displayName: name},
  }
}

/** The posting record as the reads leave it, for `did` with `rkeys` chosen. */
function chosen(did: string, rkeys: string[], listed = [WREN, SPARROW]) {
  startPostingRecord(MAIN, 'main.test')
  updatePosting({
    did,
    handle: did === MAIN ? 'main.test' : 'other.test',
    members: rkeys,
    data: {
      did,
      isSystem: true,
      members: listed.map(rkey => ({rkey, value: member(rkey)})),
    },
  })
}

let writes: {collection: string; rkey: string; value: LexMap}[]

function pdsClientFor(did: string): Client {
  return {
    assertDid: did,
    call: jest.fn((_method: unknown, input: {writes?: typeof writes}) => {
      writes.push(...(input?.writes ?? []))
      return Promise.resolve({})
    }),
  } as unknown as Client
}

const appviewClient = {
  call: jest.fn(() => Promise.resolve({})),
} as unknown as Client

beforeAll(() => {
  mockAccounts.push(
    storedAccount(MAIN, LOCUS_URL, 'main.test'),
    storedAccount(OTHER, LOCUS_URL, 'other.test'),
  )
})

beforeEach(() => {
  writes = []
  resetPostingRecord()
  resetIdentityReads()
  mockTemps.clear()
  mockHolds.length = 0
  mockToasts.length = 0
  mockPostPrivate.mockClear()
  setComposeVisibility(PUBLIC_COMPOSE)
})

describe('public posts carry the fronters (PA-3, 8.3)', () => {
  it('every post of a thread carries the key, and the next post’s parent CID covers it', async () => {
    chosen(MAIN, [SPARROW, WREN])
    await post(new QueryClient(), {
      thread: thread(['one', 'two']),
      appviewClient,
      chatClient: appviewClient,
      pdsClient: pdsClientFor(MAIN),
    })
    const posts = writes.filter(w => w.collection === 'app.bsky.feed.post')
    expect(posts).toHaveLength(2)
    for (const write of posts) {
      expect(write.value[PLURAL_FRONTERS_KEY]).toEqual({
        members: [{id: SPARROW}, {id: WREN}],
      })
      expect(readFronters(write.value)).toEqual([WREN, SPARROW].sort())
    }
    const first = posts[0].value
    const second = posts[1].value as {reply: {parent: {cid: string}}}
    expect(second.reply.parent.cid).toBe(await computeCid(first as never))
  })

  it('no member chosen writes no key', async () => {
    chosen(MAIN, [])
    await post(new QueryClient(), {
      thread: thread(['one']),
      appviewClient,
      chatClient: appviewClient,
      pdsClient: pdsClientFor(MAIN),
    })
    expect(PLURAL_FRONTERS_KEY in writes[0].value).toBe(false)
  })

  it('members chosen for another account are never written into this account’s post', async () => {
    chosen(OTHER, [WREN])
    await post(new QueryClient(), {
      thread: thread(['one']),
      appviewClient,
      chatClient: appviewClient,
      pdsClient: pdsClientFor(MAIN),
    })
    expect(PLURAL_FRONTERS_KEY in writes[0].value).toBe(false)
  })

  it('a thread posted as another account takes its rkeys from that account’s clock (PP-21)', async () => {
    chosen(OTHER, [])
    await post(new QueryClient(), {
      thread: thread(['one', 'two']),
      appviewClient,
      chatClient: appviewClient,
      pdsClient: pdsClientFor(OTHER),
    })
    await post(new QueryClient(), {
      thread: thread(['three']),
      appviewClient,
      chatClient: appviewClient,
      pdsClient: pdsClientFor(MAIN),
    })
    const posts = writes.filter(w => w.collection === 'app.bsky.feed.post')
    const clocks = posts.map(w => TID.fromStr(w.rkey).clockid())
    expect(clocks.slice(0, 2)).toEqual([clockIdFor(OTHER), clockIdFor(OTHER)])
    expect(clocks[2]).toBe(clockIdFor(MAIN))
    expect(clockIdFor(OTHER)).not.toBe(clockIdFor(MAIN))
  })

  it('fail closed: a held draft member, or one not read for this account, is dropped', () => {
    chosen(MAIN, [WREN, ROBIN])
    expect(postingFronters(undefined, MAIN)).toEqual([WREN])
    updatePosting({heldMembers: [WREN]})
    expect(postingFronters(undefined, MAIN)).toEqual([])
  })
})

describe('kryphocron posts carry the fronters in the clear (PP-7, B-11)', () => {
  const audience = audienceUri(MAIN)

  function composed(fronters: string[]) {
    return buildComposedPosts({
      posts: thread(['secret']).posts,
      resolved: [{rt: {text: 'secret'}, embed: undefined}] as never,
      audienceUri: audience,
      langs: undefined,
      composeSpoilers: EMPTY_COMPOSE_SPOILERS,
      fronters,
    })[0]
  }

  it('both validators admit the key and keep it; a bad value is refused', () => {
    const record = composed([WREN])
    expect(record[PLURAL_FRONTERS_KEY]).toEqual({members: [{id: WREN}]})
    const valid = validatePrivateRecord(record)
    expect((valid as LexMap)[PLURAL_FRONTERS_KEY]).toEqual({
      members: [{id: WREN}],
    })
    expect(() =>
      validatePrivateRecord({
        ...record,
        [PLURAL_FRONTERS_KEY]: {members: []},
      }),
    ).toThrow(PrivatePostInvalidError)
    expect(PLURAL_FRONTERS_KEY in composed([])).toBe(false)
  })

  it('the encode route leaves the key out of the payload and in the clear', () => {
    const plain = validatePrivateRecord(composed([WREN, SPARROW]))
    const content = encoderContentOf(plain)
    expect(Object.keys(content)).toEqual(['text'])
    const encoded = assembleEncodedRecord(
      {
        createdAt: plain.createdAt,
        audienceList: plain.audienceList,
        fronters: (plain as LexMap)[PLURAL_FRONTERS_KEY],
      },
      {
        encodedContent: new Uint8Array([1, 2]),
        encodedContentCodec: 'codec/0.2',
        encodedContentGeneration: `codec/${'0'.repeat(20)}/${'a'.repeat(64)}`,
      },
    )
    const checked = validateEncodedRecord(encoded, 'create') as LexMap
    expect(checked[PLURAL_FRONTERS_KEY]).toEqual({
      members: [{id: SPARROW}, {id: WREN}].sort((a, b) =>
        a.id < b.id ? -1 : 1,
      ),
    })
    expect(checked.$type).toBe(PP)
  })

  it('an outbox record’s fronters are read fail closed', () => {
    expect(
      recordFronters({fronters: [WREN, 'bad rkey!', 7, WREN]} as never),
    ).toEqual([WREN])
    expect(recordFronters({fronters: 'nope'} as never)).toEqual([])
    expect(recordFronters({} as never)).toEqual([])
  })
})

describe('the publish (PA-2, assertOwnGates)', () => {
  const stock = {
    appviewClient,
    chatClient: appviewClient,
    pdsClient: pdsClientFor(MAIN),
  }

  it('posts with the chosen account’s own clients and names it in the toast', () => {
    const otherPds = pdsClientFor(OTHER)
    mockTemps.set(OTHER, {
      did: OTHER,
      handle: 'other.test',
      pdsClient: otherPds,
      appviewClient,
      chatClient: appviewClient,
      prismClient: appviewClient,
    })
    chosen(OTHER, [])
    const receipt = beginPostingPublish(stock, thread(['x']), new QueryClient())
    expect(receipt.clients.pdsClient).toBe(otherPds)
    expect(receipt.postedAs).toBe('other.test')
  })

  it('refuses a client that does not write as the chosen account', () => {
    mockTemps.set(OTHER, {
      did: OTHER,
      handle: 'other.test',
      pdsClient: pdsClientFor(MAIN),
      appviewClient,
      chatClient: appviewClient,
      prismClient: appviewClient,
    })
    chosen(OTHER, [])
    expect(() =>
      beginPostingPublish(stock, thread(['x']), new QueryClient()),
    ).toThrow(PostingAccountMismatchError)
  })

  it('refuses while the posting account is held, and when its client is gone', () => {
    chosen(OTHER, [])
    expect(() =>
      beginPostingPublish(stock, thread(['x']), new QueryClient()),
    ).toThrow(PostingAccountNotReadyError)
    updatePosting({hold: {kind: 'pending'}})
    expect(() =>
      beginPostingPublish(stock, thread(['x']), new QueryClient()),
    ).toThrow(PostingAccountNotReadyError)
  })

  it('refuses another account’s reply list and list audience before anything is sent', () => {
    chosen(MAIN, [])
    expect(() =>
      beginPostingPublish(
        stock,
        thread(['x'], [{type: 'list', list: listUri(OTHER)}]),
        new QueryClient(),
      ),
    ).toThrow(ForeignReplyListError)
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'list', uri: audienceUri(OTHER)},
      locked: false,
    })
    expect(() =>
      beginPostingPublish(stock, thread(['x']), new QueryClient()),
    ).toThrow(ForeignAudienceError)
    expect(writes).toEqual([])
  })
})

describe('the front update (PP-6, 8.4)', () => {
  function front(members: {id: string; status?: string}[]): PluralFront {
    return {
      members,
      state: 'co-fronting',
      comment: 'hi',
      raw: {$type: FRONT, members, state: 'co-fronting', comment: 'hi'},
    }
  }

  it('chosen become engaging, unchosen engaging leave, others are kept; unchanged writes nothing', () => {
    expect(
      nextFrontMembers(
        front([
          {id: WREN, status: 'engaging'},
          {id: ROBIN, status: 'co-conscious'},
        ]),
        [SPARROW],
      ),
    ).toEqual([
      {id: ROBIN, status: 'co-conscious'},
      {id: SPARROW, status: 'engaging'},
    ])
    expect(
      nextFrontMembers(front([{id: WREN}, {id: ROBIN, status: 'observing'}]), [
        WREN,
      ]),
    ).toBeUndefined()
  })

  it('writes through the posting account’s client, keeping state and comment', async () => {
    const account = fakeAccount(OTHER, {
      system: true,
      members: [{rkey: WREN, name: 'Wren'}],
      engaging: [WREN],
    })
    const queryClient = new QueryClient()
    await updateFrontAfterPost(
      {did: OTHER, pdsClient: account.client, queryClient},
      [SPARROW],
    )
    const put = account.calls.find(c => c.nsid === 'com.atproto.repo.putRecord')
    expect(put?.body?.repo).toBe(OTHER)
    expect(account.front).toMatchObject({
      members: [{id: SPARROW, status: 'engaging'}],
    })
    expect(
      queryClient.getQueryData(identityQueryKey('front', {did: OTHER})),
    ).toMatchObject({kind: 'record'})
  })

  it('a public post updates the front after it is written; a kryphocron post never does', async () => {
    const account = fakeAccount(MAIN, {
      system: true,
      members: [{rkey: WREN, name: 'Wren'}],
      engaging: [],
    })
    const queryClient = publishCurrent(account, LOCUS_URL, 'main.test')
    chosen(MAIN, [WREN])
    const stock = {
      appviewClient,
      chatClient: appviewClient,
      pdsClient: account.client,
    }
    const receipt = beginPostingPublish(stock, thread(['x']), queryClient)
    receipt.afterPublish(`at://${MAIN}/${PP}/3kpost222222`)
    await settle()
    expect(
      account.calls.filter(c => c.nsid === 'com.atproto.repo.putRecord'),
    ).toEqual([])
    receipt.afterPublish(`at://${MAIN}/app.bsky.feed.post/3kpost222222`)
    await settle()
    expect(
      account.calls.filter(c => c.nsid === 'com.atproto.repo.putRecord'),
    ).toHaveLength(1)
    expect(account.front).toMatchObject({
      members: [{id: WREN, status: 'engaging'}],
    })
  })

  it('a failed front write never fails the post: it shows a toast with Try again', async () => {
    const account = fakeAccount(MAIN, {
      system: true,
      members: [{rkey: WREN, name: 'Wren'}],
    })
    account.fail = call =>
      call.nsid === 'com.atproto.repo.putRecord'
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    const queryClient = publishCurrent(account, LOCUS_URL, 'main.test')
    chosen(MAIN, [WREN])
    const receipt = beginPostingPublish(
      {appviewClient, chatClient: appviewClient, pdsClient: account.client},
      thread(['x']),
      queryClient,
    )
    expect(() =>
      receipt.afterPublish(`at://${MAIN}/app.bsky.feed.post/3kpost222222`),
    ).not.toThrow()
    await settle()
    expect(mockToasts).toHaveLength(1)
  })
})
