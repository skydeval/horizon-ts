/*
 * Removal and rejoining (appearance storage choice design 8.2 to 8.5) and
 * the dev fault `not-enrolled` (11.1).
 */

import {XrpcResponseError} from '@atproto/lex'
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
import {fakeClient} from '#/horizon/private/__tests__/fixtures'
import {
  DEV_PRISM_FAULT_KEY,
  withDevFault,
} from '#/horizon/private/api/dev-fault'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {
  getMembership,
  reportPrismError,
  resetMembership,
  startMembershipProbe,
} from '#/horizon/routing/membership'
import {
  answerMembership,
  callsOf,
  CIDS,
  drain,
  fakePds,
  fakePrism,
  prismCallsOf,
  type PrismRow,
  recordValue,
  removeFromPrism,
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
  showTakenNote: jest.fn(),
}
jest.mock('#/horizon/appearance/notices', () => ({
  showMigrationNote: () => mockNotices.showMigrationNote(),
  showRemovalNote: () => mockNotices.showRemovalNote(),
  showTakenNote: () => mockNotices.showTakenNote(),
  showChoiceRefused: () => mockNotices.showChoiceRefused(),
  showRecordBlocked: () => mockNotices.showRecordBlocked(),
  showDeleteWarning: () => mockNotices.showDeleteWarning(),
}))
jest.mock('#/logger', () => ({
  logger: {warn: () => {}, error: () => {}, info: () => {}, debug: () => {}},
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
  value: Record<string, unknown> = recordValue({backdrop: 'pride.ace'}),
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
  // A new launch of a device: nothing answered yet in this run.
  resetMembership()
  resetPrismFeatures()
  store.resetAppearanceStoreForTests()
  sync.resetAppearanceSyncForTests()
}

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

/** prism's appearance calls since `from`. */
function appearanceCalls(prism: ReturnType<typeof fakePrism>, from = 0) {
  return prism.server.calls
    .slice(from)
    .filter(call => call.nsid.startsWith('app.nearhorizon.private.'))
}

function xrpcError(status: number, error: string) {
  const response = new Response(JSON.stringify({error, message: error}), {
    status,
    headers: {'content-type': 'application/json'},
  })
  return new XrpcResponseError(
    {nsid: 'app.nearhorizon.private.getAppearance'} as never,
    response,
    {encoding: 'application/json', body: {error, message: error}} as never,
  )
}

beforeEach(() => {
  mockJson = undefined
  mockLocal.clear()
  Object.values(mockNotices).forEach(fn => fn.mockClear())
  resetMembership()
  resetPrismFeatures()
  resetPrismHealth()
  store.resetAppearanceStoreForTests()
  sync.resetAppearanceSyncForTests()
})

describe('removal detection (8.2)', () => {
  it('`notEligible` starts the removal flow; the take only reads prism', async () => {
    const {prism} = await member({prismRow: row('private')})
    const sent = prism.server.calls.length
    removeFromPrism(prism.server)
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy()).toMatchObject({store: 'device', rev: null})
    const calls = appearanceCalls(prism, sent)
    expect(calls.map(call => call.nsid)).toEqual([
      'app.nearhorizon.private.getAppearance',
    ])
    expect(calls[0].params.get('includeRetained')).toBe('true')
    expect(mockNotices.showTakenNote).toHaveBeenCalledTimes(1)
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
  })

  it('a private call’s `NotEnrolled` starts it', async () => {
    const {prism} = await member({prismRow: row('private')})
    removeFromPrism(prism.server)
    reportPrismError(DID, xrpcError(400, 'NotEnrolled'))
    await drain()
    expect(getMembership(DID)).toBe('not-member')
    expect(copy()).toMatchObject({store: 'device', rev: null})
    expect(mockNotices.showTakenNote).toHaveBeenCalledTimes(1)
  })

  const notRemoval: [string, () => Promise<void> | void][] = [
    ['indexing', () => answerMembership(DID, 'indexing')],
    ['NotReady', () => reportPrismError(DID, xrpcError(400, 'NotReady'))],
    ['Reindexing', () => reportPrismError(DID, xrpcError(503, 'Reindexing'))],
    ['a 5xx', () => reportPrismError(DID, xrpcError(500, 'Internal'))],
    ['a 429', () => reportPrismError(DID, xrpcError(429, 'RateLimited'))],
    [
      'a 501',
      () => reportPrismError(DID, xrpcError(501, 'MethodNotImplemented')),
    ],
    ['a timeout', () => reportPrismError(DID, new Error('timeout'))],
  ]
  for (const [name, act] of notRemoval) {
    it(`${name} starts nothing`, async () => {
      await member({prismRow: row('private')})
      await act()
      await drain()
      expect(copy().store).toBe('private')
      expect(copy().rev).toBe('rev-0')
      expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
    })
  }

  it('a missing feature: decided as a non-member, with no note', async () => {
    const {prism} = await member({prismRow: row('private')})
    const sent = prism.server.calls.length
    await answerMembership(DID, 'member', {feature: false})
    await drain()
    expect(copy().store).toBe('device')
    expect(appearanceCalls(prism, sent)).toHaveLength(0)
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
  })
})

describe('the removal flow (8.3)', () => {
  it('signed in at removal: a pending edit is kept over the copy, nothing written to prism', async () => {
    const {pds, prism} = await member({prismRow: row('private')})
    const held = prism.server.calls.length
    removeFromPrism(prism.server)
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    // The put itself got `NotEnrolled`; after it, only the take's read.
    expect(appearanceCalls(prism, held).map(call => call.nsid)).toEqual([
      'app.nearhorizon.private.putAppearance',
      'app.nearhorizon.private.getAppearance',
    ])
    expect(copy().store).toBe('device')
    expect(copy().record?.backdrop).toBe('pride.gay')
    expect(copy().fallback?.fields).toEqual(['backdrop'])
    expect(callsOf(pds.server, 'putRecord')).toHaveLength(0)
    expect(mockNotices.showTakenNote).toHaveBeenCalledTimes(1)
  })

  it('nothing folds or flushes before getRecord answers', async () => {
    const {pds} = await member({prismRow: row('private')})
    pds.server.next.get = Array.from({length: 6}, () => ({
      status: 500,
      body: {error: 'InternalServerError'},
    }))
    store.selectBackdrop(DID, 'pride.gay')
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy().pending?.appearance.backdrop).toBe('pride.gay')
    expect(copy().storeKnown).toBe(false)
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
  })

  it('a record present: `public`, pending rebased and flushed with its CID, no note', async () => {
    const {pds} = await member({prismRow: row('private')})
    pds.server.stored = {value: recordValue({backdrop: 'pride.pan'}), cid: CIDS[4]}
    store.selectBackdrop(DID, 'pride.gay')
    await answerMembership(DID, 'notEligible')
    await drain()
    await sync.flush(DID)
    expect(copy().store).toBe('public')
    const put = callsOf(pds.server, 'putRecord').at(-1)!.body!
    expect(put.swapRecord).toBe(CIDS[4])
    expect(put.record).toMatchObject({backdrop: 'pride.gay'})
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
  })

  it('no record and nothing retained: `device`, the note when it was `private`, once per removal', async () => {
    const {prism} = await member({prismRow: row('private')})
    // prism kept nothing (a purge, or another device released it).
    prism.server.member = false
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy()).toMatchObject({
      store: 'device',
      removalNoted: true,
      removalLine: true,
      removalTaken: false,
      take: null,
      fallback: {fields: [], rev: 'rev-0'},
    })
    await sync.refresh(DID)
    await drain()
    expect(mockNotices.showRemovalNote).toHaveBeenCalledTimes(1)
  })

  it('no note when it was `device` already', async () => {
    const {prism} = await member({prismRow: row('device')})
    removeFromPrism(prism.server)
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy().store).toBe('device')
    expect(copy().take).toBeNull()
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
    expect(mockNotices.showTakenNote).not.toHaveBeenCalled()
  })

  it('a due delete becomes `cleanup`, and the derivation gives `device`', async () => {
    const value = recordValue()
    const pds = fakePds(DID, {value, cid: CIDS[5]})
    seedCopy({
      store: 'private',
      rev: 'rev-0',
      record: DEFAULT_APPEARANCE,
      raw: {},
      recordDue: true,
    })
    sync.registerAppearanceClient(DID, pds.client, fakePrism(DID).client)
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy().store).toBe('device')
    expect(copy().recordDue).toBe(false)
    expect(copy().cleanup).toEqual({cid: CIDS[5]})
    // The cleanup runs on the next trigger, swapped on the CID read.
    await sync.flush(DID)
    await drain()
    expect(callsOf(pds.server, 'deleteRecord').at(-1)?.body?.swapRecord).toBe(
      CIDS[5],
    )
    expect(pds.server.stored).toBeNull()
  })

  it('a due mirror updates an existing record and creates none', async () => {
    const mirrored = recordValue({backdrop: 'pride.pan'})
    const {$type: _type, ...raw} = mirrored
    seedCopy({
      store: 'public',
      rev: 'rev-0',
      record: DEFAULT_APPEARANCE,
      raw,
      recordDue: true,
    })
    const pds = fakePds(DID, {value: recordValue(), cid: CIDS[5]})
    sync.registerAppearanceClient(DID, pds.client, fakePrism(DID).client)
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(callsOf(pds.server, 'putRecord')[0].body?.swapRecord).toBe(CIDS[5])
    expect(pds.server.stored?.value).toMatchObject({backdrop: 'pride.pan'})
    expect(copy().store).toBe('public')

    seedCopy({store: 'public', rev: 'rev-0', raw, recordDue: true})
    const empty = fakePds(DID)
    sync.registerAppearanceClient(DID, empty.client, fakePrism(DID).client)
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(callsOf(empty.server, 'putRecord')).toHaveLength(0)
    expect(copy().store).toBe('device')
  })

  it('a user’s pending `private` ends on `device`, the record deleted; `public` ends on `public`', async () => {
    const value = recordValue()
    seedCopy({
      store: 'public',
      rev: 'rev-0',
      record: DEFAULT_APPEARANCE,
      raw: {},
      pending: {fields: [], appearance: DEFAULT_APPEARANCE, seq: 1, store: 'private'},
    })
    const pds = fakePds(DID, {value, cid: CIDS[5]})
    const empty = fakePrism(DID)
    empty.server.member = false
    sync.registerAppearanceClient(DID, pds.client, empty.client)
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy().store).toBe('device')
    expect(pds.server.stored).toBeNull()
    expect(mockNotices.showRemovalNote).toHaveBeenCalledTimes(1)

    seedCopy({
      store: 'private',
      rev: 'rev-0',
      record: DEFAULT_APPEARANCE,
      pending: {fields: [], appearance: DEFAULT_APPEARANCE, seq: 1, store: 'public'},
    })
    const none = fakePds(DID)
    sync.registerAppearanceClient(DID, none.client, fakePrism(DID).client)
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy().store).toBe('public')
    expect(callsOf(none.server, 'putRecord')[0].body?.swapRecord).toBeNull()
  })

  it('an auto migration put that never landed ends on `public` with the record kept (AS7-N3)', async () => {
    const value = recordValue()
    seedCopy({
      store: 'public',
      rev: '',
      record: DEFAULT_APPEARANCE,
      raw: {},
      noteDue: true,
      pending: {
        fields: [],
        appearance: DEFAULT_APPEARANCE,
        seq: 1,
        store: 'private',
        auto: true,
      },
    })
    const pds = fakePds(DID, {value, cid: CIDS[5]})
    sync.registerAppearanceClient(DID, pds.client, fakePrism(DID).client)
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy().store).toBe('public')
    expect(copy().pending).toBeNull()
    expect(pds.server.stored?.value).toEqual(value)
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
  })

  it('a fresh device with nothing retained: `device`, its own look, no note', async () => {
    const pds = fakePds(DID)
    const prism = fakePrism(DID)
    prism.server.member = false
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'notEligible')
    await sync.refresh(DID)
    await drain()
    expect(copy()).toMatchObject({store: 'device', take: null, fallback: null})
    expect(prismCallsOf(prism.server, 'getAppearance')).toHaveLength(1)
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
  })
})

