/*
 * The non-member path (Phase 3 design, T12; appearance storage choice
 * design 5.2, 7.3): the record is the only truth. A record means `public`,
 * none means `device`; a `public` flush is never sent with a null CID; the
 * choice changes create or delete the record. Members of a prism that
 * doesn't list `private.appearance` take this path too.
 */

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'

import * as store from '#/horizon/appearance/store'
import * as sync from '#/horizon/appearance/sync'
import {fakeClient} from '#/horizon/private/__tests__/fixtures'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {resetMembership} from '#/horizon/routing/membership'
import {
  answerMembership,
  callsOf,
  CIDS,
  drain,
  fakePds,
  fakePrism,
  prismCallsOf,
  recordValue,
} from './harness'

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
const mockNotices = {
  showMigrationNote: jest.fn(),
  showRemovalNote: jest.fn(),
  showChoiceRefused: jest.fn(),
  showRecordBlocked: jest.fn(),
  showDeleteWarning: jest.fn(),
}
jest.mock('#/horizon/appearance/notices', () => ({
  showMigrationNote: () => mockNotices.showMigrationNote(),
  showRemovalNote: () => mockNotices.showRemovalNote(),
  showChoiceRefused: () => mockNotices.showChoiceRefused(),
  showRecordBlocked: () => mockNotices.showRecordBlocked(),
  showDeleteWarning: () => mockNotices.showDeleteWarning(),
  showTakenNote: () => {},
}))
jest.mock('#/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))
const mockLocal = new Map<string, string>()
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: (key: string) => mockLocal.get(key),
  writeLocal: (key: string, value: string | undefined) => {
    if (value === undefined) mockLocal.delete(key)
    else mockLocal.set(key, value)
  },
  subscribeLocal: () => () => {},
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

function copy(did = DID) {
  return store.getAppearanceState().device.accounts[did]
}

function stored(value = recordValue(), cid = CIDS[5]) {
  return {value, cid}
}

/** Sign in as a non-member: `notEligible`, then the first read. */
async function nonMember(initial: ReturnType<typeof stored> | null = null) {
  const pds = fakePds(DID, initial)
  sync.registerAppearanceClient(DID, pds.client)
  await answerMembership(DID, 'notEligible')
  await sync.refresh(DID)
  await drain()
  return pds
}

beforeEach(() => {
  mockJson = undefined
  mockLocal.clear()
  mockToast.mockClear()
  Object.values(mockNotices).forEach(fn => fn.mockClear())
  resetMembership()
  resetPrismFeatures()
  resetPrismHealth()
  store.resetAppearanceStoreForTests()
  sync.resetAppearanceSyncForTests()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('non-member store (section 4)', () => {
  it('reads with getRecord; RecordNotFound derives `device`', async () => {
    const {server} = await nonMember()
    const call = callsOf(server, 'getRecord')[0]
    expect(call.params.get('repo')).toBe(DID)
    expect(call.params.get('collection')).toBe(COLLECTION)
    expect(call.params.get('rkey')).toBe('self')
    expect(copy()).toMatchObject({
      store: 'device',
      storeKnown: true,
      cid: null,
      rev: null,
    })
    expect(copy().syncedAt).toBeGreaterThan(0)
  })

  it('a record derives `public`, with the record and its CID', async () => {
    await nonMember(stored())
    expect(copy().store).toBe('public')
    expect(copy().record?.backdrop).toBe('pride.bi')
    expect(copy().cid).toBe(CIDS[5])
    expect(copy().raw).toMatchObject({version: 1, backdrop: 'pride.bi'})
  })

  it('a non-member never asks prism', async () => {
    const pds = fakePds(DID, stored())
    const prism = fakePrism(DID)
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'notEligible')
    await sync.refresh(DID)
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    await drain()
    expect(prism.server.calls).toHaveLength(0)
  })

  it('a member whose prism does not list the feature decides as a non-member', async () => {
    const pds = fakePds(DID, stored())
    const prism = fakePrism(DID)
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member', {feature: false})
    await sync.refresh(DID)
    await drain()
    expect(copy().store).toBe('public')
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    expect(prism.server.calls).toHaveLength(0)
    expect(pds.server.stored?.value.backdrop).toBe('pride.ace')
    // No migration ran: the record is still there.
    expect(callsOf(pds.server, 'deleteRecord')).toHaveLength(0)
  })

  it('nothing is written while the membership is unanswered (5.5)', async () => {
    const pds = fakePds(DID, stored())
    sync.registerAppearanceClient(DID, pds.client)
    await sync.refresh(DID)
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(copy().pending?.appearance.backdrop).toBe('pride.ace')
    // The answer arrives: the held edit lands.
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(pds.server.stored?.value.backdrop).toBe('pride.ace')
    expect(copy().pending).toBeNull()
  })
})

describe('non-member flush (5.2)', () => {
  it('`public`: putRecord swapped on the CID, no validate', async () => {
    const {server} = await nonMember(stored())
    store.selectBackdrop(DID, 'pride.trans')
    await sync.flush(DID)
    const put = callsOf(server, 'putRecord')[0].body!
    expect(put.repo).toBe(DID)
    expect(put.collection).toBe(COLLECTION)
    expect(put.rkey).toBe('self')
    expect(put.swapRecord).toBe(CIDS[5])
    expect('validate' in put).toBe(false)
    expect(put.record).toMatchObject({
      $type: COLLECTION,
      version: 1,
      backdrop: 'pride.trans',
    })
    expect(copy().pending).toBeNull()
    expect(copy().cid).toBe(CIDS[0])

    store.savePreset(DID, 3, {mode: 'solid', a: '#111111', b: '#111111'})
    await sync.flush(DID)
    const second = callsOf(server, 'putRecord')[1].body!
    expect(second.swapRecord).toBe(CIDS[0])
    expect(second.record).toMatchObject({
      backdrop: 'pride.trans',
      presets: [{slot: 3, custom: {mode: 'solid', a: '#111111', b: '#111111'}}],
    })
  })

  it('`device`: an edit folds into the copy and nothing is written', async () => {
    const {server} = await nonMember()
    store.selectBackdrop(DID, 'pride.trans')
    await sync.flush(DID)
    expect(callsOf(server, 'putRecord')).toHaveLength(0)
    expect(copy().pending).toBeNull()
    expect(copy().record?.backdrop).toBe('pride.trans')
    expect(copy().store).toBe('device')
  })

  it('coalesces five selections into one write after 1000 ms', async () => {
    const {server} = await nonMember(stored())
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    })
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
    expect(callsOf(server, 'putRecord')).toHaveLength(0)
    jest.advanceTimersByTime(1000)
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    expect(callsOf(server, 'putRecord')).toHaveLength(1)
    expect(callsOf(server, 'putRecord')[0].body!.record).toMatchObject({
      backdrop: 'materials.paper',
    })
  })

  it('InvalidSwap: re-read, rebase and retry', async () => {
    const {server} = await nonMember(stored())
    // Another device wrote meanwhile.
    server.stored = {
      value: recordValue({
        backdrop: 'pride.ace',
        presets: [
          {slot: 2, custom: {mode: 'solid', a: '#222222'}, savedAt: 'y'},
        ],
      }),
      cid: CIDS[4],
    }
    store.savePreset(DID, 5, {mode: 'solid', a: '#555555', b: '#555555'})
    await sync.flush(DID)
    expect(callsOf(server, 'putRecord')).toHaveLength(2)
    const record = server.stored.value
    expect(record.backdrop).toBe('pride.ace')
    expect((record.presets as {slot: number}[]).map(p => p.slot)).toEqual([
      2, 5,
    ])
    expect(copy().pending).toBeNull()
  })

  it('a 404 from putRecord re-reads; at most 2 retries', async () => {
    const {server} = await nonMember(stored())
    const notFound = {status: 404, body: {error: 'NotFound', message: 'gone'}}
    server.next.put = [notFound, notFound, notFound, notFound]
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    expect(callsOf(server, 'putRecord')).toHaveLength(3)
    expect(copy().pending).not.toBeNull()
    expect(copy().blocked).toBe(false)
    expect(mockNotices.showRecordBlocked).not.toHaveBeenCalled()
  })

  it('a network error keeps the pending edit and shows no toast', async () => {
    const {server} = await nonMember(stored())
    server.next.put = [new Error('offline')]
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    expect(copy().pending).not.toBeNull()
    expect(copy().blocked).toBe(false)
    server.next.put = [{status: 503, body: {error: 'Unavailable'}}]
    await sync.flush(DID)
    expect(copy().pending).not.toBeNull()
    expect(mockNotices.showRecordBlocked).not.toHaveBeenCalled()
  })

  it('another refusal blocks and toasts once', async () => {
    const {server} = await nonMember(stored())
    server.next.put = [
      {status: 400, body: {error: 'InvalidRequest', message: 'no'}},
    ]
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    expect(copy().blocked).toBe(true)
    expect(copy().pending).not.toBeNull()
    expect(mockNotices.showRecordBlocked).toHaveBeenCalledTimes(1)
    store.selectBackdrop(DID, 'pride.pan')
    await sync.flush(DID)
    expect(callsOf(server, 'putRecord')).toHaveLength(1)
    expect(mockNotices.showRecordBlocked).toHaveBeenCalledTimes(1)
  })

  it('switching DID cancels the old timer and keeps its pending edit', async () => {
    const alice = await nonMember(stored())
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    })
    store.selectBackdrop(DID, 'pride.ace')
    const bob = fakeClient(BOB, () => ({status: 500, body: {}})).client
    sync.registerAppearanceClient(BOB, bob)
    jest.advanceTimersByTime(2000)
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
    expect(callsOf(alice.server, 'putRecord')).toHaveLength(0)
    expect(copy().pending?.appearance.backdrop).toBe('pride.ace')
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
    const out = sync.rebase(fresh, pending, ['custom', 'preset:3'])
    expect(out.backdrop).toBe('pride.bi')
    expect(out.custom).toEqual(pending.custom)
  })
})

