import type * as ReactNative from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {fireEvent, render as rtlRender} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {type CustomConfig, emptyPresetSlots} from '#/horizon/appearance/model'
import {Presets} from '#/horizon/appearance/settings/Presets'

const mockLoad = jest.fn()
const mockSave = jest.fn()
const mockClear = jest.fn()
jest.mock('#/horizon/appearance/store', () => ({
  loadPreset: (...args: unknown[]) => mockLoad(...args),
  savePreset: (...args: unknown[]) => mockSave(...args),
  clearPreset: (...args: unknown[]) => mockClear(...args),
}))
const mockToast = jest.fn()
jest.mock('#/components/Toast', () => ({
  show: (...args: unknown[]) => mockToast(...args),
}))
jest.mock('#/lib/haptics', () => ({
  useHaptics: () => ({tap: () => {}, longPress: () => {}, confirm: () => {}}),
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes
      .light,
  web: (value: unknown) => value,
}))
jest.mock('#/components/Typography', () => ({
  Text: jest.requireActual<typeof ReactNative>('react-native').Text,
}))

i18n.loadAndActivate({locale: 'en', messages: {}})

function render(ui: React.ReactElement) {
  const view = rtlRender(<I18nProvider i18n={i18n}>{ui}</I18nProvider>)
  return {
    ...view,
    rerender: (next: React.ReactElement) =>
      view.rerender(<I18nProvider i18n={i18n}>{next}</I18nProvider>),
  }
}

const DID = 'did:plc:alice'
const CURRENT: CustomConfig = {mode: 'solid', a: '#123456', b: '#123456'}

function slots() {
  const presets = emptyPresetSlots()
  presets[0] = {
    custom: {mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'},
    savedAt: '2026-10-19T00:00:00.000Z',
  }
  presets[3] = {
    name: 'Sunrise',
    custom: {mode: 'solid', a: '#FF0000', b: '#FF0000'},
    savedAt: '2026-10-19T00:00:00.000Z',
  }
  return presets
}

beforeEach(() => {
  mockLoad.mockClear()
  mockSave.mockClear()
  mockClear.mockClear()
  mockToast.mockClear()
})

describe('Presets (T14)', () => {
  it('labels: Preset N, a name, Empty N; a clear chip per filled slot', () => {
    const {getByText, queryByText} = render(
      <Presets did={DID} presets={slots()} current={CURRENT} canSave />,
    )
    expect(getByText('Preset 1')).toBeTruthy()
    expect(getByText('Sunrise')).toBeTruthy()
    expect(getByText('Empty 2')).toBeTruthy()
    expect(getByText('Empty 10')).toBeTruthy()
    expect(getByText('Hold to clear 1')).toBeTruthy()
    expect(getByText('Hold to clear 4')).toBeTruthy()
    expect(queryByText('Hold to clear 2')).toBeNull()
  })

  it('tap loads a filled slot and is a no-op on an empty one', () => {
    const {getByText} = render(
      <Presets did={DID} presets={slots()} current={CURRENT} canSave />,
    )
    fireEvent.press(getByText('Preset 1'))
    expect(mockLoad).toHaveBeenCalledWith(DID, 1)
    fireEvent.press(getByText('Empty 2'))
    expect(mockLoad).toHaveBeenCalledTimes(1)
  })

  it("long-press saves the editor's colours, unless a hex is invalid", () => {
    const {getByText, rerender} = render(
      <Presets did={DID} presets={slots()} current={CURRENT} canSave />,
    )
    fireEvent(getByText('Empty 2'), 'longPress')
    expect(mockSave).toHaveBeenCalledWith(DID, 2, CURRENT)
    expect(mockToast).toHaveBeenCalledTimes(1)
    rerender(
      <Presets did={DID} presets={slots()} current={CURRENT} canSave={false} />,
    )
    fireEvent(getByText('Empty 3'), 'longPress')
    expect(mockSave).toHaveBeenCalledTimes(1)
  })

  it('hold to clear: long-press clears, a tap does not', () => {
    const {getByText} = render(
      <Presets did={DID} presets={slots()} current={CURRENT} canSave />,
    )
    fireEvent.press(getByText('Hold to clear 4'))
    expect(mockClear).not.toHaveBeenCalled()
    fireEvent(getByText('Hold to clear 4'), 'longPress')
    expect(mockClear).toHaveBeenCalledWith(DID, 4)
  })

  it('every labelled chip has a hint', () => {
    const {getAllByRole} = render(
      <Presets did={DID} presets={slots()} current={CURRENT} canSave />,
    )
    for (const button of getAllByRole('button')) {
      expect(button.props.accessibilityLabel).toBeTruthy()
      expect(button.props.accessibilityHint).toBeTruthy()
    }
  })
})
