import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'

import * as store from '#/horizon/appearance/store'
import * as sync from '#/horizon/appearance/sync'
import {
  BLOB_CID,
  type Call,
  fakeClient,
  RECORD_CID,
} from '#/horizon/private/__tests__/fixtures'

// The fake PDS answers real CIDs, which the client validates.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
}))
const mockToast = jest.fn()
jest.mock('#/components/Toast', () => ({
  show: (...args: unknown[]) => mockToast(...args),
}))
jest.mock('#/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

let mockJson: string | undefined
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => mockJson,
  writeDeviceJson: (json: string) => {
    mockJson = json
  },
  subscribeDeviceJson: () => () => {},
}))

i18n.loadAndActivate({locale: 'en', messages: {}})

const DID = 'did:plc:alice'
const BOB = 'did:plc:bob'
const COLLECTION = 'app.nearhorizon.actor.appearance'

type Stored = {value: Record<string, unknown>; cid: string} | null

/**
 * A fake PDS with Bluesky's swap semantics: a null swap means no record may
 * exist; a CID must match the current one. `putReplies` overrides the next
 * put replies in order.
 */
function pds(initial: Stored = null) {
  const server = {
    stored: initial,
    putReplies: [] as {status: number; body?: unknown}[],
    getReply: null as {status: number; body?: unknown} | Error | null,
    putError: null as Error | null,
    calls: [] as Call[],
  }
  let next = 0
  const {client} = fakeClient(DID, call => {
    server.calls.push(call)
    if (call.nsid === 'com.atproto.repo.getRecord') {
      if (server.getReply) return server.getReply
      if (!server.stored) {
        return {status: 400, body: {error: 'RecordNotFound', message: 'none'}}
      }
      return {
        status: 200,
        body: {
          uri: `at://${DID}/${COLLECTION}/self`,
          cid: server.stored.cid,
          value: server.stored.value,
        },
      }
    }
    if (call.nsid === 'com.atproto.repo.putRecord') {
      if (server.putError) return server.putError
      const forced = server.putReplies.shift()
      if (forced) return forced
      const swap = call.body?.swapRecord
      const current = server.stored?.cid ?? null
      if (swap !== undefined && swap !== current) {
        return {status: 400, body: {error: 'InvalidSwap', message: 'swap'}}
      }
      const cid = next++ % 2 === 0 ? RECORD_CID : BLOB_CID
      server.stored = {value: call.body!.record as Record<string, unknown>, cid}
      return {
        status: 200,
        body: {uri: `at://${DID}/${COLLECTION}/self`, cid},
      }
    }
    return {status: 404, body: {error: 'MethodNotImplemented'}}
  })
  return {server, client}
}

function puts(server: {calls: Call[]}) {
  return server.calls.filter(c => c.nsid === 'com.atproto.repo.putRecord')
}

function copy(did = DID) {
  return store.getAppearanceState().device.accounts[did]
}