describe('no `public` flush with a null CID (AS5-L2, AS6-L1)', () => {
  function nullSwapPuts(server: Parameters<typeof callsOf>[0]) {
    return callsOf(server, 'putRecord').filter(
      call => call.body?.swapRecord === null,
    )
  }

  it('sign-in refresh finding no record: an edit folds', async () => {
    const {server} = await nonMember()
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    expect(callsOf(server, 'putRecord')).toHaveLength(0)
  })

  it('foreground refresh with a pending edit, after another device deleted the record', async () => {
    const {server} = await nonMember(stored())
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    })
    store.selectBackdrop(DID, 'pride.ace')
    server.stored = null
    await sync.refresh(DID)
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    expect(nullSwapPuts(server)).toHaveLength(0)
    expect(copy().store).toBe('device')
    expect(copy().record?.backdrop).toBe('pride.ace')
  })

  it('a first flush whose own read finds no record', async () => {
    const pds = fakePds(DID)
    sync.registerAppearanceClient(DID, pds.client)
    await answerMembership(DID, 'notEligible')
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(copy().store).toBe('device')
  })

  it('a swap failure whose re-read finds no record', async () => {
    const {server} = await nonMember(stored())
    server.next.put = [{status: 400, body: {error: 'InvalidSwap'}}]
    server.stored = null
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    expect(callsOf(server, 'putRecord')).toHaveLength(1)
    expect(nullSwapPuts(server)).toHaveLength(0)
    expect(copy().store).toBe('device')
    expect(copy().pending).toBeNull()
  })
})

