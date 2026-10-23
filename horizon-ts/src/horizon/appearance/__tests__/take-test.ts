/*
 * The 7-day retention (removed members design, sections 5, 6 and 10.1, as
 * built: see the implementation log): the take copies prism's retained
 * appearance to the device at the removal or the next sign-in, a later
 * launch releases prism's copy, and a rejoin replaces the retained row.
 */

import {XrpcResponseError} from '@atproto/lex'
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'

import {
  type AccountCopy,
  defaultDeviceValue,
  emptyAccountCopy,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {DEFAULT_APPEARANCE} from '#/horizon/appearance/model'
import {readPrismAnswer} from '#/horizon/appearance/prism'
import * as store from '#/horizon/appearance/store'
import * as sync from '#/horizon/appearance/sync'
import {
  RELEASE_WAIT_NATIVE_MS,
  setTakeWebForTests,
  TAKE_RETRY_MIN_MS,
} from '#/horizon/appearance/take'
import {fakeClient} from '#/horizon/private/__tests__/fixtures'
import {
  DEV_PRISM_FAULT_KEY,
  withDevFault,
} from '#/horizon/private/api/dev-fault'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {
  getMembership,
  resetMembership,
  startMembershipProbe,
} from '#/horizon/routing/membership'
import {
  answerMembership,
  CIDS,
  drain,
  fakePds,
  fakePrism,
  prismCallsOf,
  type PrismRow,
  recordValue,
  rejoinPrism,
  removeFromPrism,
  RETENTION_MS,
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
  showTakenNote: jest.fn(),
  showChoiceRefused: jest.fn(),
  showRecordBlocked: jest.fn(),
  showDeleteWarning: jest.fn(),
  showTooLarge: jest.fn(),
}
jest.mock('#/horizon/appearance/notices', () => ({
  showMigrationNote: () => mockNotices.showMigrationNote(),
  showRemovalNote: () => mockNotices.showRemovalNote(),
  showTakenNote: () => mockNotices.showTakenNote(),
  showChoiceRefused: () => mockNotices.showChoiceRefused(),
  showRecordBlocked: () => mockNotices.showRecordBlocked(),
  showDeleteWarning: () => mockNotices.showDeleteWarning(),
  showTooLarge: () => mockNotices.showTooLarge(),
}))
const mockLogger = {warn: jest.fn(), error: jest.fn(), info: jest.fn()}
jest.mock('#/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLogger.warn(...args),
    error: (...args: unknown[]) => mockLogger.error(...args),
    info: () => {},
    debug: () => {},
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
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 24, 12)

let clock = T0
function at(ms: number) {
  clock = ms
}

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

/** A new launch of the device: memory forgotten, storage kept. */
function relaunch() {
  resetMembership()
  resetPrismFeatures()
  store.resetAppearanceStoreForTests()
  sync.resetAppearanceSyncForTests()
}

function seedCopy(partial: Partial<AccountCopy>) {
  mockJson = serializeDeviceValue({
    ...defaultDeviceValue(),
    accounts: {[DID]: {...emptyAccountCopy(), ...partial}},
  })
  relaunch()
}

type Pds = ReturnType<typeof fakePds>
type Prism = ReturnType<typeof fakePrism>

/** Sign in (or open the app) as `DID` with this membership answer. */
async function signIn(
  pds: Pds,
  prism: Prism,
  status: 'member' | 'notEligible',
  options?: {retention?: boolean},
) {
  sync.registerAppearanceClient(DID, pds.client, prism.client)
  await answerMembership(DID, status, options)
  await sync.refresh(DID)
  await drain()
}

/** A member on "Private, synced" with prism's row, signed in. */
async function privateMember(value = recordValue({backdrop: 'pride.ace'})) {
  const pds = fakePds(DID)
  const prism = fakePrism(DID, row('private', 'rev-0', value))
  prism.server.now = () => clock
  await signIn(pds, prism, 'member')
  return {pds, prism}
}

async function removedWhileSignedIn(prism: Prism) {
  removeFromPrism(prism.server)
  await answerMembership(DID, 'notEligible')
  await drain()
}

function gets(prism: Prism, from = 0) {
  return prismCallsOf({calls: prism.server.calls.slice(from)}, 'getAppearance')
}

function releases(prism: Prism, from = 0) {
  return prismCallsOf(
    {calls: prism.server.calls.slice(from)},
    'releaseAppearance',
  )
}

beforeEach(() => {
  clock = T0
  jest.spyOn(Date, 'now').mockImplementation(() => clock)
  mockJson = undefined
  mockLocal.clear()
  Object.values(mockNotices).forEach(fn => fn.mockClear())
  mockLogger.warn.mockClear()
  setTakeWebForTests(false)
  relaunch()
  resetPrismHealth()
})

afterEach(() => {
  jest.restoreAllMocks()
  setTakeWebForTests(undefined)
})

describe('reading a retained row (RM-B2)', () => {
  it('a retained answer is its own kind; an unknown store is unanswered', () => {
    expect(
      readPrismAnswer({
        store: 'private',
        rev: 'r1',
        appearance: recordValue(),
        retainedUntil: '2026-10-31T12:00:00.000Z',
      }),
    ).toMatchObject({
      row: false,
      retained: {store: 'private', rev: 'r1', value: {appearance: {}}},
    })
    expect(
      readPrismAnswer({store: 'device', rev: 'r2', retainedUntil: 'x'}),
    ).toEqual({row: false, retained: {store: 'device', rev: 'r2', value: null}})
    expect(
      readPrismAnswer({store: 'cloud', rev: 'r3', retainedUntil: 'x'}),
    ).toBeUndefined()
  })

  it('every read sends `includeRetained`', async () => {
    const {prism} = await privateMember()
    expect(gets(prism).length).toBeGreaterThan(0)
    for (const call of gets(prism)) {
      expect(call.params.get('includeRetained')).toBe('true')
    }
  })
})

describe('the take: signed in when removed', () => {
  it('copies prism’s value at once, keeps the edit made since, and releases nothing that run', async () => {
    const {pds, prism} = await privateMember(
      recordValue({backdrop: 'pride.ace', font: 'system'}),
    )
    removeFromPrism(prism.server)
    const sent = prism.server.calls.length
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    expect(copy()).toMatchObject({
      store: 'device',
      rev: null,
      take: {step: 'release', rev: 'rev-0', copiedAt: T0},
      fallback: {fields: ['backdrop'], rev: 'rev-0'},
      removalNoted: true,
      removalLine: true,
      removalTaken: true,
      pending: null,
    })
    // The edit since the removal is kept; every other field is prism's.
    expect(copy().record).toMatchObject({backdrop: 'pride.gay', font: 'system'})
    expect(mockNotices.showTakenNote).toHaveBeenCalledTimes(1)
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
    expect(releases(prism, sent)).toHaveLength(0)
    expect(prism.server.row?.rev).toBe('rev-0')
    expect(pds.server.calls.filter(c => c.nsid.endsWith('putRecord'))).toHaveLength(0)
  })

  it('an edit after the copy is named for the rejoin, and saves on the device at once', async () => {
    const {prism} = await privateMember()
    await removedWhileSignedIn(prism)
    const sent = prism.server.calls.length
    store.saveThemePref(DID, 'font', 'system')
    await sync.flush(DID)
    await drain()
    expect(copy().record?.font).toBe('system')
    expect(copy().pending).toBeNull()
    expect(copy().fallback?.fields).toEqual(['font'])
    expect(prism.server.calls.length).toBe(sent)
  })

  it('an unanswered read is asked again on a later pass after a minute, not before', async () => {
    const {prism} = await privateMember()
    prism.server.next.get = [{status: 503, body: {error: 'Busy'}}]
    await removedWhileSignedIn(prism)
    expect(copy().take?.step).toBe('fetch')
    const sent = prism.server.calls.length
    await sync.flush(DID)
    await drain()
    expect(gets(prism, sent)).toHaveLength(0)
    at(T0 + TAKE_RETRY_MIN_MS)
    await sync.flush(DID)
    await drain()
    expect(gets(prism, sent)).toHaveLength(1)
    expect(copy().take?.step).toBe('release')
  })

  it('an answered read is sent once per run', async () => {
    const {prism} = await privateMember()
    prism.server.next.get = [
      {status: 400, body: {error: 'Forbidden', message: 'no'}},
    ]
    await removedWhileSignedIn(prism)
    const sent = prism.server.calls.length
    at(T0 + 5 * TAKE_RETRY_MIN_MS)
    await sync.flush(DID)
    await drain()
    expect(gets(prism, sent)).toHaveLength(0)
    expect(copy().take?.step).toBe('fetch')
    // The next launch asks again.
    relaunch()
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(copy().take?.step).toBe('release')
  })

  it('a retained `device` row: nothing copied or released, the row kept, no note', async () => {
    const pds = fakePds(DID)
    const prism = fakePrism(DID, row('device', 'rev-d'))
    prism.server.now = () => clock
    await signIn(pds, prism, 'member')
    await removedWhileSignedIn(prism)
    expect(copy()).toMatchObject({
      take: null,
      fallback: {fields: [], rev: 'rev-d'},
      removalTaken: false,
    })
    expect(prism.server.row?.rev).toBe('rev-d')
    expect(mockNotices.showTakenNote).not.toHaveBeenCalled()
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
  })

  it('a value this build can’t read is never copied, and asked for once per launch', async () => {
    const {prism} = await privateMember()
    removeFromPrism(prism.server)
    prism.server.next.get = [
      {
        status: 200,
        body: {store: 'cloud', rev: 'rev-0', retainedUntil: 'x'},
      },
    ]
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy().take?.step).toBe('fetch')
    expect(mockLogger.warn).toHaveBeenCalled()
    const sent = prism.server.calls.length
    at(T0 + 5 * TAKE_RETRY_MIN_MS)
    await sync.flush(DID)
    await drain()
    expect(gets(prism, sent)).toHaveLength(0)
  })

  it('Public ends the take: a record present means no read and no release', async () => {
    const {pds, prism} = await privateMember()
    pds.server.stored = {value: recordValue({backdrop: 'pride.pan'}), cid: CIDS[4]}
    const sent = prism.server.calls.length
    await removedWhileSignedIn(prism)
    expect(copy().store).toBe('public')
    expect(copy().take).toBeNull()
    // The record's values are held now: never imported over at a rejoin.
    expect(copy().fallback).toEqual({fields: []})
    expect(gets(prism, sent)).toHaveLength(0)
    expect(prism.server.row?.rev).toBe('rev-0')
    expect(mockNotices.showTakenNote).not.toHaveBeenCalled()
  })

  it('a prism without the retention: nothing is asked, the core’s note shows', async () => {
    const pds = fakePds(DID)
    const prism = fakePrism(DID, row('private'))
    sync.registerAppearanceClient(DID, pds.client, prism.client)
    await answerMembership(DID, 'member', {retention: false})
    await sync.refresh(DID)
    await drain()
    const sent = prism.server.calls.length
    prism.server.member = false
    await answerMembership(DID, 'notEligible', {retention: false})
    await drain()
    expect(gets(prism, sent)).toHaveLength(0)
    expect(copy()).toMatchObject({take: null, removalLine: true})
    expect(mockNotices.showRemovalNote).toHaveBeenCalledTimes(1)
  })
})

