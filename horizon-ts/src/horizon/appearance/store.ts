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
  type AppearanceStore,
  type DeviceAppearanceV1,
  emptyAccountCopy,
  parseDeviceValue,
  type PendingAppearance,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {
  type Appearance,
  type AppearanceField,
  type CustomConfig,
  presetField,
  THEME_PREF_FIELDS,
  type ThemePrefField,
  type ThemePrefs,
  withoutThemePrefs,
} from '#/horizon/appearance/model'
import {type FrameStyle} from '#/horizon/backdrops/frame-style'
import {BACKDROP_CUSTOM} from '#/horizon/backdrops/registry'
import {type SoftTheme} from '#/horizon/backdrops/softness'
import {APPEARANCE_SYNC, BACKDROPS} from '#/horizon/switches'

export type AppearanceState = {
  device: DeviceAppearanceV1
  /** The Custom editor's unapplied colours, shown while `custom` is selected. */
  preview: CustomConfig | null
}

/** What `sync.ts` registers: its write scheduler and its cancel-all. */
export type AppearanceSyncHooks = {
  scheduleFlush: (did: string) => void
  cancelAll: () => void
  /** Run `did`'s queue now (a choice change flushes at once, 5). */
  flushNow?: (did: string) => void
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
  /*
   * A write refused for good is retried once per app start (6.5), and a
   * store answered in an earlier run is only remembered in this one
   * (storage choice design, section 4).
   */
  if (
    Object.values(device.accounts).some(
      copy => copy.blocked || copy.storeKnown,
    )
  ) {
    const accounts: Record<string, AccountCopy> = {}
    for (const [did, copy] of Object.entries(device.accounts)) {
      accounts[did] = {...copy, blocked: false, storeKnown: false}
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
  return emptyAccountCopy()
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
    // A choice change not yet landed rides along with the edit (5).
    const pending: PendingAppearance = {
      ...old,
      fields: union(old?.fields ?? [], fields),
      appearance: next,
      seq: (old?.seq ?? 0) + 1,
    }
    setDeviceValue({
      ...device,
      device: withoutThemePrefs(next),
      accounts: {...device.accounts, [did]: {...copy, pending}},
    })
    syncHooks?.scheduleFlush(did)
  } else {
    setDeviceValue({...device, device: withoutThemePrefs(next)})
  }
}

/*
 * The theme settings per account (change list 2, item 11). The stock
 * settings stay where they always were (colour mode and dark theme in the
 * persisted store, font and size in device storage): they are the
 * device's values, used signed out and with the opt-out on. An account's
 * saved values are applied over them on account switch (`AppearanceSync`)
 * and are never copied into this device's own appearance, so an account
 * with none saved leaves the device's settings as they are.
 */

/** The theme settings `did` has saved, as this device last read or edited them. */
export function accountThemePrefs(
  current: AppearanceState,
  did: string | undefined,
): ThemePrefs {
  const {device} = current
  if (!did || device.optOut || !APPEARANCE_SYNC || !BACKDROPS) return {}
  const copy = device.accounts[did]
  const source = copy?.pending?.appearance ?? copy?.record
  if (!source) return {}
  const out: ThemePrefs = {}
  for (const field of THEME_PREF_FIELDS) {
    if (source[field] !== undefined)
      Object.assign(out, {[field]: source[field]})
  }
  return out
}

/**
 * Save one theme setting to `did`'s record, when signed in and not opted
 * out; nothing otherwise (the stock setter has already set the device).
 */
export function saveThemePref<K extends ThemePrefField>(
  did: string | undefined,
  field: K,
  value: ThemePrefs[K],
) {
  const device = load().device
  if (!did || device.optOut || !APPEARANCE_SYNC || !BACKDROPS) return
  editAppearance(did, [field], base => ({...base, [field]: value}))
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
 * already holds it) and drops every unsent edit on this device. A choice
 * change not yet landed is the account's, not the device's, so it stays
 * (storage choice design 5.1, AS8-N5).
 */
export function setOptOut(on: boolean) {
  const device = load().device
  if (!on) {
    setDeviceValue({...device, optOut: false})
    return
  }
  const accounts: Record<string, AccountCopy> = {}
  for (const [did, copy] of Object.entries(device.accounts)) {
    const pending = copy.pending
    accounts[did] = {
      ...copy,
      pending: pending?.store
        ? {
            ...pending,
            fields: [],
            appearance: copy.record ?? pending.appearance,
          }
        : null,
    }
  }
  syncHooks?.cancelAll()
  setDeviceValue({...device, optOut: true, accounts})
}

/**
 * "Save my appearance" (storage choice design 2, 7): the choice changes at
 * once (`pending.store`, replacing any earlier one not yet landed) and the
 * account's queue runs at once. The user's choice, never an `auto` one.
 */
export function chooseAppearanceStore(did: string, store: AppearanceStore) {
  const device = load().device
  const copy = device.accounts[did] ?? emptyCopy()
  const old = copy.pending
  // The account's value, also when this device is opted out.
  const pending: PendingAppearance = {
    fields: old?.fields ?? [],
    appearance: old?.appearance ?? copy.record ?? device.device,
    seq: (old?.seq ?? 0) + 1,
    store,
  }
  setDeviceValue({
    ...device,
    accounts: {...device.accounts, [did]: {...copy, pending}},
  })
  if (syncHooks?.flushNow) syncHooks.flushNow(did)
  else syncHooks?.scheduleFlush(did)
}

/** Dismiss the migration, removal or too-large note's line under the setting. */
export function dismissAppearanceNote(did: string) {
  const copy = load().device.accounts[did]
  if (!copy || (!copy.noted && !copy.removalLine && !copy.tooLargeLine)) {
    return
  }
  updateAccountCopy(did, c => ({
    ...c,
    noted: false,
    removalLine: false,
    tooLargeLine: false,
  }))
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

/**
 * For the stock Appearance screen: saves a theme setting the user just
 * picked to the current account (`saveThemePref`).
 */
export function useSaveThemePref() {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  return <K extends ThemePrefField>(field: K, value: ThemePrefs[K]) =>
    saveThemePref(did, field, value)
}

/** Film grain over the backdrop (change list 2, item 6). Device only. */
export function setGrain(on: boolean) {
  const device = load().device
  if (device.grain === on) return
  setDeviceValue({...device, grain: on})
}

/**
 * Southern-hemisphere months for "Follow the season" (change list 3, item
 * 4). Device only.
 */
export function setSouthernHemisphere(on: boolean) {
  const device = load().device
  if (device.southern === on) return
  setDeviceValue({...device, southern: on})
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
