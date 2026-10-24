import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The reader's mutes on the device (2026-10-25): the read (every page of
 * mutes, mute lists and their members, scoped mutes left out), the
 * refreshes, the changes made in Horizon, the copy cleared and read again,
 * and no copy reaching another account.
 */

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {
  clearMuteCache,
  getMuteCache,
  MUTE_CACHE_REFRESH_MS,
  MUTE_PAGES_MAX,
  muteCacheKey,
  noteAccountMute,
  noteListMute,
  refreshMuteCache,
  resetMuteCache,
  startMuteCache,
} from '#/horizon/mutes/cache'
import {withAccountMuteNoted} from '#/horizon/mutes/track'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {
  type Call,
  deferred,
  OTHER_READER,
  READER,
  RECORD_CID,
  type Reply,
  server,
  until,
} from '#/horizon/thread-lens/__tests__/harness'

const ALICE = 'did:plc:aliceaaaaaaaaaaaaaaaaaaa'
const BOB = 'did:plc:bobbbbbbbbbbbbbbbbbbbbbb'
const CAROL = 'did:plc:carolccccccccccccccccccc'
const DAVE = 'did:plc:daveddddddddddddddddddddd'
const ERIN = 'did:plc:erinkkkkkkkkkkkkkkkkkkkk'
const SCOPED = 'did:plc:scopedeeeeeeeeeeeeeeeeee'

const SPAM_LIST = `at://${READER}/app.bsky.graph.list/3kspam2222222`
const NEW_LIST = `at://${OTHER_READER}/app.bsky.graph.list/3knew22222222`

function profile(did: string, viewer?: Record<string, unknown>) {
  return {did, handle: `${did.slice(8, 14)}.test`, ...(viewer ? {viewer} : {})}
}

function listView(uri: string, name: string) {
  return {
    uri,
    cid: RECORD_CID,
    name,
    purpose: 'app.bsky.graph.defs#modlist',
    creator: profile(READER),
    indexedAt: '2026-10-24T00:00:00.000Z',
  }
}

/** A fake AppView holding the reader's mutes; the lists `pages` long. */
type Mutes = {
  accounts: Record<string, unknown>[][]
  lists: Record<string, ReturnType<typeof listView>>
  members: Record<string, string[][]>
}

/** The fake AppView's reply to `call` from `mutes`. */
function replyFor(mutes: Mutes, call: Call): Reply | undefined {
  const cursor = call.params.get('cursor')
  const page = cursor ? Number(cursor) : 0
  const next = (length: number) =>
    page + 1 < length ? {cursor: String(page + 1)} : {}
  if (call.nsid === 'app.bsky.graph.getMutes') {
    return {
      status: 200,
      body: {
        mutes: mutes.accounts[page] ?? [],
        ...next(mutes.accounts.length),
      },
    }
  }
  if (call.nsid === 'app.bsky.graph.getListMutes') {
    return {status: 200, body: {lists: Object.values(mutes.lists)}}
  }
  if (call.nsid === 'app.bsky.graph.getList') {
    const uri = call.params.get('list')!
    const pages = mutes.members[uri] ?? [[]]
    return {
      status: 200,
      body: {
        list: mutes.lists[uri] ?? listView(uri, 'Fresh list'),
        items: (pages[page] ?? []).map((member, i) => ({
          uri: `at://${READER}/app.bsky.graph.listitem/3kitem${page}${i}aaaa`,
          subject: profile(member),
        })),
        ...next(pages.length),
      },
    }
  }
  return undefined
}

function fakeMutes(did: string, mutes: () => Mutes) {
  return server(did, call => replyFor(mutes(), call))
}

let data: Mutes

function readerMutes(): Mutes {
  return {
    accounts: [
      [profile(ALICE, {muted: true})],
      [profile(BOB, {muted: true}), profile(SCOPED, {mutedOnlyReposts: true})],
    ],
    lists: {[SPAM_LIST]: listView(SPAM_LIST, 'Spam accounts')},
    members: {[SPAM_LIST]: [[CAROL], [DAVE]]},
  }
}

function nsids(calls: Call[]) {
  return calls.map(call => call.nsid)
}