describe('the take: the next sign-in on a device', () => {
  it('a fresh device takes prism’s value over its own look, with the note', async () => {
    const pds = fakePds(DID)
    const prism = fakePrism(DID, row('private', 'rev-7'))
    prism.server.now = () => clock
    removeFromPrism(prism.server)
    await signIn(pds, prism, 'notEligible')
    expect(copy()).toMatchObject({
      store: 'device',
      take: {step: 'release', rev: 'rev-7'},
      removalTaken: true,
    })
    expect(copy().record?.backdrop).toBe('pride.ace')
    expect(mockNotices.showTakenNote).toHaveBeenCalledTimes(1)
  })

  it('a never-member’s first sign-in: one read, nothing kept, no note', async () => {
    const pds = fakePds(DID)
    const prism = fakePrism(DID)
    prism.server.member = false
    await signIn(pds, prism, 'notEligible')
    expect(copy()).toMatchObject({store: 'device', take: null, fallback: null})
    expect(gets(prism)).toHaveLength(1)
    expect(mockNotices.showTakenNote).not.toHaveBeenCalled()
    expect(mockNotices.showRemovalNote).not.toHaveBeenCalled()
    // A second launch asks nothing.
    relaunch()
    await signIn(pds, prism, 'notEligible')
    expect(gets(prism)).toHaveLength(1)
  })

  it('a device that slept through the removal takes it at its next launch', async () => {
    const {prism} = await privateMember()
    removeFromPrism(prism.server)
    at(T0 + 3 * DAY)
    relaunch()
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(copy().take).toMatchObject({step: 'release', copiedAt: T0 + 3 * DAY})
    expect(copy().record?.backdrop).toBe('pride.ace')
    expect(mockNotices.showTakenNote).toHaveBeenCalledTimes(1)
  })

  it('after the 7 days nothing is kept: the device keeps its own copy, with the core’s note', async () => {
    const {prism} = await privateMember()
    removeFromPrism(prism.server)
    at(T0 + RETENTION_MS + HOUR)
    relaunch()
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(copy()).toMatchObject({take: null, removalLine: true})
    expect(mockNotices.showRemovalNote).toHaveBeenCalledTimes(1)
  })
})

