import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {render} from '@testing-library/react-native'

import {
  type AccountCopy,
  defaultDeviceValue,
  type DeviceAppearanceV1,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {type Appearance, DEFAULT_APPEARANCE} from '#/horizon/appearance/model'
import * as store from '#/horizon/appearance/store'
import {
  fontSizeOfScale,
  scaleOfFontSize,
  themeChanges,
} from '#/horizon/appearance/theme-prefs'
import {ThemePrefsSync} from '#/horizon/appearance/ThemePrefsSync'

jest.mock('#/horizon/switches', () => ({
  APPEARANCE_SYNC: true,
  BACKDROPS: true,
}))

let mockDid: string | undefined
jest.mock('#/state/session', () => ({
  useSession: () => ({
    currentAccount: mockDid ? {did: mockDid} : undefined,
  }),
}))

let mockJson: string | undefined
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => mockJson,
  writeDeviceJson: (json: string) => {
    mockJson = json
  },
  subscribeDeviceJson: () => () => {},
}))

const mockDevice = {
  colorMode: 'light' as 'system' | 'light' | 'dark',
  darkTheme: 'dim' as 'dim' | 'dark' | undefined,
  family: 'theme' as 'system' | 'theme',
  scale: '0' as '-2' | '-1' | '0' | '1' | '2',
}
const mockSetColorMode = jest.fn()
const mockSetDarkTheme = jest.fn()
const mockSetFontFamily = jest.fn()
const mockSetFontScale = jest.fn()
jest.mock('#/state/shell', () => ({
  useThemePrefs: () => ({
    colorMode: mockDevice.colorMode,
    darkTheme: mockDevice.darkTheme,
  }),
  useSetThemePrefs: () => ({
    setColorMode: mockSetColorMode,
    setDarkTheme: mockSetDarkTheme,
  }),
}))
const mockFonts = {
  get family() {
    return mockDevice.family
  },
  get scale() {
    return mockDevice.scale
  },
  setFontFamily: mockSetFontFamily,
  setFontScale: mockSetFontScale,
}
jest.mock('#/alf', () => ({
  useAlf: () => ({fonts: mockFonts}),
}))

const A = 'did:plc:alice'
const B = 'did:plc:bob'

function copy(record: Appearance | null): AccountCopy {
  return {
    record,
    raw: record ? {} : null,
    cid: record ? 'c' : null,
    syncedAt: 1,
    pending: null,
    blocked: false,
  }
}

function seed(value: Partial<DeviceAppearanceV1>) {
  mockJson = serializeDeviceValue({...defaultDeviceValue(), ...value})
  store.resetAppearanceStoreForTests()
}

const scheduled: string[] = []

beforeEach(() => {
  mockDid = undefined
  mockJson = undefined
  mockDevice.colorMode = 'light'
  mockDevice.darkTheme = 'dim'
  mockDevice.family = 'theme'
  mockDevice.scale = '0'
  mockSetColorMode.mockClear()
  mockSetDarkTheme.mockClear()
  mockSetFontFamily.mockClear()
  mockSetFontScale.mockClear()
  scheduled.length = 0
  store.resetAppearanceStoreForTests()
  store.registerAppearanceSync({
    scheduleFlush: did => scheduled.push(did),
    cancelAll: () => {},
  })
})

describe('themeChanges (change list 2, item 11)', () => {
  const device = {
    colorMode: 'light' as const,
    darkTheme: undefined,
    font: 'theme' as const,
    fontScale: '0' as const,
  }

  it('nothing for an account with nothing saved', () => {
    expect(themeChanges({}, device)).toEqual({})
  })

  it('only the saved values that differ', () => {
    expect(
      themeChanges(
        {
          colorMode: 'dark',
          darkTheme: 'dim',
          font: 'theme',
          fontSize: 'larger',
        },
        device,
      ),
    ).toEqual({colorMode: 'dark', fontScale: '1'})
    // The stock dark theme reads as dim when unset.
    expect(themeChanges({darkTheme: 'dark'}, device)).toEqual({
      darkTheme: 'dark',
    })
  })

  it('maps the font size both ways', () => {
    expect(fontSizeOfScale('-2')).toBe('smaller')
    expect(fontSizeOfScale('-1')).toBe('smaller')
    expect(fontSizeOfScale('0')).toBe('default')
    expect(fontSizeOfScale('2')).toBe('larger')
    expect(scaleOfFontSize('smaller')).toBe('-1')
    expect(scaleOfFontSize('default')).toBe('0')
    expect(scaleOfFontSize('larger')).toBe('1')
  })
})

