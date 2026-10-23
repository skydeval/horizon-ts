/*
 * The member path (appearance storage choice design 4, 5.1, 5.3, 6, 7.1,
 * 7.2): prism's row is the single source of truth, every write is one
 * `putAppearance` swapped on `rev`, and the public record follows prism's
 * answer through the record step. Another device is played by writing to
 * the fake servers directly, as its requests would land.
 */

import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'

import {
  type AccountCopy,
  defaultDeviceValue,
  emptyAccountCopy,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {DEFAULT_APPEARANCE} from '#/horizon/appearance/model'
import * as store from '#/horizon/appearance/store'
import * as sync from '#/horizon/appearance/sync'
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
  gate,
  prismCallsOf,
  type PrismRow,
  recordValue,
  type Stored,
} from './harness'

jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
}))
jest.mock('#/components/Toast', () => ({show: () => {}}))
const mockNotices = {
  showMigrationNote: jest.fn(),
  showRemovalNote: jest.fn(),
  showChoiceRefused: jest.fn(),
  showRecordBlocked: jest.fn(),
  showDeleteWarning: jest.fn(),
  showTooLarge: jest.fn(),
}
jest.mock('#/horizon/appearance/notices', () => ({
  showMigrationNote: () => mockNotices.showMigrationNote(),
  showRemovalNote: () => mockNotices.showRemovalNote(),
  showChoiceRefused: () => mockNotices.showChoiceRefused(),
  showRecordBlocked: () => mockNotices.showRecordBlocked(),
  showDeleteWarning: () => mockNotices.showDeleteWarning(),
  showTooLarge: () => mockNotices.showTooLarge(),
}))
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}
jest.mock('#/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLogger.warn(...args),
    error: (...args: unknown[]) => mockLogger.error(...args),
    info: (...args: unknown[]) => mockLogger.info(...args),
    debug: (...args: unknown[]) => mockLogger.debug(...args),
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

function copy(): AccountCopy {
  return store.getAppearanceState().device.accounts[DID]
}

function row(
  storeName: PrismRow['store'],
  rev = 'rev-0',
  value: Record<string, unknown> | undefined = recordValue({
    backdrop: 'pride.ace',
  }),
): PrismRow {
  return storeName === 'device'
    ? {store: storeName, rev}
    : {store: storeName, rev, appearance: value}
}

function seedCopy(partial: Partial<AccountCopy>) {
  mockJson = serializeDeviceValue({
    ...defaultDeviceValue(),
    accounts: {[DID]: {...emptyAccountCopy(), ...partial}},
  })
  store.resetAppearanceStoreForTests()
  sync.resetAppearanceSyncForTests()
}

/** Sign in as a member of a prism listing `private.appearance`. */
async function member({
  record = null,
  prismRow = null,
}: {record?: Stored; prismRow?: PrismRow | null} = {}) {
  const pds = fakePds(DID, record)
  const prism = fakePrism(DID, prismRow)
  sync.registerAppearanceClient(DID, pds.client, prism.client)
  await answerMembership(DID, 'member')
  await sync.refresh(DID)
  await drain()
  return {pds, prism}
}

/** A relaunch: memory forgotten, the device value and membership kept. */
async function relaunch(
  pds: ReturnType<typeof fakePds>,
  prism: ReturnType<typeof fakePrism>,
) {
  resetMembership()
  resetPrismFeatures()
  resetPrismHealth()
  store.resetAppearanceStoreForTests()
  sync.resetAppearanceSyncForTests()
  sync.registerAppearanceClient(DID, pds.client, prism.client)
  await answerMembership(DID, 'member')
  await sync.refresh(DID)
  await drain()
}

const PUBLIC_RECORD = {value: recordValue(), cid: CIDS[5]}

/** Network failures for every request of a method in one sign-in. */
function offline() {
  return Array.from({length: 10}, () => new Error('offline'))
}

beforeEach(() => {
  mockJson = undefined
  mockLocal.clear()
  Object.values(mockNotices).forEach(fn => fn.mockClear())
  Object.values(mockLogger).forEach(fn => fn.mockClear())
  resetMembership()
  resetPrismFeatures()
  resetPrismHealth()
  store.resetAppearanceStoreForTests()
  sync.resetAppearanceSyncForTests()
})

describe('the member table (section 4)', () => {
  it('a row: its store and value; nothing written without a disagreement', async () => {
    const {pds, prism} = await member({prismRow: row('private')})
    expect(copy()).toMatchObject({
      store: 'private',
      storeKnown: true,
      rev: 'rev-0',
      recordDue: false,
    })
    expect(copy().record?.backdrop).toBe('pride.ace')
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(callsOf(pds.server, 'deleteRecord')).toHaveLength(0)
  })

  it('a leftover record under `private` is deleted, and nothing is put to prism from it (7.2)', async () => {
    const {pds, prism} = await member({
      record: PUBLIC_RECORD,
      prismRow: row('private'),
    })
    expect(pds.server.stored).toBeNull()
    expect(callsOf(pds.server, 'deleteRecord')[0].body).not.toHaveProperty(
      'swapRecord',
    )
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(copy().recordDue).toBe(false)
    expect(copy().record?.backdrop).toBe('pride.ace')
  })

  it('a leftover under `device` is deleted', async () => {
    const {pds} = await member({record: PUBLIC_RECORD, prismRow: row('device')})
    expect(pds.server.stored).toBeNull()
  })

  it('`public` with no record, or a different one, mirrors the row', async () => {
    const value = recordValue({backdrop: 'pride.pan'})
    const none = await member({prismRow: row('public', 'rev-0', value)})
    expect(none.pds.server.stored?.value).toEqual(value)
    expect(callsOf(none.pds.server, 'putRecord')[0].body).not.toHaveProperty(
      'swapRecord',
    )
  })

  it('`public` with a record another app changed: overwritten by the row', async () => {
    const value = recordValue({backdrop: 'pride.pan'})
    const {pds} = await member({
      record: {value: recordValue({backdrop: 'pride.gay'}), cid: CIDS[4]},
      prismRow: row('public', 'rev-0', value),
    })
    expect(pds.server.stored?.value).toEqual(value)
  })

  it('no row, getRecord unanswered: nothing is put (AS8-N2)', async () => {
    const pds = fakePds(DID)
    const prism = fakePrism(DID)
    pds.server.next.get = Array.from({length: 20}, () => ({
      status: 500,
      body: {error: 'InternalServerError'},
    }))
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member')
    await sync.refresh(DID)
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    await drain()
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(copy().pending).not.toBeNull()
  })

  it('no row, no record, copy on `device` with `memberDevice`: an auto put of `device`', async () => {
    seedCopy({store: 'device', memberDevice: true, record: DEFAULT_APPEARANCE})
    const {prism} = await member()
    const put = prismCallsOf(prism.server, 'putAppearance')[0].body!
    expect(put).toEqual({store: 'device', swapRev: ''})
    expect(copy().store).toBe('device')
  })

  it('no row, no record, copy on `device` without it: the device copy moves up to `private`', async () => {
    seedCopy({
      store: 'device',
      record: {...DEFAULT_APPEARANCE, backdrop: 'pride.trans'},
    })
    const {prism} = await member()
    const put = prismCallsOf(prism.server, 'putAppearance')[0].body!
    expect(put.store).toBe('private')
    expect(put.swapRev).toBe('')
    expect(put.appearance).toMatchObject({backdrop: 'pride.trans'})
    expect(copy().store).toBe('private')
    expect(mockNotices.showMigrationNote).not.toHaveBeenCalled()
  })

  it('no row, no record, no copy: `private`, nothing put until the first edit', async () => {
    const {prism} = await member()
    expect(copy().store).toBe('private')
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    const put = prismCallsOf(prism.server, 'putAppearance')[0].body!
    expect(put.swapRev).toBe('')
    expect(put.store).toBe('private')
  })

  it('a remembered `public` with no row and no record never publishes (AS4-L1)', async () => {
    seedCopy({store: 'public', record: DEFAULT_APPEARANCE, rev: 'old'})
    const {pds, prism} = await member()
    store.selectBackdrop(DID, 'pride.ace')
    await sync.flush(DID)
    await drain()
    expect(prism.server.row?.store).toBe('private')
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
  })

  it('prism unanswered: unresolved, edits held (5.5)', async () => {
    const pds = fakePds(DID)
    const prism = fakePrism(DID, row('private'))
    prism.server.next.get = Array.from({length: 5}, () => ({
      status: 503,
      body: {error: 'Unavailable'},
    }))
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member')
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(copy().pending?.appearance.backdrop).toBe('pride.gay')
  })
})

describe('the member flush (5.1)', () => {
  it('every put carries swapRev: the rev last read or put', async () => {
    const {prism} = await member({prismRow: row('private', 'rev-7')})
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    store.selectBackdrop(DID, 'pride.pan')
    await sync.flush(DID)
    const puts = prismCallsOf(prism.server, 'putAppearance')
    expect(puts.map(call => call.body!.swapRev)).toEqual(['rev-7', 'rev-1'])
  })

  it('an edit under `private` puts to prism and sends nothing to the PDS', async () => {
    const {pds, prism} = await member({prismRow: row('private')})
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    expect(prism.server.row?.appearance).toMatchObject({backdrop: 'pride.gay'})
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(callsOf(pds.server, 'deleteRecord')).toHaveLength(0)
    expect(copy().pending).toBeNull()
  })

  it('an edit under `device` sends nothing anywhere', async () => {
    const {pds, prism} = await member({prismRow: row('device')})
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(copy().record?.backdrop).toBe('pride.gay')
    expect(copy().pending).toBeNull()
  })

  it('a choice change and an edit made together are one put', async () => {
    const {prism} = await member({prismRow: row('private')})
    store.selectBackdrop(DID, 'pride.gay')
    store.chooseAppearanceStore(DID, 'device')
    await drain()
    const puts = prismCallsOf(prism.server, 'putAppearance')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({store: 'device', swapRev: 'rev-0'})
    // The edit stays on this device.
    expect(copy().record?.backdrop).toBe('pride.gay')
    expect(copy().store).toBe('device')
  })

  it('InvalidSwap: re-read, rebase the pending fields, keep the user choice, retry', async () => {
    const {prism} = await member({prismRow: row('private')})
    // Another device edited the custom colours.
    prism.server.row = row(
      'private',
      'other-1',
      recordValue({
        backdrop: 'pride.ace',
        custom: {mode: 'solid', a: '#123456', b: '#123456'},
      }),
    )
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    const puts = prismCallsOf(prism.server, 'putAppearance')
    expect(puts.map(call => call.body!.swapRev)).toEqual(['rev-0', 'other-1'])
    expect(prism.server.row?.appearance).toMatchObject({
      backdrop: 'pride.gay',
      custom: {a: '#123456'},
    })
  })

  it('two devices of a new member, both editing with no row: both edits land', async () => {
    const {prism} = await member()
    // The other device created the row first, with its own edit.
    prism.server.row = row('private', 'other-1', recordValue({font: 'system'}))
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    expect(prism.server.row?.appearance).toMatchObject({
      backdrop: 'pride.gay',
      font: 'system',
    })
  })

  it('a device on `public` whose edit lands after another device chose `private` sends no putRecord (AS7-L4)', async () => {
    const value = recordValue({backdrop: 'pride.ace'})
    const {pds, prism} = await member({
      record: {value, cid: CIDS[5]},
      prismRow: row('public', 'rev-0', value),
    })
    // The other device put `private`; its delete is held offline.
    prism.server.row = row('private', 'other-1', value)
    const writes = callsOf(pds.server, 'putRecord').length
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(writes)
    expect(prism.server.row?.store).toBe('private')
    expect(prism.server.row?.appearance).toMatchObject({backdrop: 'pride.gay'})
    expect(copy().store).toBe('private')
    // A's next foreground deletes the record (its member table).
    await sync.refresh(DID)
    await drain()
    expect(pds.server.stored).toBeNull()
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(writes)
  })

  it('a prism read sent before a put and landing after it is dropped (5.4)', async () => {
    const {prism} = await member({prismRow: row('private')})
    const held = gate()
    prism.server.holds.get = [held]
    // Answered when released, but this read was sent before the put.
    prism.server.row = row('private', 'rev-0', recordValue({backdrop: 'x.old'}))
    const read = sync.refresh(DID, {flushAfter: false})
    await drain(3)
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    expect(copy().record?.backdrop).toBe('pride.gay')
    prism.server.row = row('private', 'rev-0', recordValue({backdrop: 'x.old'}))
    held.release()
    await read
    await drain()
    expect(copy().record?.backdrop).toBe('pride.gay')
  })

  it('a `public` choice whose re-read shows another device changed the store is dropped (AS8-N4)', async () => {
    const {pds, prism} = await member({prismRow: row('private')})
    prism.server.row = row('device', 'other-1')
    store.chooseAppearanceStore(DID, 'public')
    await drain()
    expect(prism.server.row?.store).toBe('device')
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(copy().store).toBe('device')
    expect(copy().pending).toBeNull()
    expect(mockNotices.showChoiceRefused).toHaveBeenCalledTimes(1)
  })

  it('a `public` choice whose re-read shows only an edit is kept', async () => {
    const {pds, prism} = await member({prismRow: row('private')})
    prism.server.row = row(
      'private',
      'other-1',
      recordValue({backdrop: 'pride.pan'}),
    )
    store.chooseAppearanceStore(DID, 'public')
    await drain()
    expect(prism.server.row?.store).toBe('public')
    expect(pds.server.stored?.value).toMatchObject({backdrop: 'pride.pan'})
  })
})

describe('choice changes (7.1)', () => {
  const cases: [PrismRow['store'], PrismRow['store']][] = [
    ['private', 'public'],
    ['private', 'device'],
    ['public', 'private'],
    ['public', 'device'],
    ['device', 'private'],
    ['device', 'public'],
  ]
  for (const [from, to] of cases) {
    it(`${from} → ${to}`, async () => {
      const value = recordValue({backdrop: 'pride.ace'})
      if (from === 'device') {
        seedCopy({
          store: 'device',
          memberDevice: true,
          record: {...DEFAULT_APPEARANCE, backdrop: 'pride.trans'},
        })
      }
      const {pds, prism} = await member({
        record: from === 'public' ? {value, cid: CIDS[5]} : null,
        prismRow: row(from, 'rev-0', value),
      })
      store.chooseAppearanceStore(DID, to)
      await drain()
      const put = prismCallsOf(prism.server, 'putAppearance').at(-1)!.body!
      expect(put.store).toBe(to)
      expect(put.swapRev).toBe('rev-0')
      expect(put.appearance === undefined).toBe(to === 'device')
      expect(prism.server.row?.store).toBe(to)
      expect(copy().store).toBe(to)
      expect(copy().pending).toBeNull()
      expect(copy().recordDue).toBe(false)
      // The record follows: only `public` has one.
      if (to === 'public') {
        expect(pds.server.stored?.value).toEqual(prism.server.row?.appearance)
      } else {
        expect(pds.server.stored).toBeNull()
      }
      if (from === 'device') {
        // The device copy moves up.
        if (to !== 'device') {
          expect(prism.server.row?.appearance).toMatchObject({
            backdrop: 'pride.trans',
          })
        }
      }
    })
  }

  it('a permanent refusal reverts the radio and toasts', async () => {
    const {prism} = await member({prismRow: row('private')})
    prism.server.next.put = [
      {status: 400, body: {error: 'InvalidRequest', message: 'no'}},
    ]
    store.chooseAppearanceStore(DID, 'public')
    await drain()
    expect(copy().pending).toBeNull()
    expect(copy().store).toBe('private')
    expect(mockNotices.showChoiceRefused).toHaveBeenCalledTimes(1)
  })

  it('changing again before the put lands sends only the last choice', async () => {
    const {prism} = await member({prismRow: row('private')})
    const held = gate()
    prism.server.holds.put = [held]
    store.chooseAppearanceStore(DID, 'public')
    await drain(3)
    store.chooseAppearanceStore(DID, 'device')
    held.release()
    await drain()
    expect(prism.server.row?.store).toBe('device')
    expect(copy().store).toBe('device')
  })

  it('a move off `private` after another device’s edit carries that edit', async () => {
    const {prism} = await member({prismRow: row('private')})
    prism.server.row = row(
      'private',
      'other-1',
      recordValue({backdrop: 'pride.pan'}),
    )
    store.chooseAppearanceStore(DID, 'public')
    await drain()
    expect(prism.server.row?.appearance).toMatchObject({backdrop: 'pride.pan'})
  })
})

describe('the record step (5.3)', () => {
  it('after a put answering `public`: putRecord of the answered value, no swapRecord, then a prism read', async () => {
    const {pds, prism} = await member({prismRow: row('private')})
    const reads = prismCallsOf(prism.server, 'getAppearance').length
    store.chooseAppearanceStore(DID, 'public')
    await drain()
    const put = callsOf(pds.server, 'putRecord')[0].body!
    expect(put).not.toHaveProperty('swapRecord')
    expect(put.record).toEqual(prism.server.row?.appearance)
    expect(prismCallsOf(prism.server, 'getAppearance').length).toBe(reads + 1)
  })

  it('after a put leaving `public`: deleteRecord, no swapRecord; RecordNotFound counts as done', async () => {
    const value = recordValue()
    const {pds, prism} = await member({
      record: {value, cid: CIDS[5]},
      prismRow: row('public', 'rev-0', value),
    })
    pds.server.next.delete = [
      {status: 400, body: {error: 'RecordNotFound', message: 'none'}},
    ]
    store.chooseAppearanceStore(DID, 'private')
    await drain()
    expect(callsOf(pds.server, 'deleteRecord')[0].body).not.toHaveProperty(
      'swapRecord',
    )
    expect(copy().recordDue).toBe(false)
    expect(prism.server.row?.store).toBe('private')
  })

  /*
   * The race: A on `public` mirrors while B puts `private` and deletes. B's
   * put and delete are played on the servers at each point of A's step.
   */
  const raceOrders = [
    'before A’s mirror lands',
    'after A’s mirror, before A’s read',
    'after A’s read',
  ] as const
  for (const when of raceOrders) {
    it(`A mirrors, B switches to private and deletes ${when}: no record`, async () => {
      const value = recordValue({backdrop: 'pride.ace'})
      const {pds, prism} = await member({
        record: {value, cid: CIDS[5]},
        prismRow: row('public', 'rev-0', value),
      })
      const mirror = gate()
      const read = gate()
      pds.server.holds.put = [mirror]
      const bSwitches = () => {
        prism.server.row = row('private', 'b-1', prism.server.row?.appearance)
        pds.server.stored = null
      }
      store.selectBackdrop(DID, 'pride.gay')
      const run = sync.flush(DID)
      await drain(5)
      prism.server.holds.get = [read]
      if (when === 'before A’s mirror lands') bSwitches()
      mirror.release()
      await drain(5)
      if (when === 'after A’s mirror, before A’s read') bSwitches()
      read.release()
      await drain(5)
      if (when === 'after A’s read') bSwitches()
      await run
      await drain()
      if (when === 'after A’s read') {
        // B's own step deleted it; A finished while `public`.
        expect(pds.server.stored).toBeNull()
      } else {
        expect(pds.server.stored).toBeNull()
        expect(copy().store).toBe('private')
        expect(copy().recordDue).toBe(false)
      }
    })
  }

  const reverseOrders = [
    'before A’s delete lands',
    'after A’s delete, before A’s read',
    'after A’s read',
  ] as const
  for (const when of reverseOrders) {
    it(`A deletes, B puts public and mirrors ${when}: B’s value in the record`, async () => {
      const value = recordValue({backdrop: 'pride.ace'})
      const bValue = recordValue({backdrop: 'pride.pan'})
      const {pds, prism} = await member({
        record: {value, cid: CIDS[5]},
        prismRow: row('public', 'rev-0', value),
      })
      const del = gate()
      const read = gate()
      pds.server.holds.delete = [del]
      const bPublishes = () => {
        prism.server.row = row('public', 'b-1', bValue)
        pds.server.stored = {value: bValue, cid: CIDS[3]}
      }
      store.chooseAppearanceStore(DID, 'private')
      await drain(5)
      prism.server.holds.get = [read]
      if (when === 'before A’s delete lands') bPublishes()
      del.release()
      await drain(5)
      if (when === 'after A’s delete, before A’s read') bPublishes()
      read.release()
      await drain(5)
      if (when === 'after A’s read') bPublishes()
      await drain()
      // A's next foreground repairs anything it finished before B wrote.
      await sync.refresh(DID)
      await drain()
      expect(pds.server.stored?.value).toEqual(bValue)
    })
  }

  it('two devices editing under `public`: the record ends with the last rev’s value', async () => {
    const value = recordValue({backdrop: 'pride.ace'})
    const {pds, prism} = await member({
      record: {value, cid: CIDS[5]},
      prismRow: row('public', 'rev-0', value),
    })
    const mirror = gate()
    pds.server.holds.put = [mirror]
    store.selectBackdrop(DID, 'pride.gay')
    const run = sync.flush(DID)
    await drain(5)
    // B's edit lands in prism and its mirror lands first.
    const bValue = recordValue({backdrop: 'pride.pan'})
    prism.server.row = row('public', 'b-1', bValue)
    pds.server.stored = {value: bValue, cid: CIDS[3]}
    mirror.release()
    await run
    await drain()
    expect(pds.server.stored?.value).toEqual(bValue)
    expect(copy().recordDue).toBe(false)
  })

  it('a restart between step 1 and step 2 resumes and finishes', async () => {
    const value = recordValue()
    const {pds, prism} = await member({
      record: {value, cid: CIDS[5]},
      prismRow: row('public', 'rev-0', value),
    })
    prism.server.next.get = [{status: 503, body: {error: 'Unavailable'}}]
    store.chooseAppearanceStore(DID, 'private')
    await drain()
    expect(copy().recordDue).toBe(true)
    // Another app (or an older build) wrote it back meanwhile.
    pds.server.stored = {value, cid: CIDS[2]}
    await relaunch(pds, prism)
    expect(pds.server.stored).toBeNull()
    expect(copy().recordDue).toBe(false)
  })

  it('a permanent putRecord refusal sets `blocked` and toasts once', async () => {
    const {pds} = await member({prismRow: row('private')})
    pds.server.next.put = [
      {status: 400, body: {error: 'InvalidRequest', message: 'no'}},
    ]
    store.chooseAppearanceStore(DID, 'public')
    await drain()
    expect(copy().blocked).toBe(true)
    expect(mockNotices.showRecordBlocked).toHaveBeenCalledTimes(1)
  })

  it('a permanent deleteRecord refusal keeps `recordDue` and shows the warning', async () => {
    const {pds} = await member({
      record: PUBLIC_RECORD,
      prismRow: row('public', 'rev-0', PUBLIC_RECORD.value),
    })
    pds.server.next.delete = [
      {status: 400, body: {error: 'InvalidRequest', message: 'no'}},
    ]
    store.chooseAppearanceStore(DID, 'private')
    await drain()
    expect(copy().recordDue).toBe(true)
    expect(mockNotices.showDeleteWarning).toHaveBeenCalledTimes(1)
  })
})

describe('the migration (section 6)', () => {
  it('happy path: copy to prism as `private`, delete the record, the note once', async () => {
    const {pds, prism} = await member({record: PUBLIC_RECORD})
    const put = prismCallsOf(prism.server, 'putAppearance')[0].body!
    expect(put.store).toBe('private')
    expect(put.swapRev).toBe('')
    expect(put.appearance).toMatchObject({backdrop: 'pride.bi'})
    expect(pds.server.stored).toBeNull()
    expect(copy()).toMatchObject({
      store: 'private',
      noteDue: false,
      noted: true,
      recordDue: false,
    })
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
    await sync.refresh(DID)
    await drain()
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(1)
  })

  it('a pending edit rides along and the verify passes', async () => {
    const pds = fakePds(DID, PUBLIC_RECORD)
    const prism = fakePrism(DID)
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    store.selectBackdrop(DID, 'pride.gay')
    await answerMembership(DID, 'member')
    await sync.refresh(DID)
    await drain()
    expect(prism.server.row?.appearance).toMatchObject({backdrop: 'pride.gay'})
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(1)
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
    expect(pds.server.stored).toBeNull()
  })

  it('two devices at once: the loser drops the auto store, keeps its edits, and follows the row', async () => {
    const pds = fakePds(DID, PUBLIC_RECORD)
    const prism = fakePrism(DID)
    const held = gate()
    prism.server.holds.put = [held]
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member')
    await drain(5)
    store.selectBackdrop(DID, 'pride.gay')
    // The other device migrated first.
    prism.server.row = row('private', 'other-1', PUBLIC_RECORD.value)
    held.release()
    await drain()
    await sync.flush(DID)
    await drain()
    expect(prism.server.row?.store).toBe('private')
    expect(prism.server.row?.appearance).toMatchObject({backdrop: 'pride.gay'})
    expect(copy().pending).toBeNull()
    expect(pds.server.stored).toBeNull()
  })

  it('a migration put that fails transiently deletes nothing (AS8-N1)', async () => {
    const pds = fakePds(DID, PUBLIC_RECORD)
    const prism = fakePrism(DID)
    prism.server.next.put = Array.from({length: 4}, () => ({
      status: 503,
      body: {error: 'Unavailable'},
    }))
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member')
    await sync.refresh(DID)
    await drain()
    expect(callsOf(pds.server, 'deleteRecord')).toHaveLength(0)
    expect(copy().recordDue).toBe(false)
    expect(copy().pending?.auto).toBe(true)
  })

  it('a verify mismatch deletes nothing on this device and shows no note', async () => {
    const pds = fakePds(DID, PUBLIC_RECORD)
    const prism = fakePrism(DID)
    prism.server.next.put = [
      {
        status: 200,
        body: {
          store: 'private',
          rev: 'rev-x',
          appearance: recordValue({backdrop: 'something.else'}),
        },
      },
    ]
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member')
    await sync.refresh(DID)
    await drain()
    expect(pds.server.stored).not.toBeNull()
    expect(mockNotices.showMigrationNote).not.toHaveBeenCalled()
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('a restart after step 1 (the delete failed): the note shows once, on resume', async () => {
    const pds = fakePds(DID, PUBLIC_RECORD)
    const prism = fakePrism(DID)
    pds.server.next.delete = offline()
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member')
    await sync.refresh(DID)
    await drain()
    expect(copy()).toMatchObject({recordDue: true, noteDue: true})
    expect(mockNotices.showMigrationNote).not.toHaveBeenCalled()
    pds.server.next.delete = []
    await relaunch(pds, prism)
    expect(pds.server.stored).toBeNull()
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
    await relaunch(pds, prism)
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
  })

  it('no note if a read says `public` before the delete is confirmed', async () => {
    const pds = fakePds(DID, PUBLIC_RECORD)
    const prism = fakePrism(DID)
    pds.server.next.delete = offline()
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member')
    await sync.refresh(DID)
    await drain()
    expect(copy().noteDue).toBe(true)
    // The user chose `public` on another device meanwhile.
    prism.server.row = row('public', 'other-1', PUBLIC_RECORD.value)
    pds.server.next.delete = []
    await relaunch(pds, prism)
    expect(copy().noteDue).toBe(false)
    expect(mockNotices.showMigrationNote).not.toHaveBeenCalled()
    expect(pds.server.stored?.value).toEqual(PUBLIC_RECORD.value)
  })

  it('a non-member who joins with a public record is migrated, with the note', async () => {
    const pds = fakePds(DID, PUBLIC_RECORD)
    const prism = fakePrism(DID)
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'notEligible')
    await sync.refresh(DID)
    await drain()
    expect(copy().store).toBe('public')
    await answerMembership(DID, 'member')
    await drain()
    expect(prism.server.row?.store).toBe('private')
    expect(pds.server.stored).toBeNull()
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
  })

  it('no migration while prism does not list the feature', async () => {
    const pds = fakePds(DID, PUBLIC_RECORD)
    const prism = fakePrism(DID)
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member', {feature: false})
    await sync.refresh(DID)
    await drain()
    expect(prism.server.calls).toHaveLength(0)
    expect(pds.server.stored).not.toBeNull()
    expect(copy().store).toBe('public')
  })
})

describe('prism’s 16 KiB cap (prism reply)', () => {
  /** A legacy record over the cap: an unbounded `custom.mode` from another app. */
  const HUGE = {
    value: recordValue({
      custom: {mode: 'x'.repeat(17 * 1024), a: '#FFE2FF', b: '#CCFFFF'},
    }),
    cid: CIDS[5],
  }

  it('the migration of an oversize record is never sent: stays public, marked, the note’s line once', async () => {
    const {pds, prism} = await member({record: HUGE})
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(pds.server.stored).toEqual(HUGE)
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(callsOf(pds.server, 'deleteRecord')).toHaveLength(0)
    expect(copy()).toMatchObject({
      store: 'public',
      tooLarge: true,
      tooLargeLine: true,
      noteDue: false,
      pending: null,
    })
    expect(mockNotices.showMigrationNote).not.toHaveBeenCalled()
    expect(mockNotices.showChoiceRefused).not.toHaveBeenCalled()
    expect(mockNotices.showTooLarge).not.toHaveBeenCalled()
  })

  it('no retry at sign-in, and the line shows once per account on this device', async () => {
    const {pds, prism} = await member({record: HUGE})
    store.dismissAppearanceNote(DID)
    expect(copy().tooLargeLine).toBe(false)
    await relaunch(pds, prism)
    await relaunch(pds, prism)
    expect(prism.server.row).toBeNull()
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(pds.server.stored).toEqual(HUGE)
    expect(copy()).toMatchObject({
      store: 'public',
      tooLarge: true,
      tooLargeLine: false,
      pending: null,
    })
  })

  it('prism’s own size refusal of the `auto` put: marked the same, and not retried', async () => {
    const {pds, prism} = await (async () => {
      const pds = fakePds(DID, PUBLIC_RECORD)
      const prism = fakePrism(DID)
      prism.server.next.put = [
        {
          status: 400,
          body: {
            error: 'InvalidRequest',
            message: 'Error: appearance is too large (16384 bytes at most)',
          },
        },
      ]
      sync.registerAppearanceClient(DID, pds.client, prism.client)
      await answerMembership(DID, 'member')
      await sync.refresh(DID)
      await drain()
      return {pds, prism}
    })()
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(1)
    expect(copy()).toMatchObject({
      store: 'public',
      tooLarge: true,
      tooLargeLine: true,
      pending: null,
    })
    expect(mockNotices.showChoiceRefused).not.toHaveBeenCalled()
    await relaunch(pds, prism)
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(1)
    expect(pds.server.stored).toEqual(PUBLIC_RECORD)
  })

  it('an edit that stays over the cap is kept on this device and not sent', async () => {
    const {pds, prism} = await member({record: HUGE})
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(pds.server.stored).toEqual(HUGE)
    expect(copy().pending?.appearance.backdrop).toBe('pride.gay')
    expect(copy().pending?.store).toBeUndefined()
    expect(copy().store).toBe('public')
  })

  it('an edit that brings it under the cap runs the migration again', async () => {
    const {pds, prism} = await member({record: HUGE})
    store.applyCustom(DID, {mode: 'twoTone', a: '#112233', b: '#445566'})
    await sync.flush(DID)
    await drain()
    const put = prismCallsOf(prism.server, 'putAppearance')[0].body!
    expect(put.store).toBe('private')
    expect(put.swapRev).toBe('')
    expect(prism.server.row?.appearance).toMatchObject({
      custom: {mode: 'twoTone', a: '#112233', b: '#445566'},
    })
    expect(pds.server.stored).toBeNull()
    expect(copy()).toMatchObject({
      store: 'private',
      tooLarge: false,
      tooLargeLine: false,
    })
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
  })

  it('a user’s move to “Private, synced” over the cap: the same text as a toast, the old choice kept', async () => {
    const {pds, prism} = await member({record: HUGE})
    store.chooseAppearanceStore(DID, 'private')
    await drain()
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(mockNotices.showTooLarge).toHaveBeenCalledTimes(1)
    expect(mockNotices.showChoiceRefused).not.toHaveBeenCalled()
    expect(copy().store).toBe('public')
    expect(copy().pending).toBeNull()
    expect(pds.server.stored).toEqual(HUGE)
  })

  it('a user’s move refused by prism for its size: the same toast, the old choice kept', async () => {
    const {prism} = await member({prismRow: row('device')})
    prism.server.next.put = [
      {
        status: 400,
        body: {
          error: 'InvalidRequest',
          message: 'Error: appearance is too large (16384 bytes at most)',
        },
      },
    ]
    store.chooseAppearanceStore(DID, 'private')
    await drain()
    expect(mockNotices.showTooLarge).toHaveBeenCalledTimes(1)
    expect(mockNotices.showChoiceRefused).not.toHaveBeenCalled()
    expect(copy().store).toBe('device')
    expect(copy().pending).toBeNull()
    expect(prism.server.row?.store).toBe('device')
  })

  it('“This device only” still works while the migration is blocked', async () => {
    const {pds, prism} = await member({record: HUGE})
    store.chooseAppearanceStore(DID, 'device')
    await drain()
    expect(prism.server.row?.store).toBe('device')
    expect(pds.server.stored).toBeNull()
    expect(copy()).toMatchObject({
      store: 'device',
      tooLarge: false,
      tooLargeLine: false,
    })
  })
})

describe('legacy and unknown fields (prism reply)', () => {
  const LEGACY = recordValue({
    backdrop: 'pride.ace',
    futureField: {nested: [1, 2, 3]},
    custom: {mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF', glow: 'soft'},
    presets: [
      {
        slot: 1,
        custom: {mode: 'solid', a: '#000000'},
        savedAt: '2026-10-01T00:00:00.000Z',
        name: 'a\u0000b',
      },
      {slot: 11, custom: {mode: 'solid', a: '#FFFFFF'}, savedAt: 'x'},
      {legacy: true},
    ],
  })

  it('a row with them parses, and an edit keeps them exactly', async () => {
    const {prism} = await member({prismRow: row('private', 'rev-0', LEGACY)})
    expect(copy().record?.backdrop).toBe('pride.ace')
    expect(copy().record?.presets[0]?.name).toBe('a\u0000b')
    expect(copy().raw).toMatchObject({futureField: {nested: [1, 2, 3]}})
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    const sent = prismCallsOf(prism.server, 'putAppearance')[0].body!
      .appearance as Record<string, unknown>
    const {updatedAt: _a, backdrop: _b, ...kept} = sent
    const {updatedAt: _c, backdrop: _d, ...legacy} = LEGACY
    expect(kept).toEqual(legacy)
    expect(sent.backdrop).toBe('pride.gay')
  })

  it('the migration sends a legacy record’s fields as read', async () => {
    const {pds, prism} = await member({record: {value: LEGACY, cid: CIDS[5]}})
    const sent = prismCallsOf(prism.server, 'putAppearance')[0].body!
      .appearance as Record<string, unknown>
    const {updatedAt: _a, ...kept} = sent
    const {updatedAt: _b, ...legacy} = LEGACY
    expect(kept).toEqual(legacy)
    expect(copy().store).toBe('private')
    expect(pds.server.stored).toBeNull()
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
  })
})
