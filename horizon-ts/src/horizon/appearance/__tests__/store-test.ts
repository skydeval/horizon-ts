import {beforeEach, describe, expect, it, jest} from '@jest/globals'

import {
  defaultDeviceValue,
  type DeviceAppearanceV1,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {DEFAULT_APPEARANCE, DEFAULT_CUSTOM} from '#/horizon/appearance/model'
import * as store from '#/horizon/appearance/store'

let mockSync = true
jest.mock('#/horizon/switches', () => ({
  get APPEARANCE_SYNC() {
    return mockSync
  },
  BACKDROPS: true,
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
}))

let mockJson: string | undefined
const mockListeners = new Set<() => void>()
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => mockJson,
  writeDeviceJson: (json: string) => {
    mockJson = json
    mockListeners.forEach(listener => listener())
  },
  subscribeDeviceJson: (listener: () => void) => {
    mockListeners.add(listener)
    return () => mockListeners.delete(listener)
  },
}))

const DID = 'did:plc:alice'
const scheduled: string[] = []
let cancelled = 0

function seed(value: Partial<DeviceAppearanceV1>) {
  mockJson = serializeDeviceValue({...defaultDeviceValue(), ...value})
}

beforeEach(() => {
  mockSync = true
  mockJson = undefined
  mockListeners.clear()
  scheduled.length = 0
  cancelled = 0
  store.resetAppearanceStoreForTests()
  store.registerAppearanceSync({
    scheduleFlush: did => scheduled.push(did),
    cancelAll: () => {
      cancelled++
    },
  })
})

function device() {
  return store.getAppearanceState().device
}

describe('effectiveAppearance (T11)', () => {
  it('signed out, opted out and with sync off: the device appearance', () => {
    const record = {...DEFAULT_APPEARANCE, backdrop: 'pride.bi'}
    seed({
      device: {...DEFAULT_APPEARANCE, backdrop: 'materials.paper'},
      accounts: {
        [DID]: {...store.emptyCopy(), record, raw: {}, cid: 'c', syncedAt: 1},
      },
    })
    const state = store.getAppearanceState()
    expect(store.effectiveAppearance(state, undefined).backdrop).toBe(
      'materials.paper',
    )
    expect(store.effectiveAppearance(state, DID).backdrop).toBe('pride.bi')
    expect(
      store.effectiveAppearance(
        {...state, device: {...state.device, optOut: true}},
        DID,
      ).backdrop,
    ).toBe('materials.paper')
    mockSync = false
    expect(store.effectiveAppearance(state, DID).backdrop).toBe(
      'materials.paper',
    )
    // With sync off an edit still shows.
    store.selectBackdrop(DID, 'pride.gay')
    expect(
      store.effectiveAppearance(store.getAppearanceState(), DID).backdrop,
    ).toBe('pride.gay')
    expect(device().accounts[DID].pending).toBeNull()
    expect(scheduled).toEqual([])
  })

  it('an account: pending, then record, then device', () => {
    const state = store.getAppearanceState()
    expect(store.effectiveAppearance(state, DID)).toBe(state.device.device)
    store.selectBackdrop(DID, 'pride.ace')
    expect(
      store.effectiveAppearance(store.getAppearanceState(), DID).backdrop,
    ).toBe('pride.ace')
  })

  it('the preview applies only to custom', () => {
    store.setAppearancePreview({mode: 'solid', a: '#010101', b: '#010101'})
    expect(
      store.effectiveAppearance(store.getAppearanceState(), undefined).custom,
    ).toEqual(DEFAULT_CUSTOM)
    store.selectBackdrop(undefined, 'custom')
    expect(
      store.effectiveAppearance(store.getAppearanceState(), undefined).custom.a,
    ).toBe('#010101')
    // The preview is never written.
    expect(device().device.custom).toEqual(DEFAULT_CUSTOM)
  })
})