describe('the release (a later launch)', () => {
  async function copiedAtT0() {
    const ctx = await privateMember()
    await removedWhileSignedIn(ctx.prism)
    expect(copy().take?.step).toBe('release')
    return ctx
  }

  it('native: a day later the launch releases prism’s copy, and the device keeps it', async () => {
    const {prism} = await copiedAtT0()
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    at(T0 + RELEASE_WAIT_NATIVE_MS + HOUR)
    relaunch()
    const sent = prism.server.calls.length
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(releases(prism, sent)).toHaveLength(1)
    expect(releases(prism, sent)[0].body).toEqual({rev: 'rev-0'})
    expect(prism.server.row).toBeNull()
    expect(copy().take).toBeNull()
    expect(copy().record?.backdrop).toBe('pride.gay')
    expect(copy().fallback?.fields).toEqual(['backdrop'])
    // Nothing is shown again.
    expect(mockNotices.showTakenNote).toHaveBeenCalledTimes(1)
  })

  it('native: no release before the day, and no read either', async () => {
    const {prism} = await copiedAtT0()
    at(T0 + RELEASE_WAIT_NATIVE_MS - HOUR)
    relaunch()
    const sent = prism.server.calls.length
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(gets(prism, sent)).toHaveLength(0)
    expect(releases(prism, sent)).toHaveLength(0)
    expect(copy().take?.step).toBe('release')
  })

  it('native: a copy in the expiry’s last day finds the row gone, and sends no release', async () => {
    const pds = fakePds(DID)
    const prism = fakePrism(DID, row('private'))
    prism.server.now = () => clock
    removeFromPrism(prism.server)
    at(T0 + 6.5 * DAY)
    await signIn(pds, prism, 'notEligible')
    expect(copy().take?.step).toBe('release')
    at(T0 + 7.5 * DAY)
    relaunch()
    const sent = prism.server.calls.length
    await signIn(pds, prism, 'notEligible')
    expect(gets(prism, sent)).toHaveLength(1)
    expect(releases(prism, sent)).toHaveLength(0)
    expect(copy().take).toBeNull()
    expect(copy().fallback).not.toBeNull()
  })

  it('web: no read for 8 days; then the row has expired, and nothing is released', async () => {
    setTakeWebForTests(true)
    const {prism} = await copiedAtT0()
    at(T0 + 2 * DAY)
    relaunch()
    let sent = prism.server.calls.length
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(gets(prism, sent)).toHaveLength(0)
    at(T0 + 8 * DAY + HOUR)
    relaunch()
    sent = prism.server.calls.length
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(gets(prism, sent)).toHaveLength(1)
    expect(releases(prism, sent)).toHaveLength(0)
    expect(copy().take).toBeNull()
    expect(copy().record?.backdrop).toBe('pride.ace')
  })

  it('a release that finds nothing (`{}`) is done, with no error and no retry', async () => {
    const {prism} = await copiedAtT0()
    at(T0 + 2 * DAY)
    relaunch()
    prism.server.next.release = [{status: 200, body: {}}]
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(copy().take).toBeNull()
    expect(mockLogger.warn).not.toHaveBeenCalled()
  })

  it('a release that fails in transit is tried at the next launch', async () => {
    const {prism} = await copiedAtT0()
    at(T0 + 2 * DAY)
    relaunch()
    prism.server.next.release = [{status: 503, body: {error: 'Busy'}}]
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(copy().take?.step).toBe('release')
    expect(prism.server.row).not.toBeNull()
    at(T0 + 2 * DAY + HOUR)
    relaunch()
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(copy().take).toBeNull()
    expect(prism.server.row).toBeNull()
  })

  it('a copy lost before the release: nothing is released, and the next sign-in takes it again', async () => {
    const {prism} = await copiedAtT0()
    store.deleteAccountCopy(DID)
    at(T0 + 2 * DAY)
    relaunch()
    const sent = prism.server.calls.length
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(releases(prism, sent)).toHaveLength(0)
    expect(copy().take).toMatchObject({step: 'release', copiedAt: T0 + 2 * DAY})
  })
})