describe('non-member choice changes (5.2, 7.3)', () => {
  it('`device → public` creates with swapRecord: null and every field', async () => {
    const {server} = await nonMember()
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    store.chooseAppearanceStore(DID, 'public')
    await drain()
    const put = callsOf(server, 'putRecord')[0].body!
    expect(put.swapRecord).toBeNull()
    expect(put.record).toMatchObject({backdrop: 'pride.ace', version: 1})
    expect(copy()).toMatchObject({store: 'public', cid: CIDS[0], pending: null})
  })

  it('`public → device` deletes swapped on the CID; the copy keeps the value', async () => {
    const {server} = await nonMember(stored())
    store.chooseAppearanceStore(DID, 'device')
    await drain()
    const del = callsOf(server, 'deleteRecord')[0].body!
    expect(del.swapRecord).toBe(CIDS[5])
    expect(server.stored).toBeNull()
    expect(copy()).toMatchObject({store: 'device', pending: null, cid: null})
    expect(copy().record?.backdrop).toBe('pride.bi')
  })

  it('a failed delete sets `cleanup`, retried until it lands; nothing is written meanwhile', async () => {
    const {server} = await nonMember(stored())
    server.next.delete = [new Error('offline')]
    store.chooseAppearanceStore(DID, 'device')
    await drain()
    expect(copy().cleanup).toEqual({cid: CIDS[5]})
    expect(copy().store).toBe('device')
    server.next.delete = [new Error('offline')]
    store.chooseAppearanceStore(DID, 'public')
    await drain()
    expect(callsOf(server, 'putRecord')).toHaveLength(0)
    // The next trigger: the cleanup lands, then the choice of `public`.
    await sync.flush(DID)
    await drain()
    expect(copy().cleanup).toBeNull()
    expect(callsOf(server, 'deleteRecord').at(-1)?.body?.swapRecord).toBe(
      CIDS[5],
    )
    expect(copy().store).toBe('public')
  })

  it('a cleanup whose swap fails stops and derives again (AS1-L1)', async () => {
    const {server} = await nonMember(stored())
    server.next.delete = [new Error('offline')]
    store.chooseAppearanceStore(DID, 'device')
    await drain()
    // Another device chose `public` and wrote a new record.
    server.stored = {value: recordValue({backdrop: 'pride.pan'}), cid: CIDS[3]}
    await sync.flush(DID)
    await drain()
    expect(copy().cleanup).toBeNull()
    expect(server.stored?.value.backdrop).toBe('pride.pan')
    expect(copy().store).toBe('public')
    expect(copy().record?.backdrop).toBe('pride.pan')
  })

  it('two devices: A on `device` follows B to `public` and deletes nothing', async () => {
    const {server} = await nonMember()
    expect(copy().store).toBe('device')
    server.stored = {value: recordValue({backdrop: 'pride.pan'}), cid: CIDS[2]}
    await sync.refresh(DID)
    await drain()
    expect(copy().store).toBe('public')
    expect(callsOf(server, 'deleteRecord')).toHaveLength(0)
  })

  it('"Private, synced" chosen by a non-member saves on the device', async () => {
    const {server} = await nonMember()
    store.chooseAppearanceStore(DID, 'private')
    await drain()
    expect(copy().store).toBe('device')
    expect(copy().pending).toBeNull()
    expect(callsOf(server, 'putRecord')).toHaveLength(0)
  })
})

describe('prism calls behind the feature', () => {
  it('a member without `private.appearance` sends prism no appearance call', async () => {
    const pds = fakePds(DID, stored())
    const prism = fakePrism(DID)
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member', {feature: false})
    await sync.refresh(DID)
    store.chooseAppearanceStore(DID, 'device')
    await drain()
    expect(prismCallsOf(prism.server, 'getAppearance')).toHaveLength(0)
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
  })
})