describe('edits (T11)', () => {
  it('select records pending fields, increments seq and schedules', () => {
    store.selectBackdrop(DID, 'pride.trans')
    store.selectBackdrop(DID, 'pride.bi')
    const copy = device().accounts[DID]
    expect(copy.record).toBeNull()
    expect(copy.syncedAt).toBe(0)
    expect(copy.pending?.fields).toEqual(['backdrop'])
    expect(copy.pending?.seq).toBe(2)
    expect(copy.pending?.appearance.backdrop).toBe('pride.bi')
    expect(device().device.backdrop).toBe('pride.bi')
    expect(scheduled).toEqual([DID, DID])
    // Persisted.
    const stored = JSON.parse(mockJson!) as {device: {backdrop: string}}
    expect(stored.device.backdrop).toBe('pride.bi')
  })

  it('applyCustom, savePreset, loadPreset, clearPreset', () => {
    const config = {mode: 'solid' as const, a: '#123456', b: '#123456'}
    store.applyCustom(DID, config)
    let copy = device().accounts[DID]
    expect(copy.pending?.fields).toEqual(['backdrop', 'custom'])
    expect(copy.pending?.appearance.backdrop).toBe('custom')
    expect(copy.pending?.appearance.custom).toEqual(config)

    const saved = {mode: 'twoTone' as const, a: '#000000', b: '#FFFFFF'}
    store.savePreset(DID, 4, saved, new Date('2026-10-19T00:00:00.000Z'))
    copy = device().accounts[DID]
    expect(copy.pending?.fields).toEqual(['backdrop', 'custom', 'preset:4'])
    expect(copy.pending?.appearance.presets[3]).toEqual({
      custom: saved,
      savedAt: '2026-10-19T00:00:00.000Z',
    })

    store.selectBackdrop(DID, 'none')
    store.loadPreset(DID, 4)
    copy = device().accounts[DID]
    expect(copy.pending?.appearance.backdrop).toBe('custom')
    expect(copy.pending?.appearance.custom).toEqual(saved)

    const seq = copy.pending!.seq
    store.loadPreset(DID, 5)
    expect(device().accounts[DID].pending?.seq).toBe(seq)

    store.clearPreset(DID, 4)
    expect(device().accounts[DID].pending?.appearance.presets[3]).toBeNull()
    expect(device().device.presets[3]).toBeNull()
  })

  it('savePreset keeps a slot name', () => {
    const presets = [...DEFAULT_APPEARANCE.presets]
    presets[0] = {name: 'Mine', custom: DEFAULT_CUSTOM, savedAt: 'x'}
    seed({device: {...DEFAULT_APPEARANCE, presets}})
    store.savePreset(undefined, 1, {mode: 'solid', a: '#111111', b: '#111111'})
    expect(device().device.presets[0]?.name).toBe('Mine')
  })

  it('no pending signed out or opted out; opting out drops pending', () => {
    store.selectBackdrop(undefined, 'pride.pan')
    expect(device().accounts).toEqual({})
    expect(device().device.backdrop).toBe('pride.pan')

    store.selectBackdrop(DID, 'pride.gay')
    expect(device().accounts[DID].pending).not.toBeNull()
    store.setOptOut(true)
    expect(device().optOut).toBe(true)
    expect(device().accounts[DID].pending).toBeNull()
    expect(cancelled).toBe(1)
    // The look is kept.
    expect(
      store.effectiveAppearance(store.getAppearanceState(), DID).backdrop,
    ).toBe('pride.gay')

    scheduled.length = 0
    store.selectBackdrop(DID, 'materials.paper')
    expect(device().accounts[DID].pending).toBeNull()
    expect(scheduled).toEqual([])

    store.setOptOut(false)
    expect(device().optOut).toBe(false)
    expect(scheduled).toEqual([])
  })

  it('clears blocked at load', () => {
    seed({accounts: {[DID]: {...store.emptyCopy(), blocked: true}}})
    expect(device().accounts[DID].blocked).toBe(false)
  })

  it('follows another tab', () => {
    store.getAppearanceState()
    const listener = jest.fn()
    store.subscribeAppearance(listener)
    mockJson = serializeDeviceValue({
      ...defaultDeviceValue(),
      device: {...DEFAULT_APPEARANCE, backdrop: 'materials.fog'},
    })
    mockListeners.forEach(l => l())
    expect(listener).toHaveBeenCalled()
    expect(device().device.backdrop).toBe('materials.fog')
  })

  it('device-only settings', () => {
    store.setFrameStyle('headerBand')
    expect(device().frameStyle).toBe('headerBand')
    store.setFrameStyle('gutter')
    expect(device().frameStyle).toBe('gutter')
    expect(device().softness).toEqual({dim: 40, dark: 50})
    store.setBackdropSoftness('dark', 72.6)
    store.setBackdropSoftness('dim', -5)
    expect(device().softness).toEqual({dim: 0, dark: 73})
    // Device only: no pending edit for the record.
    expect(device().accounts).toEqual({})
  })
})