beforeEach(() => {
  mockJson = undefined
  mockToast.mockClear()
  store.resetAppearanceStoreForTests()
  sync.resetAppearanceSyncForTests()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('sync (T12)', () => {
  it('reads with getRecord; RecordNotFound stores an empty copy', async () => {
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    expect(await sync.refresh(DID)).toBe(true)
    const call = server.calls[0]
    expect(call.nsid).toBe('com.atproto.repo.getRecord')
    expect(call.params.get('repo')).toBe(DID)
    expect(call.params.get('collection')).toBe(COLLECTION)
    expect(call.params.get('rkey')).toBe('self')
    expect(copy()).toMatchObject({record: null, raw: null, cid: null})
    expect(copy().syncedAt).toBeGreaterThan(0)
  })

  it('stores a read record and its CID', async () => {
    const {client} = pds({
      value: {
        $type: COLLECTION,
        version: 1,
        backdrop: 'pride.bi',
        updatedAt: 'x',
      },
      cid: RECORD_CID,
    })
    sync.registerAppearanceClient(DID, client)
    await sync.refresh(DID)
    expect(copy().record?.backdrop).toBe('pride.bi')
    expect(copy().cid).toBe(RECORD_CID)
    expect(copy().raw).toEqual({
      version: 1,
      backdrop: 'pride.bi',
      updatedAt: 'x',
    })
  })

  it('keeps the copy when a read fails or has no CID', async () => {
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    server.getReply = {status: 500, body: {error: 'InternalServerError'}}
    expect(await sync.refresh(DID)).toBe(false)
    expect(copy()).toBeUndefined()
    server.getReply = {
      status: 200,
      body: {
        uri: `at://${DID}/${COLLECTION}/self`,
        value: {backdrop: 'pride.bi'},
      },
    }
    expect(await sync.refresh(DID)).toBe(false)
    expect(copy()).toBeUndefined()
  })

  it('writes with putRecord: no validate, swap null then the CID', async () => {
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    store.selectBackdrop(DID, 'pride.trans')
    await sync.flush(DID)
    // Never read: read first, then write.
    expect(server.calls.map(c => c.nsid)).toEqual([
      'com.atproto.repo.getRecord',
      'com.atproto.repo.putRecord',
    ])
    const first = puts(server)[0].body!
    expect(first.repo).toBe(DID)
    expect(first.collection).toBe(COLLECTION)
    expect(first.rkey).toBe('self')
    expect(first.swapRecord).toBeNull()
    expect('validate' in first).toBe(false)
    expect(first.record).toMatchObject({
      $type: COLLECTION,
      version: 1,
      backdrop: 'pride.trans',
      custom: {mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'},
    })
    expect(copy().pending).toBeNull()
    expect(copy().cid).toBe(RECORD_CID)
    expect(copy().record?.backdrop).toBe('pride.trans')

    store.savePreset(DID, 3, {mode: 'solid', a: '#111111', b: '#111111'})
    await sync.flush(DID)
    const second = puts(server)[1].body!
    expect(second.swapRecord).toBe(RECORD_CID)
    expect(second.record).toMatchObject({
      backdrop: 'pride.trans',
      presets: [{slot: 3, custom: {mode: 'solid', a: '#111111', b: '#111111'}}],
    })
  })

  it('coalesces five selections into one write after 1000 ms', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    })
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    await sync.refresh(DID)
    for (const id of [
      'pride.trans',
      'pride.bi',
      'pride.ace',
      'pride.pan',
      'materials.paper',
    ]) {
      store.selectBackdrop(DID, id)
      jest.advanceTimersByTime(300)
    }
    expect(puts(server)).toHaveLength(0)
    jest.advanceTimersByTime(1000)
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    expect(puts(server)).toHaveLength(1)
    expect(puts(server)[0].body!.record).toMatchObject({
      backdrop: 'materials.paper',
    })
  })

  it('InvalidSwap: re-read, rebase and retry', async () => {
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    await sync.refresh(DID)
    // Another device wrote meanwhile.
    server.stored = {
      value: {
        $type: COLLECTION,
        version: 1,
        backdrop: 'pride.bi',
        presets: [
          {slot: 2, custom: {mode: 'solid', a: '#222222'}, savedAt: 'y'},
        ],
        updatedAt: 'x',
      },
      cid: BLOB_CID,
    }
    store.savePreset(DID, 5, {mode: 'solid', a: '#555555', b: '#555555'})
    await sync.flush(DID)
    expect(puts(server)).toHaveLength(2)
    const record = server.stored.value
    expect(record.backdrop).toBe('pride.bi')
    expect((record.presets as {slot: number}[]).map(p => p.slot)).toEqual([
      2, 5,
    ])
    expect(copy().pending).toBeNull()
  })

  it('a 404 from putRecord re-reads; at most 2 retries', async () => {
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    await sync.refresh(DID)
    const notFound = {status: 404, body: {error: 'NotFound', message: 'gone'}}
    server.putReplies = [notFound, notFound, notFound, notFound]
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    expect(puts(server)).toHaveLength(3)
    expect(copy().pending).not.toBeNull()
    expect(copy().blocked).toBe(false)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('a network error keeps the pending edit and shows no toast', async () => {
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    await sync.refresh(DID)
    server.putError = new Error('offline')
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    expect(copy().pending).not.toBeNull()
    expect(copy().blocked).toBe(false)
    server.putReplies = [{status: 503, body: {error: 'Unavailable'}}]
    server.putError = null
    await sync.flush(DID)
    expect(copy().pending).not.toBeNull()
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('another refusal blocks and toasts once', async () => {
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    await sync.refresh(DID)
    server.putReplies = [
      {status: 400, body: {error: 'InvalidRequest', message: 'no'}},
    ]
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    expect(copy().blocked).toBe(true)
    expect(copy().pending).not.toBeNull()
    expect(mockToast).toHaveBeenCalledTimes(1)
    store.selectBackdrop(DID, 'pride.pan')
    await sync.flush(DID)
    expect(puts(server)).toHaveLength(1)
    expect(mockToast).toHaveBeenCalledTimes(1)
  })

  it('switching DID cancels the old timer and keeps its pending edit', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    })
    const alice = pds()
    sync.registerAppearanceClient(DID, alice.client)
    store.selectBackdrop(DID, 'pride.ace')
    const bob = fakeClient(BOB, () => ({status: 500, body: {}})).client
    sync.registerAppearanceClient(BOB, bob)
    jest.advanceTimersByTime(2000)
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
    expect(alice.server.calls).toHaveLength(0)
    expect(copy().pending?.appearance.backdrop).toBe('pride.ace')
  })

  it('reads when opted out; writes nothing', async () => {
    const {server, client} = pds()
    sync.registerAppearanceClient(DID, client)
    store.setOptOut(true)
    store.selectBackdrop(DID, 'pride.ace')
    expect(await sync.refresh(DID)).toBe(true)
    await sync.flush(DID)
    expect(server.calls.map(c => c.nsid)).toEqual([
      'com.atproto.repo.getRecord',
    ])
  })

  it('rebase lays the pending fields over the fresh appearance', () => {
    const fresh = {
      backdrop: 'pride.bi',
      custom: {mode: 'solid' as const, a: '#000000', b: '#000000'},
      presets: [null, null, null, null, null, null, null, null, null, null],
    }
    const pending = {
      backdrop: 'pride.ace',
      custom: {mode: 'twoTone' as const, a: '#FFFFFF', b: '#000000'},
      presets: [...fresh.presets],
    }
    pending.presets[2] = null
    const out = sync.rebase(fresh, pending, ['custom', 'preset:3'])
    expect(out.backdrop).toBe('pride.bi')
    expect(out.custom).toEqual(pending.custom)
  })
})