describe('rejoining (8.5)', () => {
  it('a record present: migrated, with the note', async () => {
    seedCopy({store: 'public', record: DEFAULT_APPEARANCE, raw: {}})
    const {prism, pds} = await member({record: {value: recordValue(), cid: CIDS[5]}})
    expect(prism.server.row?.store).toBe('private')
    expect(pds.server.stored).toBeNull()
    expect(mockNotices.showMigrationNote).toHaveBeenCalledTimes(1)
  })

  it('a record whose CID is this device’s `cleanup` CID counts as none', async () => {
    seedCopy({
      store: 'device',
      record: DEFAULT_APPEARANCE,
      cleanup: {cid: CIDS[5]},
    })
    const pds = fakePds(DID, {value: recordValue(), cid: CIDS[5]})
    const prism = fakePrism(DID)
    pds.server.next.delete = [new Error('offline'), new Error('offline')]
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member')
    await sync.refresh(DID)
    await drain()
    expect(prism.server.row?.store).toBe('private')
    expect(mockNotices.showMigrationNote).not.toHaveBeenCalled()
  })

  it('`device` with `memberDevice` stays `device`; without it moves up', async () => {
    seedCopy({store: 'device', memberDevice: true, record: DEFAULT_APPEARANCE})
    const kept = await member()
    expect(kept.prism.server.row?.store).toBe('device')
    seedCopy({store: 'device', record: DEFAULT_APPEARANCE})
    const moved = await member()
    expect(moved.prism.server.row?.store).toBe('private')
  })

  it('two devices at once: the loser follows the row and its pending edit lands', async () => {
    seedCopy({store: 'device', record: DEFAULT_APPEARANCE})
    const pds = fakePds(DID)
    const prism = fakePrism(DID)
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    store.selectBackdrop(DID, 'pride.gay')
    prism.server.next.get = [{status: 200, body: {}}]
    prism.server.row = row('private', 'other-1', recordValue({font: 'system'}))
    await answerMembership(DID, 'member')
    await drain()
    await sync.flush(DID)
    await drain()
    expect(prism.server.row?.appearance).toMatchObject({
      backdrop: 'pride.gay',
      font: 'system',
    })
    expect(copy().pending).toBeNull()
  })

  it('`removalNoted` is cleared by the next member row, and a second removal notes again', async () => {
    const {prism} = await member({prismRow: row('private')})
    prism.server.member = false
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(mockNotices.showRemovalNote).toHaveBeenCalledTimes(1)
    prism.server.member = true
    await answerMembership(DID, 'member')
    await drain()
    expect(copy()).toMatchObject({
      removalNoted: false,
      removalLine: false,
      store: 'private',
      fallback: null,
    })
    prism.server.member = false
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(mockNotices.showRemovalNote).toHaveBeenCalledTimes(2)
  })
})

