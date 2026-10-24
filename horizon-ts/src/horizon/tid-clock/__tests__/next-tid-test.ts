/* oxlint-disable import/no-nodejs-modules -- reads the source files as text, in jest only */
import {afterEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The per-account TID clock (Phase 5 design, Appendix A.5). "A module reset"
 * is `jest.resetModules()` and a fresh `require` of `#/horizon/tid-clock`,
 * which stands for a page load. The site tests use the statically imported
 * instance, which is the one the sites themselves import.
 */

// The suite mocks multiformats globally; computeCid needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * The sites' modules also reach UI and analytics modules; nothing here
 * renders or measures, so those are stand-ins.
 */
function mockModule(): unknown {
  const stub = function () {
    return mockModule()
  }
  return new Proxy(stub, {
    get: (_, key) => {
      if (key === '__esModule') return true
      if (key === 'then' || typeof key === 'symbol') return undefined
      return mockModule()
    },
  })
}
jest.mock('react-native-reanimated', () => mockModule())
jest.mock('react-native-worklets', () => mockModule())
jest.mock('#/analytics', () => mockModule())
// create-account's session and age assurance collaborators; only its saved-feed step runs.
jest.mock('@atproto/lex-password-session', () => mockModule())
jest.mock('#/state/birthdate', () => mockModule())
jest.mock('#/state/queries/messages/restrictChatSettings', () => mockModule())
jest.mock('#/state/shell/reminders', () => mockModule())
jest.mock('#/ageAssurance/data', () => mockModule())
jest.mock('#/ageAssurance/state', () => mockModule())
jest.mock('#/state/session/moderation', () => mockModule())
jest.mock('#/state/session/session-core', () => mockModule())
jest.mock('#/state/session/session-data', () => mockModule())
jest.mock('#/state/session', () => mockModule())
jest.mock('#/components/Toast', () => mockModule())

let mockClockOn = true
// A live getter, so a test can flip the switch.
jest.mock('#/horizon/switches', () =>
  Object.defineProperty(
    {...jest.requireActual<object>('#/horizon/switches')},
    'PER_ACCOUNT_TID_CLOCK',
    {get: () => mockClockOn, enumerable: true},
  ),
)
let mockCurrentDid: string | undefined
jest.mock('#/horizon/routing/current-clients', () => ({
  ...jest.requireActual<object>('#/horizon/routing/current-clients'),
  getCurrentDid: () => mockCurrentDid,
}))

// `post()`'s heavy collaborators, as in post-routing-test.
jest.mock('#/horizon/private/api/writes', () => ({
  postPrivate: jest.fn(),
}))
jest.mock('#/state/gallery', () => ({compressImage: jest.fn()}))
jest.mock('#/state/queries/resolve-link', () => ({
  fetchResolveGifQuery: jest.fn(),
  fetchResolveLinkQuery: jest.fn(),
  RQKEY_LINK: (url: string) => ['resolve-link', url],
}))
jest.mock('#/state/queries/threadgate', () => ({
  createThreadgateRecord: (r: object) => ({
    $type: 'app.bsky.feed.threadgate',
    ...r,
  }),
  threadgateAllowUISettingToAllowRecordValue: () => [],
}))
jest.mock('#/lib/at-card', () => ({withCreator: jest.fn()}))
jest.mock('#/lib/api/upload-blob', () => ({uploadBlob: jest.fn()}))
jest.mock('#/state/queries/post-feed', () => ({RQKEY_ROOT: 'post-feed'}))
jest.mock('#/state/queries/profile', () => ({
  RQKEY: (did: string) => ['profile', did],
}))
jest.mock('#/view/com/composer/drafts/state/storage', () => ({
  deleteMediaFromLocal: () => Promise.resolve(),
}))

import * as fs from 'node:fs'
import * as path from 'node:path'

import {TID} from '@atproto/common-web'
import {Client} from '@atproto/lex'
import {
  addMutedWord,
  addSavedFeeds,
  getPreferences,
  setTidSource,
} from '@bsky/sdk'
import {RichText} from '@bsky/sdk/richtext'
import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {post} from '#/lib/api/index'
import {initializeSavedFeeds} from '#/state/session/create-account'
import {type ThreadDraft} from '#/view/com/composer/state/composer'
import {bulkWriteFollows} from '#/screens/Onboarding/util'
import {createReplyList} from '#/horizon/private/api/reply-lists'
import {newRkeys} from '#/horizon/private/outbox'
import {clockIdFor} from '#/horizon/tid-clock'
import {
  installSdkPreferenceIds,
  sdkPreferenceId,
} from '#/horizon/tid-clock/sdk-ids'

i18n.loadAndActivate({locale: 'en', messages: {}})

type Clock = typeof import('#/horizon/tid-clock')
type Prefs = typeof import('#/horizon/tid-clock/preference-id')

const A = 'did:plc:accountaaaaaaaaaaaaaaaaa'
const B = 'did:plc:accountbbbbbbbbbbbbbbbbb'
/** About 2026-09, in milliseconds. */
const NOW = 1_790_000_000_000
const TWO_32 = 4294967296
const RKEY = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/

/** A page load: a fresh module instance. */
function freshClock(): Clock {
  jest.resetModules()
  return require('#/horizon/tid-clock') as Clock
}

/** A page load with both the clock and the preference ids in it. */
function freshPrefs(): {clock: Clock; prefs: Prefs} {
  jest.resetModules()
  const clock = require('#/horizon/tid-clock') as Clock
  const prefs = require('#/horizon/tid-clock/preference-id') as Prefs
  return {clock, prefs}
}

/** The crypto value that draws index `k` of `n` choices. */
function uFor(k: number, n: number) {
  return Math.floor(((k + 0.5) / n) * TWO_32)
}

/** Spy the crypto source to answer `next()` for each draw. */
function spyCrypto(next: () => number) {
  return jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((
    array: Uint32Array,
  ) => {
    array[0] = next()
    return array
  }) as never)
}