/** Move the fake clock by `ms`, then let every answer in flight land. */
async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

beforeEach(() => {
  resetMuteCache()
  writeLocal(muteCacheKey(READER), undefined)
  writeLocal(muteCacheKey(OTHER_READER), undefined)
  data = readerMutes()
})

afterEach(() => {
  jest.useRealTimers()
  clearCurrentClients()
})

describe('the read', () => {
  it('reads every page of mutes, mute lists and members; a scoped mute is left out', async () => {
    const appview = fakeMutes(READER, () => data)
    expect(getMuteCache(READER)).toBeUndefined()
    await refreshMuteCache(READER, appview.client)
    const mutes = getMuteCache(READER)!
    expect(mutes.stateOf(ALICE)).toEqual({muted: true})
    expect(mutes.stateOf(BOB)).toEqual({muted: true})
    expect(mutes.stateOf(SCOPED)).toEqual({muted: false})
    expect(mutes.stateOf(CAROL)).toMatchObject({
      muted: true,
      mutedByList: {uri: SPAM_LIST, name: 'Spam accounts'},
    })
    // The second page of members is read too.
    expect(mutes.stateOf(DAVE).mutedByList?.name).toBe('Spam accounts')
    expect(mutes.stateOf('did:plc:strangerffffffffffffffff')).toEqual({
      muted: false,
    })
    // Never the reader themself.
    expect(mutes.stateOf(READER)).toEqual({muted: false})
    expect(nsids(appview.calls).sort()).toEqual([
      'app.bsky.graph.getList',
      'app.bsky.graph.getList',
      'app.bsky.graph.getListMutes',
      'app.bsky.graph.getMutes',
      'app.bsky.graph.getMutes',
    ])
    // Stored on the device under the reader's key, and nowhere else.
    expect(readLocal(muteCacheKey(READER))).toContain(CAROL)
    expect(readLocal(muteCacheKey(OTHER_READER))).toBeUndefined()
  })

  it('is not used when a listing runs past the page limit', async () => {
    data.accounts = Array.from({length: MUTE_PAGES_MAX + 1}, (_, i) => [
      profile(`did:plc:many${String(i).padStart(20, 'a')}`, {muted: true}),
    ])
    await refreshMuteCache(READER, fakeMutes(READER, () => data).client)
    expect(getMuteCache(READER)).toBeUndefined()
    expect(readLocal(muteCacheKey(READER))).toContain('incomplete')
  })

  it('keeps the last whole copy when a read fails', async () => {
    const appview = fakeMutes(READER, () => data)
    await refreshMuteCache(READER, appview.client)
    const failing = server(READER, () => ({status: 500, body: {}}))
    await refreshMuteCache(READER, failing.client)
    expect(getMuteCache(READER)?.stateOf(ALICE).muted).toBe(true)
  })

  it('asks once while a read is in flight', async () => {
    const appview = fakeMutes(READER, () => data)
    await Promise.all([
      refreshMuteCache(READER, appview.client),
      refreshMuteCache(READER, appview.client),
    ])
    expect(
      appview.calls.filter(call => call.nsid === 'app.bsky.graph.getListMutes'),
    ).toHaveLength(1)
  })
})

describe('the refreshes', () => {
  it('reads on start, every 10 minutes in the foreground, and not in the background', async () => {
    jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']})
    const appview = fakeMutes(READER, () => data)
    let foreground = true
    const stop = startMuteCache(READER, appview.client, {
      isForeground: () => foreground,
      subscribe: () => () => {},
    })
    const reads = () =>
      appview.calls.filter(call => call.nsid === 'app.bsky.graph.getListMutes')
        .length
    await advance(0)
    expect(reads()).toBe(1)
    expect(getMuteCache(READER)?.stateOf(ALICE).muted).toBe(true)
    // The reader unmutes Alice elsewhere: the next refresh sees it.
    data.accounts = [[profile(BOB, {muted: true})]]
    await advance(MUTE_CACHE_REFRESH_MS)
    expect(reads()).toBe(2)
    expect(getMuteCache(READER)?.stateOf(ALICE).muted).toBe(false)
    foreground = false
    await advance(MUTE_CACHE_REFRESH_MS)
    expect(reads()).toBe(2)
    stop()
    foreground = true
    await advance(MUTE_CACHE_REFRESH_MS * 3)
    expect(reads()).toBe(2)
  })

  it('reads on coming back to the foreground only when the copy is 10 minutes old', async () => {
    jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']})
    const appview = fakeMutes(READER, () => data)
    let foreground = true
    let onChange = () => {}
    const stop = startMuteCache(READER, appview.client, {
      isForeground: () => foreground,
      subscribe: listener => {
        onChange = listener
        return () => {}
      },
    })
    const reads = () =>
      appview.calls.filter(call => call.nsid === 'app.bsky.graph.getListMutes')
        .length
    await advance(0)
    foreground = false
    await advance(60_000)
    foreground = true
    onChange()
    await advance(0)
    expect(reads()).toBe(1)
    foreground = false
    await advance(MUTE_CACHE_REFRESH_MS)
    foreground = true
    onChange()
    await advance(0)
    expect(reads()).toBe(2)
    stop()
  })
})