describe('the dev fault `not-enrolled` (11.1)', () => {
  it('the appearance methods answer 400 NotEnrolled', async () => {
    mockLocal.set(DEV_PRISM_FAULT_KEY, 'not-enrolled')
    for (const nsid of [
      'app.nearhorizon.private.getAppearance',
      'app.nearhorizon.private.putAppearance',
    ]) {
      const error = await withDevFault({nsid}, () =>
        Promise.resolve('sent'),
      ).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(XrpcResponseError)
      expect((error as XrpcResponseError).status).toBe(400)
      expect((error as XrpcResponseError).error).toBe('NotEnrolled')
    }
  })

  it('the probe answers `notEligible`, with the features as answered', async () => {
    mockLocal.set(DEV_PRISM_FAULT_KEY, 'not-enrolled')
    const probe = fakeClient(DID, () => ({
      status: 200,
      body: {status: 'member', features: ['private', 'private.appearance']},
    }))
    const cancel = startMembershipProbe(DID, probe.client, {
      setTimeout: () => undefined,
      clearTimeout: () => {},
      isHidden: () => false,
      onVisible: () => () => {},
    })
    await drain(5)
    cancel()
    expect(getMembership(DID)).toBe('not-member')
  })

  it('nothing faults in a production build', async () => {
    mockLocal.set(DEV_PRISM_FAULT_KEY, 'not-enrolled')
    let production: typeof withDevFault | undefined
    jest.isolateModules(() => {
      jest.doMock('#/env', () => ({IS_DEV: false}))
      production = jest.requireActual<{withDevFault: typeof withDevFault}>(
        '#/horizon/private/api/dev-fault',
      ).withDevFault
    })
    await expect(
      production!({nsid: 'app.nearhorizon.private.getAppearance'}, () =>
        Promise.resolve('sent'),
      ),
    ).resolves.toBe('sent')
  })

  it('signed in with `private` and a pending edit: the store becomes `device`, nothing reaches prism', async () => {
    const {prism} = await member({prismRow: row('private')})
    store.selectBackdrop(DID, 'pride.gay')
    mockLocal.set(DEV_PRISM_FAULT_KEY, 'not-enrolled')
    const sent = prism.server.calls.length
    await sync.flush(DID)
    await drain()
    expect(getMembership(DID)).toBe('not-member')
    expect(prismCallsOf({calls: prism.server.calls.slice(sent)}, 'putAppearance')).toHaveLength(0)
    expect(copy().store).toBe('device')
    expect(copy().record?.backdrop).toBe('pride.gay')
    expect(mockNotices.showRemovalNote).toHaveBeenCalledTimes(1)
  })
})
