/*
 * The appearance store (Phase 3 design, 6.2 and 6.3): the device value,
 * read synchronously so the first shell render already has the right look,
 * plus the editor's live preview (memory only, this tab). Every edit goes
 * through `editAppearance`. Writing to the repo is `sync.ts`'s job; it
 * registers its scheduler here, so this module never imports it.
 */

import {useSyncExternalStore} from 'react'

import {useSession} from '#/state/session'
import {
  readDeviceJson,
  subscribeDeviceJson,
  writeDeviceJson,
} from '#/horizon/appearance/device-store'
import {
  type AccountCopy,
  type DeviceAppearanceV1,
  parseDeviceValue,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {
  type Appearance,
  type AppearanceField,
  type CustomConfig,
  presetField,
} from '#/horizon/appearance/model'
import {type FrameStyle} from '#/horizon/backdrops/frame-style'
import {BACKDROP_CUSTOM} from '#/horizon/backdrops/registry'
import {type SoftTheme} from '#/horizon/backdrops/softness'
import {APPEARANCE_SYNC} from '#/horizon/switches'

export type AppearanceState = {
  device: DeviceAppearanceV1
  /** The Custom editor's unapplied colours, shown while `custom` is selected. */
  preview: CustomConfig | null
}

/** What `sync.ts` registers: its write scheduler and its cancel-all. */
export type AppearanceSyncHooks = {
  scheduleFlush: (did: string) => void
  cancelAll: () => void
}

let syncHooks: AppearanceSyncHooks | null = null

/** Called once by `sync.ts`. */
export function registerAppearanceSync(hooks: AppearanceSyncHooks | null) {
  syncHooks = hooks
}

let state: AppearanceState | null = null
let storedJson: string | undefined
const listeners = new Set<() => void>()
let unsubscribeDevice: (() => void) | null = null

function emit() {
  listeners.forEach(listener => listener())
}

function onDeviceChange() {
  const json = readDeviceJson()
  if (json === storedJson || !state) return
  storedJson = json
  state = {...state, device: parseDeviceValue(json)}
  emit()
}

function load(): AppearanceState {
  if (state) return state
  storedJson = readDeviceJson()
  let device = parseDeviceValue(storedJson)
  // A write refused for good is retried once per app start (6.5).
  if (Object.values(device.accounts).some(copy => copy.blocked)) {
    const accounts: Record<string, AccountCopy> = {}
    for (const [did, copy] of Object.entries(device.accounts)) {
      accounts[did] = {...copy, blocked: false}
    }
    device = {...device, accounts}
    storedJson = serializeDeviceValue(device)
    writeDeviceJson(storedJson)
  }
  state = {device, preview: null}
  unsubscribeDevice = subscribeDeviceJson(onDeviceChange)
  return state
}

/** The current state. */
export function getAppearanceState(): AppearanceState {
  return load()
}

/** Subscribe to every change. */
export function subscribeAppearance(listener: () => void): () => void {
  load()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Replace the device value and persist it. */
export function setDeviceValue(next: DeviceAppearanceV1) {
  const current = load()
  storedJson = serializeDeviceValue(next)
  state = {...current, device: next}
  writeDeviceJson(storedJson)
  emit()
}

/** Update one account's copy (creating it if missing) and persist. */
export function updateAccountCopy(
  did: string,
  change: (copy: AccountCopy) => AccountCopy,
) {
  const device = load().device
  const copy = device.accounts[did] ?? emptyCopy()
  setDeviceValue({
    ...device,
    accounts: {...device.accounts, [did]: change(copy)},
  })
}

/** Delete one account's copy, pending edit included. */
export function deleteAccountCopy(did: string) {
  const device = load().device
  if (!(did in device.accounts)) return
  const {[did]: _removed, ...accounts} = device.accounts
  setDeviceValue({...device, accounts})
}

/** An account copy for an account never read on this device. */
export function emptyCopy(): AccountCopy {
  return {
    record: null,
    raw: null,
    cid: null,
    syncedAt: 0,
    pending: null,
    blocked: false,
  }
}

/** Set or clear the editor's live preview. */
export function setAppearancePreview(preview: CustomConfig | null) {
  const current = load()
  if (current.preview === preview) return
  state = {...current, preview}
  emit()
}

/** The appearance shown for `did` (undefined when signed out), 6.2. */
export function effectiveAppearance(
  current: AppearanceState,
  did: string | undefined,
): Appearance {
  const {device} = current
  let result: Appearance
  if (!did || device.optOut || !APPEARANCE_SYNC) {
    result = device.device
  } else {
    const copy = device.accounts[did]
    result = copy?.pending?.appearance ?? copy?.record ?? device.device
  }
  if (current.preview && result.backdrop === BACKDROP_CUSTOM) {
    return {...result, custom: current.preview}
  }
  return result
}

/** The appearance state, for React. */
export function useAppearanceState(): AppearanceState {
  return useSyncExternalStore(
    subscribeAppearance,
    getAppearanceState,
    getAppearanceState,
  )
}

/** The appearance shown now, for the current account. */
export function useEffectiveAppearance(): Appearance {
  const {currentAccount} = useSession()
  return effectiveAppearance(useAppearanceState(), currentAccount?.did)
}

function union(a: AppearanceField[], b: AppearanceField[]): AppearanceField[] {
  return [...new Set([...a, ...b])]
}

/**
 * The one edit path (6.3): the change applies to the shown appearance
 * (without preview), `device` always takes the result, and a signed-in,
 * not opted-out device also records a pending edit and schedules a write.
 */
export function editAppearance(
  did: string | undefined,
  fields: AppearanceField[],
  change: (base: Appearance) => Appearance,
) {
  const current = load()
  const base = effectiveAppearance({...current, preview: null}, did)
  const next = change(base)
  const device = current.device
  if (did && !device.optOut && APPEARANCE_SYNC) {
    const copy = device.accounts[did] ?? emptyCopy()
    const old = copy.pending
    const pending = {
      fields: union(old?.fields ?? [], fields),
      appearance: next,
      seq: (old?.seq ?? 0) + 1,
    }
    setDeviceValue({
      ...device,
      device: next,
      accounts: {...device.accounts, [did]: {...copy, pending}},
    })
    syncHooks?.scheduleFlush(did)
  } else {
    setDeviceValue({...device, device: next})
  }
}

/** Select a registry backdrop, `none` or `custom`. */
export function selectBackdrop(did: string | undefined, id: string) {
  editAppearance(did, ['backdrop'], base => ({...base, backdrop: id}))
}

/** Apply a custom configuration and select Custom. */
export function applyCustom(did: string | undefined, config: CustomConfig) {
  editAppearance(did, ['backdrop', 'custom'], base => ({
    ...base,
    custom: config,
    backdrop: BACKDROP_CUSTOM,
  }))
}

/** Load preset `slot` (1-10); nothing for an empty slot. */
export function loadPreset(did: string | undefined, slot: number) {
  const base = effectiveAppearance({...load(), preview: null}, did)
  const preset = base.presets[slot - 1]
  if (!preset) return
  applyCustom(did, preset.custom)
}

/** Save `config` to preset `slot` (1-10), keeping the slot's name. */
export function savePreset(
  did: string | undefined,
  slot: number,
  config: CustomConfig,
  now: Date = new Date(),
) {
  editAppearance(did, [presetField(slot)], base => {
    const presets = [...base.presets]
    const name = presets[slot - 1]?.name
    presets[slot - 1] =
      name === undefined
        ? {custom: config, savedAt: now.toISOString()}
        : {name, custom: config, savedAt: now.toISOString()}
    return {...base, presets}
  })
}

/** Empty preset `slot` (1-10). */
export function clearPreset(did: string | undefined, slot: number) {
  editAppearance(did, [presetField(slot)], base => {
    const presets = [...base.presets]
    presets[slot - 1] = null
    return {...base, presets}
  })
}

/**
 * The per-device opt-out. Turning it on keeps the current look (`device`
 * already holds it) and drops every unsent edit on this device.
 */
export function setOptOut(on: boolean) {
  const device = load().device
  if (!on) {
    setDeviceValue({...device, optOut: false})
    return
  }
  const accounts: Record<string, AccountCopy> = {}
  for (const [did, copy] of Object.entries(device.accounts)) {
    accounts[did] = {...copy, pending: null}
  }
  syncHooks?.cancelAll()
  setDeviceValue({...device, optOut: true, accounts})
}

/** The phone frame (9.3, 9.6, 9.7). Device only. */
export function setFrameStyle(frameStyle: FrameStyle) {
  setDeviceValue({...load().device, frameStyle})
}

/** The backdrop softness of `theme`, 0 to 100. Device only. */
export function setBackdropSoftness(theme: SoftTheme, value: number) {
  const device = load().device
  const next = Math.max(0, Math.min(100, Math.round(value)))
  if (device.softness[theme] === next) return
  setDeviceValue({...device, softness: {...device.softness, [theme]: next}})
}

/** Tests only: forget the loaded state so the next read reloads it. */
export function resetAppearanceStoreForTests() {
  unsubscribeDevice?.()
  unsubscribeDevice = null
  state = null
  storedJson = undefined
  syncHooks = null
  listeners.clear()
}