describe('changes made in Horizon', () => {
  it('a mute and an unmute show at once', async () => {
    await refreshMuteCache(READER, fakeMutes(READER, () => data).client)
    const settleMute = noteAccountMute(READER, ERIN, true)
    expect(getMuteCache(READER)?.stateOf(ERIN).muted).toBe(true)
    settleMute(true)
    noteAccountMute(READER, ALICE, false)(true)
    expect(getMuteCache(READER)?.stateOf(ALICE).muted).toBe(false)
    // Written to the device too.
    expect(readLocal(muteCacheKey(READER))).not.toContain(ALICE)
  })

  it('a failed mute is put back', async () => {
    await refreshMuteCache(READER, fakeMutes(READER, () => data).client)
    const settle = noteAccountMute(READER, ALICE, false)
    expect(getMuteCache(READER)?.stateOf(ALICE).muted).toBe(false)
    settle(false)
    expect(getMuteCache(READER)?.stateOf(ALICE).muted).toBe(true)
  })

  it('a read in flight when the reader mutes someone does not undo it', async () => {
    const appview = fakeMutes(READER, () => data)
    await refreshMuteCache(READER, appview.client)
    const held = deferred<void>()
    const slow = server(READER, async call => {
      if (call.nsid === 'app.bsky.graph.getMutes') await held.promise
      return replyFor(data, call)
    })
    const read = refreshMuteCache(READER, slow.client)
    // The AppView answered getMutes before the mute was written.
    noteAccountMute(READER, ERIN, true)(true)
    held.resolve()
    await read
    expect(getMuteCache(READER)?.stateOf(ERIN).muted).toBe(true)
    // A read started after the mute settled replaces the change.
    data.accounts = [[profile(ALICE, {muted: true})]]
    await new Promise(resolve => setTimeout(resolve, 5))
    await refreshMuteCache(READER, appview.client)
    expect(getMuteCache(READER)?.stateOf(ERIN).muted).toBe(false)
  })

  it('a list mute reads the members first and holds the copy back until then', async () => {
    const appview = fakeMutes(READER, () => data)
    await refreshMuteCache(READER, appview.client)
    data.lists[NEW_LIST] = listView(NEW_LIST, 'Loud accounts')
    data.members[NEW_LIST] = [['did:plc:loudggggggggggggggggggggg']]
    const settle = noteListMute(READER, NEW_LIST, true, appview.client)
    // Members not read yet: the lens keeps its pass.
    expect(getMuteCache(READER)).toBeUndefined()
    await until(() => getMuteCache(READER) !== undefined)
    settle(true)
    expect(
      getMuteCache(READER)?.stateOf('did:plc:loudggggggggggggggggggggg'),
    ).toMatchObject({muted: true, mutedByList: {name: 'Loud accounts'}})
    // Unsubscribing applies at once.
    noteListMute(READER, NEW_LIST, false, appview.client)(true)
    expect(
      getMuteCache(READER)?.stateOf('did:plc:loudggggggggggggggggggggg'),
    ).toEqual({muted: false})
    noteListMute(READER, SPAM_LIST, false, appview.client)
    expect(getMuteCache(READER)?.stateOf(CAROL)).toEqual({muted: false})
  })

  it('a list whose members cannot be read keeps the copy unused', async () => {
    await refreshMuteCache(READER, fakeMutes(READER, () => data).client)
    const failing = server(READER, () => ({status: 500, body: {}}))
    noteListMute(READER, NEW_LIST, true, failing.client)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(getMuteCache(READER)).toBeUndefined()
  })
})