describe('rejoining onto a retained row (RM-B3)', () => {
  it('a device holding the copy puts it back, swapped on the retained rev, with its edits', async () => {
    const {pds, prism} = await privateMember(
      recordValue({backdrop: 'pride.ace', font: 'system'}),
    )
    await removedWhileSignedIn(prism)
    store.selectBackdrop(DID, 'pride.gay')
    await sync.flush(DID)
    await drain()
    rejoinPrism(prism.server)
    relaunch()
    await signIn(pds, prism, 'member')
    const put = prismCallsOf(prism.server, 'putAppearance').at(-1)!
    expect(put.body).toMatchObject({store: 'private', swapRev: 'rev-0'})
    expect(prism.server.row?.appearance).toMatchObject({
      backdrop: 'pride.gay',
      font: 'system',
    })
    expect(prism.server.retainedUntil).toBeNull()
    expect(copy()).toMatchObject({
      store: 'private',
      take: null,
      fallback: null,
      removalLine: false,
      removalTaken: false,
    })
  })

  it('a device that never learned of the removal imports the retained value', async () => {
    seedCopy({
      store: 'private',
      rev: 'rev-old',
      record: {...DEFAULT_APPEARANCE, backdrop: 'pride.bi'},
      raw: {},
    })
    const prism = fakePrism(DID, row('private', 'rev-5'))
    removeFromPrism(prism.server)
    rejoinPrism(prism.server)
    await signIn(fakePds(DID), prism, 'member')
    expect(copy().record?.backdrop).toBe('pride.ace')
    expect(prismCallsOf(prism.server, 'putAppearance').at(-1)?.body).toMatchObject(
      {store: 'private', swapRev: 'rev-5'},
    )
  })

  it('a take still at `fetch` imports, keeping its edits since the removal', async () => {
    seedCopy({
      store: 'device',
      rev: null,
      record: {...DEFAULT_APPEARANCE, backdrop: 'pride.bi', font: 'system'},
      take: {step: 'fetch', keptNote: true},
      fallback: {fields: ['font'], rev: 'rev-5'},
    })
    const prism = fakePrism(DID, row('private', 'rev-5'))
    removeFromPrism(prism.server)
    rejoinPrism(prism.server)
    await signIn(fakePds(DID), prism, 'member')
    expect(prism.server.row?.appearance).toMatchObject({
      backdrop: 'pride.ace',
      font: 'system',
    })
  })

  it('a retained `device` row: the put `{store: device}` reaches prism', async () => {
    seedCopy({
      store: 'device',
      rev: null,
      record: DEFAULT_APPEARANCE,
      fallback: {fields: [], rev: 'rev-d'},
    })
    const prism = fakePrism(DID, row('device', 'rev-d'))
    removeFromPrism(prism.server)
    rejoinPrism(prism.server)
    await signIn(fakePds(DID), prism, 'member')
    expect(prismCallsOf(prism.server, 'putAppearance').at(-1)?.body).toEqual({
      store: 'device',
      swapRev: 'rev-d',
    })
    expect(prism.server.retainedUntil).toBeNull()
  })

  it('a live row after another device rejoined: this device’s edits since the removal are merged', async () => {
    seedCopy({
      store: 'device',
      rev: null,
      record: {...DEFAULT_APPEARANCE, backdrop: 'pride.bi', font: 'system'},
      fallback: {fields: ['font'], rev: 'rev-0'},
    })
    const prism = fakePrism(
      DID,
      row('private', 'rev-9', recordValue({backdrop: 'pride.pan'})),
    )
    await signIn(fakePds(DID), prism, 'member')
    expect(prism.server.row?.appearance).toMatchObject({
      backdrop: 'pride.pan',
      font: 'system',
    })
    expect(copy().fallback).toBeNull()
  })

  it('a live `public` row drops the edits: nothing made under “This device only” is published', async () => {
    seedCopy({
      store: 'device',
      rev: null,
      record: {...DEFAULT_APPEARANCE, font: 'system'},
      fallback: {fields: ['font'], rev: 'rev-0'},
    })
    const pds = fakePds(DID)
    const prism = fakePrism(DID, row('public', 'rev-9'))
    await signIn(pds, prism, 'member')
    expect(prismCallsOf(prism.server, 'putAppearance')).toHaveLength(0)
    expect(copy().fallback).toBeNull()
  })
})