describe('saving a theme setting', () => {
  it('signed in: a pending edit and a write, never the device value', () => {
    store.saveThemePref(A, 'colorMode', 'dark')
    const device = store.getAppearanceState().device
    expect(device.accounts[A].pending).toMatchObject({
      fields: ['colorMode'],
      appearance: {colorMode: 'dark'},
    })
    expect('colorMode' in device.device).toBe(false)
    expect(scheduled).toEqual([A])
    // A later backdrop edit keeps the setting in the account's edit.
    store.selectBackdrop(A, 'pride.ace')
    const after = store.getAppearanceState().device
    expect(after.accounts[A].pending!.fields).toEqual(['colorMode', 'backdrop'])
    expect(after.accounts[A].pending!.appearance.colorMode).toBe('dark')
    expect('colorMode' in after.device).toBe(false)
  })

  it('signed out or opted out: nothing is saved', () => {
    store.saveThemePref(undefined, 'colorMode', 'dark')
    expect(store.getAppearanceState().device.accounts).toEqual({})
    store.setOptOut(true)
    store.saveThemePref(A, 'font', 'system')
    expect(store.getAppearanceState().device.accounts[A]).toBeUndefined()
    expect(scheduled).toEqual([])
  })

  it('the account values: pending over the record, none when opted out', () => {
    seed({
      accounts: {
        [A]: {
          ...copy({...DEFAULT_APPEARANCE, colorMode: 'light', font: 'system'}),
          pending: {
            fields: ['colorMode'],
            appearance: {...DEFAULT_APPEARANCE, colorMode: 'dark'},
            seq: 1,
          },
        },
        [B]: copy(DEFAULT_APPEARANCE),
      },
    })
    const state = store.getAppearanceState()
    expect(store.accountThemePrefs(state, A)).toEqual({colorMode: 'dark'})
    expect(store.accountThemePrefs(state, B)).toEqual({})
    expect(store.accountThemePrefs(state, undefined)).toEqual({})
    expect(
      store.accountThemePrefs(
        {...state, device: {...state.device, optOut: true}},
        A,
      ),
    ).toEqual({})
  })
})

describe('ThemePrefsSync: on account switch', () => {
  beforeEach(() => {
    seed({
      accounts: {
        [A]: copy({
          ...DEFAULT_APPEARANCE,
          colorMode: 'dark',
          darkTheme: 'dark',
          font: 'system',
          fontSize: 'larger',
        }),
        [B]: copy({...DEFAULT_APPEARANCE, backdrop: 'pride.trans'}),
      },
    })
  })

  it('applies the account’s saved values through the stock setters', () => {
    mockDid = A
    render(<ThemePrefsSync />)
    expect(mockSetColorMode).toHaveBeenCalledWith('dark')
    expect(mockSetDarkTheme).toHaveBeenCalledWith('dark')
    expect(mockSetFontFamily).toHaveBeenCalledWith('system')
    expect(mockSetFontScale).toHaveBeenCalledWith('1')
  })

  it('an account with nothing saved leaves the device as it is', () => {
    mockDevice.colorMode = 'dark'
    mockDid = B
    // The tree is keyed on the account: a switch mounts the host again.
    render(<ThemePrefsSync />)
    expect(mockSetColorMode).not.toHaveBeenCalled()
    expect(mockSetDarkTheme).not.toHaveBeenCalled()
    expect(mockSetFontFamily).not.toHaveBeenCalled()
    expect(mockSetFontScale).not.toHaveBeenCalled()
  })

  it('values the device already has are not set again', () => {
    mockDevice.colorMode = 'dark'
    mockDevice.darkTheme = 'dark'
    mockDevice.family = 'system'
    mockDevice.scale = '1'
    mockDid = A
    render(<ThemePrefsSync />)
    expect(mockSetColorMode).not.toHaveBeenCalled()
    expect(mockSetFontScale).not.toHaveBeenCalled()
  })

  it('signed out or opted out: nothing is applied', () => {
    render(<ThemePrefsSync />).unmount()
    store.setOptOut(true)
    mockDid = A
    render(<ThemePrefsSync />)
    expect(mockSetColorMode).not.toHaveBeenCalled()
    expect(mockSetFontFamily).not.toHaveBeenCalled()
  })
})