describe('cleared', () => {
  it('is read again from scratch when the key is cleared', async () => {
    const appview = fakeMutes(READER, () => data)
    const stop = startMuteCache(READER, appview.client, {
      isForeground: () => true,
      subscribe: () => () => {},
    })
    await until(() => getMuteCache(READER) !== undefined)
    const reads = () =>
      appview.calls.filter(call => call.nsid === 'app.bsky.graph.getListMutes')
        .length
    expect(reads()).toBe(1)
    writeLocal(muteCacheKey(READER), undefined)
    expect(getMuteCache(READER)).toBeUndefined()
    await until(() => getMuteCache(READER) !== undefined)
    expect(reads()).toBe(2)
    expect(getMuteCache(READER)?.stateOf(CAROL).muted).toBe(true)
    stop()
  })

  it('is gone after sign-out and not read again for that account', async () => {
    const appview = fakeMutes(READER, () => data)
    const stop = startMuteCache(READER, appview.client, {
      isForeground: () => true,
      subscribe: () => () => {},
    })
    await until(() => getMuteCache(READER) !== undefined)
    clearMuteCache([READER])
    expect(readLocal(muteCacheKey(READER))).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(readLocal(muteCacheKey(READER))).toBeUndefined()
    expect(getMuteCache(READER)).toBeUndefined()
    stop()
  })
})

describe('accounts', () => {
  it("never shows one account's mutes to another", async () => {
    await refreshMuteCache(READER, fakeMutes(READER, () => data).client)
    expect(getMuteCache(OTHER_READER)).toBeUndefined()
    const other = fakeMutes(OTHER_READER, () => ({
      accounts: [[profile(BOB, {muted: true})]],
      lists: {},
      members: {},
    }))
    await refreshMuteCache(OTHER_READER, other.client)
    expect(getMuteCache(OTHER_READER)?.stateOf(ALICE).muted).toBe(false)
    expect(getMuteCache(OTHER_READER)?.stateOf(CAROL).muted).toBe(false)
    expect(getMuteCache(READER)?.stateOf(ALICE).muted).toBe(true)
    expect(getMuteCache(READER)?.stateOf(BOB).muted).toBe(true)
  })

  it("a mute answered after a switch changes only its own account's copy", async () => {
    await refreshMuteCache(READER, fakeMutes(READER, () => data).client)
    await refreshMuteCache(
      OTHER_READER,
      fakeMutes(OTHER_READER, () => ({accounts: [], lists: {}, members: {}}))
        .client,
    )
    publishCurrentClients({
      did: READER,
      handle: 'reader.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: {} as never,
      queryClient: {} as never,
    })
    const held = deferred<void>()
    const mute = withAccountMuteNoted(ERIN, true, () => held.promise)
    // The reader switches to the other account before the AppView answers.
    publishCurrentClients({
      did: OTHER_READER,
      handle: 'other.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: {} as never,
      queryClient: {} as never,
    })
    held.resolve()
    await mute
    expect(getMuteCache(READER)?.stateOf(ERIN).muted).toBe(true)
    expect(getMuteCache(OTHER_READER)?.stateOf(ERIN).muted).toBe(false)
  })

  it("a read of one account answered after the other's started writes only its own key", async () => {
    const held = deferred<void>()
    const slow = server(READER, async call => {
      await held.promise
      return replyFor(data, call)
    })
    const read = refreshMuteCache(READER, slow.client)
    await refreshMuteCache(
      OTHER_READER,
      fakeMutes(OTHER_READER, () => ({accounts: [], lists: {}, members: {}}))
        .client,
    )
    held.resolve()
    await read
    expect(getMuteCache(OTHER_READER)?.stateOf(ALICE).muted).toBe(false)
    expect(getMuteCache(READER)?.stateOf(ALICE).muted).toBe(true)
  })
})