function freezeNow(ms = NOW) {
  return jest.spyOn(Date, 'now').mockReturnValue(ms)
}

function count(tid: TID, ms = NOW) {
  return tid.timestamp() - ms * 1000
}

afterEach(() => {
  jest.restoreAllMocks()
  mockClockOn = true
  mockCurrentDid = undefined
})

describe('clockIdFor', () => {
  it('1. is drawn at random, in range, and the same for a DID in one page', () => {
    const clock = freshClock()
    const id = clock.clockIdFor(A)
    expect(Number.isInteger(id)).toBe(true)
    expect(id).toBeGreaterThanOrEqual(0)
    expect(id).toBeLessThan(32)
    expect(clock.clockIdFor(A)).toBe(id)

    spyCrypto(() => uFor(17, 32))
    expect(freshClock().clockIdFor(A)).toBe(17)
    spyCrypto(() => uFor(3, 32))
    expect(freshClock().clockIdFor(A)).toBe(3)
  })

  it('1. falls back to Math.random without crypto', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    try {
      const random = jest.spyOn(Math, 'random').mockReturnValue(29.5 / 32)
      expect(freshClock().clockIdFor(A)).toBe(29)
      expect(random).toHaveBeenCalledTimes(1)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    }
  })

  it('2. is drawn on the first mint, not at import, and only once', () => {
    const crypto = spyCrypto(() => uFor(4, 32))
    const random = jest.spyOn(Math, 'random')
    const clock = freshClock()
    expect(crypto).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    clock.nextTid(A)
    expect(crypto).toHaveBeenCalledTimes(1)
    clock.nextTid(A)
    expect(crypto).toHaveBeenCalledTimes(1)
    expect(random).not.toHaveBeenCalled()
  })

  it('3. two accounts in one page never share a clock id, even when the draw would match', () => {
    // The same raw draw each time: drawn from all 32, B would get A's id.
    spyCrypto(() => uFor(5, 32))
    const clock = freshClock()
    const a = clock.nextTid(A).clockid()
    const b = clock.nextTid(B).clockid()
    expect(a).toBe(5)
    expect(b).not.toBe(a)

    jest.restoreAllMocks()
    const many = freshClock()
    const ids = Array.from({length: 32}, (_, i) =>
      many.clockIdFor(`did:plc:many${String(i).padStart(20, 'a')}`),
    )
    expect(new Set(ids).size).toBe(32)
    const extra = many.clockIdFor('did:plc:extraaaaaaaaaaaaaaaaaaaaa')
    expect(extra).toBeGreaterThanOrEqual(0)
    expect(extra).toBeLessThan(32)

    const mixed = freshClock()
    const tids = [mixed.nextTid(A), mixed.nextTid(B), mixed.nextTid(A)]
    expect(tids.map(t => t.clockid())).toEqual([
      mixed.clockIdFor(A),
      mixed.clockIdFor(B),
      mixed.clockIdFor(A),
    ])
    expect(mixed.clockIdFor(A)).not.toBe(mixed.clockIdFor(B))
  })

  it('4. differs across page loads', () => {
    spyCrypto(() => uFor(3, 32))
    expect(freshClock().clockIdFor(A)).toBe(3)
    jest.restoreAllMocks()
    spyCrypto(() => uFor(9, 32))
    expect(freshClock().clockIdFor(A)).toBe(9)
    jest.restoreAllMocks()

    const seen = new Set<number>()
    for (let i = 0; i < 20; i++) seen.add(freshClock().clockIdFor(A))
    expect(seen.size).toBeGreaterThan(1)
  })

  it('5. is no function of the DID, and the source has no hash', () => {
    spyCrypto(() => uFor(11, 32))
    expect(freshClock().clockIdFor(A)).toBe(11)
    expect(freshClock().clockIdFor(B)).toBe(11)

    const source = fs.readFileSync(
      path.join(__dirname, '..', 'index.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/0x811c9dc5/i)
    expect(source).not.toMatch(/0x01000193/i)
    expect(source).not.toMatch(/fnv/i)
  })
})

describe('nextTid', () => {
  it('6. the counter is stock-shaped: the same timestamps as stock for one DID', () => {
    const script = [NOW, NOW, NOW + 5, NOW + 5, NOW + 2, NOW + 9]
    let i = 0
    const now = jest.spyOn(Date, 'now').mockImplementation(() => script[i++])
    const crypto = jest.spyOn(globalThis.crypto, 'getRandomValues')
    const random = jest.spyOn(Math, 'random')

    const clock = freshClock()
    const first = clock.nextTid(A)
    expect(first.timestamp()).toBe(NOW * 1000)
    const drawsAfterFirst = crypto.mock.calls.length + random.mock.calls.length
    expect(drawsAfterFirst).toBe(1)
    const ours = [first]
    for (let k = 1; k < script.length; k++) ours.push(clock.nextTid(A))
    // No random source for the timestamp after the clock id's one draw.
    expect(crypto.mock.calls.length + random.mock.calls.length).toBe(1)

    // Stock, in a fresh module instance, for the same script.
    i = 0
    jest.resetModules()
    const stock = require('@atproto/common-web') as {TID: typeof TID}
    const theirs = script.map(() => stock.TID.next())
    expect(now).toHaveBeenCalledTimes(script.length * 2)
    expect(ours.map(t => t.timestamp())).toEqual(theirs.map(t => t.timestamp()))
  })

  it('7. counters are independent across accounts and restart with the page', () => {
    freezeNow()
    const clock = freshClock()
    for (let n = 1; n <= 1000; n++) {
      expect(count(clock.nextTid(A))).toBe(n - 1)
    }
    expect(count(clock.nextTid(B))).toBe(0)
    expect(count(clock.nextTid(A))).toBe(1000)
    expect(count(clock.nextTid(B))).toBe(1)
    expect(count(clock.nextTid(A))).toBe(1001)

    const next = freshClock()
    expect(count(next.nextTid(A))).toBe(0)
    expect(count(next.nextTid(B))).toBe(0)
  })

  it('8. is strictly increasing per account', () => {
    freezeNow()
    const clock = freshClock()
    let prev = clock.nextTid(A)
    for (let n = 0; n < 1000; n++) {
      const tid = clock.nextTid(A)
      expect(tid.timestamp()).toBeGreaterThan(prev.timestamp())
      expect(tid.newerThan(prev)).toBe(true)
      prev = tid
    }

    let back = NOW
    jest.spyOn(Date, 'now').mockImplementation(() => (back -= 7))
    const stepping = freshClock()
    let last = stepping.nextTid(A)
    for (let n = 0; n < 50; n++) {
      const tid = stepping.nextTid(A)
      expect(tid.newerThan(last)).toBe(true)
      last = tid
    }

    freezeNow()
    const bumped = freshClock()
    const ahead = TID.fromTime((NOW + 10_000) * 1000, 0)
    const afterPrev = bumped.nextTid(A, ahead)
    expect(afterPrev.timestamp()).toBeGreaterThan(ahead.timestamp())
    const afterThat = bumped.nextTid(A)
    expect(afterThat.timestamp()).toBeGreaterThan(afterPrev.timestamp())
  })

  it('9. makes valid rkeys that round-trip', () => {
    freezeNow()
    const clock = freshClock()
    for (let n = 0; n < 40; n++) {
      const tid = clock.nextTid(n % 2 ? A : B)
      const s = tid.toString()
      expect(s).toHaveLength(13)
      expect(TID.is(s)).toBe(true)
      expect(s).toMatch(RKEY)
      const parsed = TID.fromStr(s)
      expect(parsed.clockid()).toBe(clock.clockIdFor(n % 2 ? A : B))
      expect(parsed.timestamp()).toBe(tid.timestamp())
    }
    const str = clock.nextTidStr(A)
    expect(str).toMatch(RKEY)
    expect(clock.nextTidStr(A, str) > str).toBe(true)
  })

  it('10. refuses a value that is not a DID, without naming it', () => {
    const clock = freshClock()
    let error: unknown
    try {
      clock.nextTid('alice.bsky.social')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('nextTid: not a DID')
    expect((error as Error).message).not.toContain('alice')
    expect(() => clock.nextTidStr('')).toThrow('nextTid: not a DID')
    expect(() => clock.clockIdFor('bob')).toThrow('nextTid: not a DID')
  })

  it('13. with the switch off it is stock: one clock id for every account', () => {
    mockClockOn = false
    const clock = freshClock()
    const a = clock.nextTid(A)
    const b = clock.nextTid(B)
    expect(a.clockid()).toBe(b.clockid())
    expect(b.newerThan(a)).toBe(true)
    expect(clock.nextTidStr(B)).toMatch(RKEY)
  })
})

describe('preference ids (P5R4-N2)', () => {
  it('14. share the account’s counter, and fall back to stock without an account', () => {
    freezeNow()
    const {clock, prefs} = freshPrefs()
    const p1 = TID.fromStr(prefs.nextPreferenceId(A))
    const p2 = TID.fromStr(prefs.nextPreferenceId(A))
    const t = clock.nextTid(A)
    expect([count(p1), count(p2), count(t)]).toEqual([0, 1, 2])
    expect(p1.clockid()).toBe(clock.clockIdFor(A))
    expect(t.clockid()).toBe(clock.clockIdFor(A))
    expect(count(clock.nextTid(B))).toBe(0)

    mockCurrentDid = A
    expect(count(TID.fromStr(prefs.nextPreferenceId()))).toBe(3)

    mockCurrentDid = undefined
    const stock = prefs.nextPreferenceId()
    expect(stock).toMatch(RKEY)
    expect(count(clock.nextTid(A))).toBe(4)
    expect(count(clock.nextTid(B))).toBe(1)

    expect(() => prefs.nextPreferenceId('not-a-did')).toThrow(
      'nextTid: not a DID',
    )
  })
})

describe('sites (A.4)', () => {
  /** A fake PDS client signed in as `did`, recording each call's body. */
  function fakePds(did: string, answer: unknown = {}) {
    const calls: Record<string, unknown>[] = []
    const client = {
      assertDid: did,
      did,
      call: jest.fn((_method: unknown, body: unknown) => {
        calls.push(body as Record<string, unknown>)
        return Promise.resolve(answer)
      }),
    } as unknown as Client
    return {client, calls}
  }

  type Write = {collection: string; rkey: string; value: {subject?: string}}

  function writesOf(body: Record<string, unknown>) {
    return body.writes as Write[]
  }

  function clockOf(rkey: string) {
    return TID.fromStr(rkey).clockid()
  }

  const appviewClient = {
    call: jest.fn(() => Promise.resolve({posts: [], follows: [{}]})),
  } as unknown as Client

  function draft(text: string) {
    return {
      id: text,
      richtext: new RichText({text}),
      labels: [],
      embed: {quote: undefined, media: undefined, link: undefined},
      shortenedGraphemeLength: text.length,
    }
  }

  it('11. post() writes each account’s posts, threadgate and postgate on that account’s clock id', async () => {
    const byAccount = new Map<string, number[]>()
    for (const did of [A, B]) {
      const pds = fakePds(did)
      await post(new QueryClient(), {
        thread: {
          posts: [draft('one'), draft('two')],
          threadgate: [{type: 'nobody'}],
          postgate: {
            embeddingRules: [{$type: 'app.bsky.feed.postgate#disableRule'}],
          },
        } as unknown as ThreadDraft,
        appviewClient,
        chatClient: appviewClient,
        pdsClient: pds.client,
      })
      const writes = writesOf(pds.calls[0])
      expect(writes.map(w => w.collection)).toEqual([
        'app.bsky.feed.post',
        'app.bsky.feed.threadgate',
        'app.bsky.feed.postgate',
        'app.bsky.feed.post',
        'app.bsky.feed.postgate',
      ])
      const clocks = writes.map(w => clockOf(w.rkey))
      expect(new Set(clocks)).toEqual(new Set([clockIdFor(did)]))
      byAccount.set(did, clocks)
    }
    // Without the fix both accounts share the page's one clock id.
    expect(byAccount.get(A)?.[0]).not.toBe(byAccount.get(B)?.[0])
  })

  it('11. the outbox’s rkeys carry the account’s clock id, increasing', () => {
    const a = newRkeys(A, 3)
    const b = newRkeys(B, 2)
    expect(a.map(clockOf)).toEqual([0, 0, 0].map(() => clockIdFor(A)))
    expect(b.map(clockOf)).toEqual([0, 0].map(() => clockIdFor(B)))
    expect([...a].sort()).toEqual(a)
    expect(new Set(a).size).toBe(3)
    expect(clockIdFor(A)).not.toBe(clockIdFor(B))
  })

  it('11. createReplyList’s list and list items carry the account’s clock id', async () => {
    const pds = fakePds(A)
    await createReplyList(
      new QueryClient(),
      {pdsClient: pds.client, did: A},
      {name: 'Close friends', members: [B, 'did:plc:thirdcccccccccccccccccc']},
    )
    const writes = writesOf(pds.calls[0])
    expect(writes).toHaveLength(3)
    for (const w of writes) expect(clockOf(w.rkey)).toBe(clockIdFor(A))
  })

  it('11. bulkWriteFollows mints on the account’s clock, not a followed DID’s (the T-5 trap)', async () => {
    const followed = Array.from(
      {length: 4},
      (_, i) => `did:plc:followed${String(i).padStart(17, 'a')}`,
    )
    // Each new draw a distinct value: a follow minted per followed DID would differ.
    let draw = 0
    spyCrypto(() => uFor(draw++ % 32, 32))
    const account = 'did:plc:onboardaaaaaaaaaaaaaaaaa'
    const onboarding = fakePds(account)
    await bulkWriteFollows(onboarding.client, appviewClient, followed)
    const writes = writesOf(onboarding.calls[0])
    expect(writes.map(w => w.value.subject)).toEqual(followed)
    const own = clockIdFor(account)
    for (const w of writes) expect(clockOf(w.rkey)).toBe(own)
  })

  it('14. initializeSavedFeeds mints on the new account’s counter, and its follows count on after them', async () => {
    const account = 'did:plc:newaccountaaaaaaaaaaaaa'
    freezeNow(NOW + 50_000_000)
    const pds = fakePds(account)
    await initializeSavedFeeds(pds.client)
    const feeds = pds.calls[0] as unknown as {id: string}[]
    expect(feeds).toHaveLength(2)
    const ids = feeds.map(f => TID.fromStr(f.id))
    for (const id of ids) expect(id.clockid()).toBe(clockIdFor(account))

    await bulkWriteFollows(pds.client, appviewClient, [A, B])
    const follows = writesOf(pds.calls[1]).map(w => TID.fromStr(w.rkey))
    expect(
      [...ids, ...follows].map(tid => count(tid, NOW + 50_000_000)),
    ).toEqual([0, 1, 2, 3])
  })
})

describe('sdk preference ids (patches/@bsky__sdk@1.2.0.patch)', () => {
  const SAVED_V2 = 'app.bsky.actor.defs#savedFeedsPrefV2'
  const MUTED = 'app.bsky.actor.defs#mutedWordsPref'

  type Pref = {$type: string; items?: {id?: string; value: string}[]}

  /**
   * A real lex `Client` signed in as `did`, over a fake PDS that keeps the
   * account's preferences and records each `putPreferences` body.
   */
  function fakePrefsPds(did: string, initial: Pref[] = []) {
    let prefs: Pref[] = initial
    const puts: Pref[][] = []
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    const client = new Client({
      did: did as `did:${string}:${string}`,
      fetchHandler: (path: string, init: RequestInit) => {
        if (path.includes('app.bsky.actor.getPreferences')) {
          return Promise.resolve(respond({preferences: prefs}))
        }
        if (path.includes('app.bsky.actor.putPreferences')) {
          const body = JSON.parse(init.body as string) as {
            preferences: Pref[]
          }
          prefs = body.preferences
          puts.push(prefs)
          return Promise.resolve(new Response(null, {status: 200}))
        }
        return Promise.reject(new Error('unexpected call'))
      },
    })
    return {client, puts}
  }

  function itemIds(prefs: Pref[], $type: string): string[] {
    const pref = prefs.find(p => p.$type === $type)
    return (pref?.items ?? []).map(item => item.id ?? '')
  }

  function clockOf(id: string) {
    return TID.fromStr(id).clockid()
  }

  afterEach(() => {
    setTidSource(null)
  })

  it('15. after a switch in one page, the second account’s default saved feed is on its own clock', async () => {
    installSdkPreferenceIds()
    const a = fakePrefsPds(A)
    const b = fakePrefsPds(B)

    // Signed in as A, then switched to B, a fresh account: no saved feeds.
    mockCurrentDid = A
    await a.client.call(getPreferences)
    mockCurrentDid = B
    const prefsB = await b.client.call(getPreferences)

    const [idA] = itemIds(a.puts[0], SAVED_V2)
    const [idB] = itemIds(b.puts[0], SAVED_V2)
    expect(idA).toMatch(RKEY)
    expect(idB).toMatch(RKEY)
    expect(clockOf(idA)).toBe(clockIdFor(A))
    expect(clockOf(idB)).toBe(clockIdFor(B))
    // Stock mints both on the page's one sdk clock.
    expect(clockOf(idB)).not.toBe(clockOf(idA))
    expect(prefsB.savedFeeds.map(f => f.id)).toEqual([idB])
  })

  it('15. on the client’s own account even while another is current', async () => {
    installSdkPreferenceIds()
    const b = fakePrefsPds(B)
    // The posting-as shape: A is current, B's client reads its preferences.
    mockCurrentDid = A
    await b.client.call(getPreferences)
    expect(clockOf(itemIds(b.puts[0], SAVED_V2)[0])).toBe(clockIdFor(B))
  })

  it('15. the v1 migration, addSavedFeeds and the muted words mint on the client’s account', async () => {
    installSdkPreferenceIds()
    const feed =
      'at://did:plc:feedowneraaaaaaaaaaaaaa/app.bsky.feed.generator/cats'
    const b = fakePrefsPds(B, [
      {
        $type: 'app.bsky.actor.defs#savedFeedsPref',
        pinned: [feed],
        saved: [feed],
      } as Pref,
      // A legacy muted word with no id, which the sdk backfills.
      {$type: MUTED, items: [{value: 'old', targets: ['content']} as never]},
    ])
    mockCurrentDid = A

    await b.client.call(getPreferences)
    const migrated = itemIds(b.puts[0], SAVED_V2)
    expect(migrated).toHaveLength(2)

    const added = await b.client.call(addSavedFeeds, [
      {type: 'feed', value: feed.replace('cats', 'dogs'), pinned: false},
    ])
    expect(added).toHaveLength(1)

    await b.client.call(addMutedWord, {value: 'new', targets: ['content']})
    const muted = itemIds(b.puts[b.puts.length - 1], MUTED)
    expect(muted).toHaveLength(2)

    const ids = [...migrated, added[0].id, ...muted]
    for (const id of ids) {
      expect(id).toMatch(RKEY)
      expect(clockOf(id)).toBe(clockIdFor(B))
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('15. a client with no DID falls back to the sdk’s clock, not the current account’s', () => {
    mockCurrentDid = A
    expect(sdkPreferenceId(undefined)).toBeUndefined()
    expect(
      sdkPreferenceId(
        new Client({fetchHandler: () => Promise.reject(new Error('offline'))}),
      ),
    ).toBeUndefined()
    expect(clockOf(sdkPreferenceId(fakePrefsPds(B).client) ?? '')).toBe(
      clockIdFor(B),
    )
  })
})

describe('guard', () => {
  it('12. every id the sdk mints asks the source with its client, and the app installs it', () => {
    const sdk = path.dirname(require.resolve('@bsky/sdk'))
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (/\.js$/.test(entry.name)) {
          const rel = path.relative(sdk, full)
          const lines = fs.readFileSync(full, 'utf8').split('\n')
          lines.forEach((line, i) => {
            const where = `${rel}:${i + 1}`
            // A mint with no client cannot be routed to an account.
            if (/\bnextTid\(\s*\)/.test(line)) offenders.push(where)
            // Any other TID clock in the sdk.
            if (/\bTID\.next(Str)?\(|\bnextStr\(/.test(line)) {
              offenders.push(where)
            }
            if (rel !== 'tid.js' && /Math\.random\(\)\s*\*\s*32\b/.test(line)) {
              offenders.push(where)
            }
          })
        }
      }
    }
    walk(sdk)
    expect(offenders).toEqual([])

    // The patch is in: nextTid asks the source before its own clock.
    const tid = fs.readFileSync(path.join(sdk, 'tid.js'), 'utf8')
    expect(tid).toMatch(/export function setTidSource\(/)
    expect(tid).toMatch(
      /export function nextTid\(client\) \{\s*if \(_tidSource !== null\) \{\s*const id = _tidSource\(client\);/,
    )

    // Both app entries install the source at load.
    const src = path.resolve(__dirname, '..', '..', '..')
    for (const entry of ['App.tsx', 'App.web.tsx']) {
      const text = fs.readFileSync(path.join(src, entry), 'utf8')
      expect(text).toMatch(/^installSdkPreferenceIds\(\)$/m)
    }
  })

  it('12. no TID.next or TID.nextStr call outside src/horizon/tid-clock/', () => {
    const src = path.resolve(__dirname, '..', '..', '..')
    const clockDir = path.join(src, 'horizon', 'tid-clock') + path.sep
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue
          walk(full)
        } else if (/\.tsx?$/.test(entry.name) && !full.startsWith(clockDir)) {
          const lines = fs.readFileSync(full, 'utf8').split('\n')
          lines.forEach((line, i) => {
            if (/\bTID\.next(Str)?\(/.test(line)) {
              offenders.push(`${path.relative(src, full)}:${i + 1}`)
            }
          })
        }
      }
    }
    walk(src)
    expect(path.basename(src)).toBe('src')
    expect(offenders).toEqual([])
  })
})