describe('the dev fault `not-enrolled-retained` (RM-B6)', () => {
  it('marks a row retained, answers no row with NotEnrolled, and never sends a release', async () => {
    mockLocal.set(DEV_PRISM_FAULT_KEY, 'not-enrolled-retained')
    const get = {nsid: 'app.nearhorizon.private.getAppearance'}
    const body = (await withDevFault(get, () =>
      Promise.resolve({store: 'private', rev: 'r1'}),
    )) as {retainedUntil?: string}
    expect(Date.parse(body.retainedUntil!)).toBe(T0 + RETENTION_MS)
    const none = await withDevFault(get, () => Promise.resolve({})).catch(
      (e: unknown) => e,
    )
    expect((none as XrpcResponseError).error).toBe('NotEnrolled')
    const send = jest.fn(() => Promise.resolve('sent'))
    await expect(
      withDevFault({nsid: 'app.nearhorizon.private.releaseAppearance'}, send),
    ).resolves.toEqual({})
    expect(send).not.toHaveBeenCalled()
    const put = await withDevFault(
      {nsid: 'app.nearhorizon.private.putAppearance'},
      send,
    ).catch((e: unknown) => e)
    expect((put as XrpcResponseError).error).toBe('NotEnrolled')
  })

  it('the probe answers `notEligible`', async () => {
    mockLocal.set(DEV_PRISM_FAULT_KEY, 'not-enrolled-retained')
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

  it('a member under the fault takes its own live row as retained, and prism keeps it', async () => {
    const {prism} = await privateMember()
    mockLocal.set(DEV_PRISM_FAULT_KEY, 'not-enrolled-retained')
    await answerMembership(DID, 'notEligible')
    await drain()
    expect(copy().take).toMatchObject({step: 'release', rev: 'rev-0'})
    at(T0 + 2 * DAY)
    relaunch()
    await signIn(fakePds(DID), prism, 'notEligible')
    expect(copy().take).toBeNull()
    expect(releases(prism)).toHaveLength(0)
    expect(prism.server.row?.rev).toBe('rev-0')
  })
})
